import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import {
  buildSummaryTree,
  buildSummaryTreeWorkbook,
  summaryTreeRemainder,
  summaryTreeSnapshotSchema,
  SUMMARY_TREE_MAX_NODES,
  type ISummaryTreeLeaf,
  type ISummaryTreeNode,
  type ISummaryTreeSnapshot,
} from './payroll-summary-tree-excel.service.js';

/**
 * «Свод» в виде ведомости 1С: дерево объект → категория → отдел → сотрудник собирает сервер из листьев, узел равен сумме
 * детей, «Выплачено» всего = рабочие + ИТР (с офисом) на каждом уровне. И регресс: <sheetPr> без pageSetUpPr.
 */

const leaf = (patch: Partial<ISummaryTreeLeaf>): ISummaryTreeLeaf => ({
  object_key: 'obj-1',
  object_name: 'ЖК Марк (лот 33)',
  category: 'itr',
  department: 'ЛИНИЯ',
  employee_id: 1,
  full_name: 'Тудаков Игорь Дмитриевич',
  accrued: '303333.00',
  deducted: null,
  paid_out: '40375.00',
  not_counted: null,
  ...patch,
});

const LEAVES: ISummaryTreeLeaf[] = [
  leaf({}),
  leaf({ employee_id: 2, full_name: 'Кривов Алексей Сергеевич', accrued: '400000.00', deducted: '45000.00', paid_out: '99875.00' }),
  leaf({ employee_id: 3, full_name: 'Барабаш Виктор Васильевич', department: 'Геодезическая служба', accrued: '178402.69', paid_out: '43993.78' }),
  leaf({ employee_id: 4, full_name: 'Рахимов', category: 'worker', department: 'бр.Хакимов', accrued: '90000.10', paid_out: '30000.05' }),
  // Только выплата (нет начислений) — остаток отрицательный.
  leaf({ employee_id: 5, full_name: 'Офисов', category: 'office', department: null, accrued: null, paid_out: '53051.98', not_counted: 'нет условий оплаты' }),
  leaf({ object_key: 'unknown', object_name: 'Не определён', employee_id: 6, full_name: 'Иванов', accrued: '1000.00', paid_out: null }),
];

const snapshot = (patch: Partial<ISummaryTreeSnapshot> = {}): ISummaryTreeSnapshot => ({
  file_name: 'Свод_октябрь_2026.xlsx',
  title: 'Сводная ведомость по объектам (все отделы) за период с 01.10.2026 по 31.10.2026',
  subtitle: 'Категория: Все. Дата выгрузки: 12.11.2026',
  split_paid: true,
  leaves: LEAVES,
  ...patch,
});

const walk = (nodes: ReadonlyArray<ISummaryTreeNode>): ISummaryTreeNode[] => nodes.flatMap(node => [node, ...walk(node.children)]);

describe('buildSummaryTree', () => {
  const tree = buildSummaryTree(LEAVES);

  it('порядок объектов — как пришли; категории ИТР → Офис → Рабочие; отделы и ФИО по алфавиту; нумерация как в 1С', () => {
    expect(walk(tree).map(node => [node.level, node.number, node.name])).toEqual([
      [0, '1', 'ЖК Марк (лот 33)'],
      [1, '1.1', 'ИТР'],
      [2, '1.1.1', 'Геодезическая служба'],
      [3, '1', 'Барабаш Виктор Васильевич'],
      [2, '1.1.2', 'ЛИНИЯ'],
      [3, '1', 'Кривов Алексей Сергеевич'],
      [3, '2', 'Тудаков Игорь Дмитриевич'],
      [1, '1.2', 'Офис'],
      [2, '1.2.1', 'Без отдела'],
      [3, '1', 'Офисов'],
      [1, '1.3', 'Рабочие'],
      [2, '1.3.1', 'бр.Хакимов'],
      [3, '1', 'Рахимов'],
      [0, '2', 'Не определён'],
      [1, '2.1', 'ИТР'],
      [2, '2.1.1', 'ЛИНИЯ'],
      [3, '1', 'Иванов'],
    ]);
  });

  it('узел = сумма детей; «Выплачено» всего = рабочие + ИТР на каждом уровне', () => {
    for (const node of walk(tree)) {
      if (node.children.length > 0) {
        const childSum = (key: 'accrued' | 'deducted' | 'paid') => node.children.reduce((sum, child) => sum + (child.sums[key] ?? 0), 0);
        expect(node.sums.accrued ?? 0).toBe(childSum('accrued'));
        expect(node.sums.deducted ?? 0).toBe(childSum('deducted'));
        expect(node.sums.paid ?? 0).toBe(childSum('paid'));
      }
      expect(node.sums.paid ?? 0).toBe((node.sums.paidWorker ?? 0) + (node.sums.paidItr ?? 0));
    }
    expect(tree[0].sums).toEqual({
      accrued: 30333300 + 40000000 + 17840269 + 9000010,
      deducted: 4500000,
      paid: 4037500 + 9987500 + 4399378 + 3000005 + 5305198,
      paidWorker: 3000005,
      paidItr: 4037500 + 9987500 + 4399378 + 5305198,
    });
  });

  it('остаток = начислено − удержано − выплачено; только выплата — минус; сумм нет — null', () => {
    const office = walk(tree).find(node => node.name === 'Офисов')!;
    expect(summaryTreeRemainder(office.sums)).toBe(-5305198);
    expect(summaryTreeRemainder({ accrued: null, deducted: null, paid: null, paidWorker: null, paidItr: null })).toBeNull();
    const ivanov = walk(tree).find(node => node.name === 'Иванов')!;
    expect(ivanov.sums.paid).toBeNull();
    expect(summaryTreeRemainder(ivanov.sums)).toBe(100000);
  });

  it('«Не посчитано» группы — число сотрудников с причинами', () => {
    expect(tree[0].notCountedIds).toEqual(new Set([5]));
    expect(tree[1].notCountedIds.size).toBe(0);
  });
});

describe('summaryTreeSnapshotSchema', () => {
  it('сумма с тремя знаками — 400, а не округление', () => {
    const result = summaryTreeSnapshotSchema.safeParse(snapshot({ leaves: [leaf({ accrued: '1.005' })] }));
    expect(result.success).toBe(false);
  });

  it('лимит — по всем строкам листа (объекты + категории + отделы + сотрудники), не по листьям', () => {
    // Каждый лист — свой объект: 4 строки листа на лист.
    const leaves = Array.from({ length: Math.ceil(SUMMARY_TREE_MAX_NODES / 4) + 1 }, (_, index) => leaf({
      object_key: `obj-${index}`, object_name: `Объект ${index}`, employee_id: index + 1,
    }));
    const result = summaryTreeSnapshotSchema.safeParse(snapshot({ leaves }));
    expect(result.success).toBe(false);
    expect(result.error?.errors[0]?.message).toBe('Слишком много строк для выгрузки');
  });

  it('paid_out без поля (старый бэкенд «Свода») — допустимо', () => {
    const { paid_out: _omitted, ...withoutPaid } = leaf({});
    expect(summaryTreeSnapshotSchema.safeParse(snapshot({ leaves: [withoutPaid] })).success).toBe(true);
  });
});

describe('buildSummaryTreeWorkbook', () => {
  const read = async (input: ISummaryTreeSnapshot) => {
    const buffer = Buffer.from(await buildSummaryTreeWorkbook(input).xlsx.writeBuffer());
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return { xml, ws: workbook.worksheets[0] };
  };

  it('шапка в две строки как в 1С, группировка 1/2/3, «Итого» внизу; <sheetPr> только с outlinePr', async () => {
    const { xml, ws } = await read(snapshot());

    expect(xml).toMatch(/<sheetPr><outlinePr summaryBelow="0" summaryRight="0"\/><\/sheetPr>/);
    expect(ws.getRow(3).values).toEqual([undefined, '№ П/П', 'Объект выполнения / Отдел', 'Начислено', 'Удержано',
      'Выплачено', 'Выплачено', 'Выплачено', 'Остаток к выплате', 'Не посчитано']);
    expect(ws.getRow(4).values).toEqual([undefined, '№ П/П', 'Объект выполнения / Отдел', 'ИТОГО', 'ВСЕГО',
      'ВСЕГО', 'РАБОЧИЕ', 'ИТР', 'ИТОГО', 'Не посчитано']);
    expect(ws.model.merges).toEqual(expect.arrayContaining(['A3:A4', 'B3:B4', 'E3:G3', 'I3:I4']));

    const levels = [];
    for (let row = 5; row <= ws.rowCount; row += 1) levels.push(ws.getRow(row).outlineLevel ?? 0);
    expect(levels).toEqual([0, 1, 2, 3, 2, 3, 3, 1, 2, 3, 1, 2, 3, 0, 1, 2, 3, 0]);

    // ЖК Марк: начислено 303 333 + 400 000 + 178 402,69 + 90 000,10; выплачено 40 375 + 99 875 + 43 993,78 + 30 000,05 + 53 051,98.
    const object = ws.getRow(5);
    expect([3, 4, 5, 6, 7, 8, 9].map(column => object.getCell(column).value))
      .toEqual([971735.79, 45000, 267295.81, 30000.05, 237295.76, 659439.98, '1 чел.']);
    expect(object.getCell(3).numFmt).toBe('#,##0.00');
    // Офисов: только выплата — остаток со знаком минус.
    expect(ws.getRow(14).getCell(2).value).toBe('Офисов');
    expect(ws.getRow(14).getCell(8).value).toBe(-53051.98);
    expect(ws.getRow(14).getCell(9).value).toBe('нет условий оплаты');

    const total = ws.getRow(ws.rowCount);
    expect(total.getCell(2).value).toBe('Итого');
    expect(total.getCell(3).value).toBe(972735.79);
    expect(total.getCell(8).value).toBe(660439.98);
  });

  it('не «Все» — без разбивки «Выплачено»; нет «Не посчитано» — нет столбца', async () => {
    const { ws } = await read(snapshot({ split_paid: false, leaves: [leaf({})] }));
    expect(ws.getRow(4).values).toEqual([undefined, '№ П/П', 'Объект выполнения / Отдел', 'ИТОГО', 'ВСЕГО', 'ВСЕГО', 'ИТОГО']);
  });

  it('выплат не прислали (старый бэкенд) — «Выплачено» и «Остаток» пустые, а не ноль', async () => {
    const { paid_out: _omitted, ...withoutPaid } = leaf({});
    const { ws } = await read(snapshot({ split_paid: false, leaves: [withoutPaid] }));
    const employee = ws.getRow(8);
    expect(employee.getCell(2).value).toBe('Тудаков Игорь Дмитриевич');
    expect(employee.getCell(3).value).toBe(303333);
    expect(employee.getCell(5).value).toBeNull();
    expect(employee.getCell(6).value).toBeNull();
  });
});
