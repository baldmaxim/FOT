/**
 * «Свод» → xlsx в виде сводной ведомости 1С: объект → категория (ИТР / Офис / Рабочие) → отдел → сотрудник, слева
 * группировка Excel (+/−), нумерация 1 / 1.1 / 1.1.1, у сотрудников отдела — 1…n. Столбцы: Начислено, Удержано,
 * Выплачено (всего; на вкладке «Все» — ещё рабочие и ИТР, ИТР — вместе с офисом, как в 1С), Остаток к выплате.
 *
 * Клиент присылает только листья — строки «Свода» видимых на экране объектов в порядке экрана; дерево и суммы узлов
 * сервер собирает сам в копейках, поэтому узел всегда равен сумме детей. Данные — те же, что уже отданы «Сводом».
 */
import ExcelJS from 'exceljs';
import { z } from 'zod';

import { defangCsvCell } from '../../utils/file-validation.utils.js';
import { centsToAmount, toCents } from './payroll-summary.attribution.js';

/** Листьев (сотрудник × объект × категория × отдел): за месяц на проде ~1 800, за полгода — до нескольких тысяч. */
export const SUMMARY_TREE_MAX_LEAVES = 10_000;
/** Строк листа: объекты + категории + отделы + сотрудники. */
export const SUMMARY_TREE_MAX_NODES = 15_000;

const MONEY_MESSAGE = 'Сумма: не больше двух знаков после запятой';
const moneySchema = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, MONEY_MESSAGE);

const leafSchema = z.object({
  object_key: z.string().trim().min(1).max(64),
  object_name: z.string().trim().min(1).max(200),
  category: z.enum(['itr', 'office', 'worker']),
  /** null — «Без отдела». */
  department: z.string().trim().max(200).nullable(),
  employee_id: z.number().int().positive(),
  full_name: z.string().trim().min(1).max(200),
  accrued: moneySchema.nullable(),
  deducted: moneySchema.nullable(),
  /** Нет поля — бэкенд «Свода» выплат не отдал (старый): «Выплачено» и «Остаток» пустые, а не ноль. */
  paid_out: moneySchema.nullable().optional(),
  /** Причины «Не посчитано» подписями через запятую; null — всё посчитано. */
  not_counted: z.string().trim().max(500).nullable(),
});

export type ISummaryTreeLeaf = z.infer<typeof leafSchema>;

const nodeCount = (leaves: ReadonlyArray<ISummaryTreeLeaf>): number => {
  const objects = new Set<string>();
  const categories = new Set<string>();
  const departments = new Set<string>();
  for (const leaf of leaves) {
    objects.add(leaf.object_key);
    categories.add(`${leaf.object_key}|${leaf.category}`);
    departments.add(`${leaf.object_key}|${leaf.category}|${leaf.department ?? ''}`);
  }
  return objects.size + categories.size + departments.size + leaves.length;
};

export const summaryTreeSnapshotSchema = z.object({
  file_name: z.string().trim().min(1).max(150),
  // Отдел и месяцы вразброс («за июль 2026, сентябрь 2026, …») — до нескольких сотен знаков.
  title: z.string().trim().min(1).max(500),
  subtitle: z.string().trim().max(300),
  /** Вкладка «Все»: «Выплачено» ещё и по рабочим и ИТР. */
  split_paid: z.boolean(),
  leaves: z
    .array(leafSchema)
    .min(1, 'Нет строк для выгрузки')
    .max(SUMMARY_TREE_MAX_LEAVES, 'Слишком много строк для выгрузки'),
}).superRefine((value, ctx) => {
  if (nodeCount(value.leaves) > SUMMARY_TREE_MAX_NODES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Слишком много строк для выгрузки' });
  }
});

export type ISummaryTreeSnapshot = z.infer<typeof summaryTreeSnapshotSchema>;

const CATEGORY_ORDER = ['itr', 'office', 'worker'] as const;
const CATEGORY_LABELS: Record<ISummaryTreeLeaf['category'], string> = { itr: 'ИТР', office: 'Офис', worker: 'Рабочие' };
const NO_DEPARTMENT_LABEL = 'Без отдела';
const TOTAL_LABEL = 'Итого';

/** Суммы узла в копейках; null — ни одной суммы. */
export interface ISummaryTreeSums {
  accrued: number | null;
  deducted: number | null;
  paid: number | null;
  /** «Выплачено» рабочих и ИТР (вместе с офисом). */
  paidWorker: number | null;
  paidItr: number | null;
}

export interface ISummaryTreeNode {
  /** 0 — объект, 1 — категория, 2 — отдел, 3 — сотрудник. */
  level: 0 | 1 | 2 | 3;
  /** «1», «1.2», «1.2.3»; у сотрудника — номер в отделе. */
  number: string;
  name: string;
  sums: ISummaryTreeSums;
  /** Не посчитано: у сотрудника — причины, у группы — сотрудники с причинами. */
  notCountedIds: Set<number>;
  notCountedText: string | null;
  children: ISummaryTreeNode[];
}

const EMPTY_SUMS: ISummaryTreeSums = { accrued: null, deducted: null, paid: null, paidWorker: null, paidItr: null };

const addNullable = (left: number | null, right: number | null): number | null => (
  right === null ? left : (left ?? 0) + right
);

const addSums = (target: ISummaryTreeSums, source: ISummaryTreeSums): ISummaryTreeSums => ({
  accrued: addNullable(target.accrued, source.accrued),
  deducted: addNullable(target.deducted, source.deducted),
  paid: addNullable(target.paid, source.paid),
  paidWorker: addNullable(target.paidWorker, source.paidWorker),
  paidItr: addNullable(target.paidItr, source.paidItr),
});

const centsOrNull = (amount: string | null | undefined): number | null => (amount == null ? null : toCents(amount));

const leafSums = (leaf: ISummaryTreeLeaf): ISummaryTreeSums => {
  const paid = centsOrNull(leaf.paid_out);
  return {
    accrued: centsOrNull(leaf.accrued),
    deducted: centsOrNull(leaf.deducted),
    paid,
    paidWorker: leaf.category === 'worker' ? paid : null,
    paidItr: leaf.category === 'worker' ? null : paid,
  };
};

/** Остаток к выплате = Начислено − Удержано − Выплачено; сумм нет совсем — null. */
export const summaryTreeRemainder = (sums: ISummaryTreeSums): number | null => (
  sums.accrued === null && sums.deducted === null && sums.paid === null
    ? null
    : (sums.accrued ?? 0) - (sums.deducted ?? 0) - (sums.paid ?? 0)
);

const byName = (left: string, right: string): number => left.localeCompare(right, 'ru');

/** Узел-группа из детей: суммы и «Не посчитано» — их сложение. */
const groupNode = (
  level: 0 | 1 | 2,
  number: string,
  name: string,
  children: ISummaryTreeNode[],
): ISummaryTreeNode => ({
  level,
  number,
  name,
  sums: children.reduce((sum, child) => addSums(sum, child.sums), EMPTY_SUMS),
  notCountedIds: new Set(children.flatMap(child => [...child.notCountedIds])),
  notCountedText: null,
  children,
});

/** Объекты — в порядке листьев (порядок экрана), категории — ИТР → Офис → Рабочие, отделы и сотрудники — по алфавиту. */
export const buildSummaryTree = (leaves: ReadonlyArray<ISummaryTreeLeaf>): ISummaryTreeNode[] => {
  const objects = new Map<string, { name: string; leaves: ISummaryTreeLeaf[] }>();
  for (const leaf of leaves) {
    const object = objects.get(leaf.object_key);
    if (object) object.leaves.push(leaf);
    else objects.set(leaf.object_key, { name: leaf.object_name, leaves: [leaf] });
  }

  return [...objects.values()].map((object, objectIndex) => {
    const objectNumber = String(objectIndex + 1);
    const categories = CATEGORY_ORDER
      .map(category => ({ category, leaves: object.leaves.filter(leaf => leaf.category === category) }))
      .filter(group => group.leaves.length > 0)
      .map((group, categoryIndex) => {
        const categoryNumber = `${objectNumber}.${categoryIndex + 1}`;
        const departments = new Map<string, ISummaryTreeLeaf[]>();
        for (const leaf of group.leaves) {
          const name = leaf.department ?? NO_DEPARTMENT_LABEL;
          const list = departments.get(name);
          if (list) list.push(leaf);
          else departments.set(name, [leaf]);
        }
        const departmentNodes = [...departments.entries()]
          .sort(([left], [right]) => byName(left, right))
          .map(([name, departmentLeaves], departmentIndex) => {
            const employees = [...departmentLeaves]
              .sort((left, right) => byName(left.full_name, right.full_name) || left.employee_id - right.employee_id)
              .map((leaf, employeeIndex): ISummaryTreeNode => ({
                level: 3,
                number: String(employeeIndex + 1),
                name: leaf.full_name,
                sums: leafSums(leaf),
                notCountedIds: leaf.not_counted ? new Set([leaf.employee_id]) : new Set(),
                notCountedText: leaf.not_counted,
                children: [],
              }));
            return groupNode(2, `${categoryNumber}.${departmentIndex + 1}`, name, employees);
          });
        return groupNode(1, categoryNumber, CATEGORY_LABELS[group.category], departmentNodes);
      });
    return groupNode(0, objectNumber, object.name, categories);
  });
};

/** Узлы по порядку листа: родитель над детьми. */
const flatten = (nodes: ReadonlyArray<ISummaryTreeNode>): ISummaryTreeNode[] => (
  nodes.flatMap(node => [node, ...flatten(node.children)])
);

const TITLE_FILL = 'FFDDEBF7';
const HEADER_FILL = 'FFDDEBF7';
const OBJECT_FILL = 'FFDDEBF7';
const EMPLOYEE_FILL = 'FFFFF2CC';
const TOTAL_FILL = 'FFF2F2F2';
const MONEY_FORMAT = '#,##0.00';
const THIN = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

interface ISheetColumn {
  /** Подпись над группой столбцов (объединяется по соседним одинаковым) и под ней. */
  top: string;
  bottom: string | null;
  width: number;
  money: boolean;
  value: (node: ISummaryTreeNode) => string | number | null;
}

const moneyValue = (cents: number | null): number | null => (cents === null ? null : Number(centsToAmount(cents)));

const sheetColumns = (splitPaid: boolean, paidKnown: boolean, withNotCounted: boolean): ISheetColumn[] => {
  // Выплат не знаем (старый бэкенд «Свода») — пусто, а не «ничего не выплачено».
  const paid = (cents: number | null): number | null => (paidKnown ? moneyValue(cents) : null);
  return [
    { top: '№ П/П', bottom: null, width: 10, money: false, value: node => node.number },
    { top: 'Объект выполнения / Отдел', bottom: null, width: 48, money: false, value: node => node.name },
    { top: 'Начислено', bottom: 'ИТОГО', width: 18, money: true, value: node => moneyValue(node.sums.accrued) },
    { top: 'Удержано', bottom: 'ВСЕГО', width: 16, money: true, value: node => moneyValue(node.sums.deducted) },
    { top: 'Выплачено', bottom: 'ВСЕГО', width: 18, money: true, value: node => paid(node.sums.paid) },
    ...(splitPaid ? [
      { top: 'Выплачено', bottom: 'РАБОЧИЕ', width: 16, money: true, value: (node: ISummaryTreeNode) => paid(node.sums.paidWorker) },
      { top: 'Выплачено', bottom: 'ИТР', width: 16, money: true, value: (node: ISummaryTreeNode) => paid(node.sums.paidItr) },
    ] : []),
    {
      top: 'Остаток к выплате', bottom: 'ИТОГО', width: 18, money: true,
      value: node => (paidKnown ? moneyValue(summaryTreeRemainder(node.sums)) : null),
    },
    ...(withNotCounted ? [{
      top: 'Не посчитано', bottom: null, width: 40, money: false,
      value: (node: ISummaryTreeNode) => (node.level === 3 ? node.notCountedText : (node.notCountedIds.size > 0 ? `${node.notCountedIds.size} чел.` : null)),
    }] : []),
  ];
};

/** Строки шапки: заголовок, подзаголовок, две строки подписей столбцов. */
const HEADER_ROWS = 4;

/** Книга «Свода» в виде ведомости 1С. */
export const buildSummaryTreeWorkbook = (snapshot: ISummaryTreeSnapshot): ExcelJS.Workbook => {
  const tree = buildSummaryTree(snapshot.leaves);
  const paidKnown = snapshot.leaves.every(leaf => leaf.paid_out !== undefined);
  const withNotCounted = snapshot.leaves.some(leaf => leaf.not_counted);
  const columns = sheetColumns(snapshot.split_paid, paidKnown, withNotCounted);
  const lastColumn = columns.length;

  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Свод', {
    // fitToPage здесь нельзя: вместе с группировкой строк ExcelJS 4.4.0 пишет <sheetPr> в порядке, который Excel
    // считает повреждением файла.
    pageSetup: { orientation: 'landscape', paperSize: 9 },
  });
  ws.columns = columns.map(column => ({ width: column.width }));
  // summaryBelow: false — строка группы над её содержимым, +/− сверху, как в 1С.
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  ws.properties.outlineLevelRow = 3;
  // Без dyDescent ExcelJS 4.4.0 теряет свойства строк при записи.
  ws.properties.dyDescent = 0.25;
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: HEADER_ROWS }];

  const titleRow = ws.addRow([defangCsvCell(snapshot.title)]);
  titleRow.font = { bold: true, size: 13 };
  titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_FILL } };
  ws.mergeCells(titleRow.number, 1, titleRow.number, lastColumn);
  const subtitleRow = ws.addRow([defangCsvCell(snapshot.subtitle)]);
  subtitleRow.font = { italic: true, size: 10, color: { argb: 'FF595959' } };
  ws.mergeCells(subtitleRow.number, 1, subtitleRow.number, lastColumn);

  const topRow = ws.addRow(columns.map(column => column.top));
  const bottomRow = ws.addRow(columns.map(column => column.bottom ?? column.top));
  for (const row of [topRow, bottomRow]) {
    row.eachCell(cell => {
      cell.font = { bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
      cell.border = BORDER;
    });
  }
  // Без нижней подписи — одна ячейка на две строки; одинаковые соседние верхние («Выплачено») — одна над ними.
  columns.forEach((column, index) => {
    if (column.bottom === null) ws.mergeCells(topRow.number, index + 1, bottomRow.number, index + 1);
  });
  for (let start = 0; start < columns.length;) {
    let end = start;
    while (end + 1 < columns.length && columns[end + 1].top === columns[start].top && columns[end + 1].bottom !== null) end += 1;
    if (end > start && columns[start].bottom !== null) ws.mergeCells(topRow.number, start + 1, topRow.number, end + 1);
    start = end + 1;
  }

  const writeRow = (node: ISummaryTreeNode, values: Array<string | number | null>): ExcelJS.Row => {
    const row = ws.addRow(values.map((value, index) => (
      typeof value === 'string' && !columns[index].money ? defangCsvCell(value) : value
    )));
    columns.forEach((column, index) => {
      const cell = row.getCell(index + 1);
      cell.border = BORDER;
      if (column.money) cell.numFmt = MONEY_FORMAT;
    });
    row.getCell(2).alignment = { indent: node.level, vertical: 'middle', wrapText: true };
    return row;
  };

  for (const node of flatten(tree)) {
    const row = writeRow(node, columns.map(column => column.value(node)));
    row.outlineLevel = node.level;
    if (node.level === 0) {
      row.font = { bold: true, size: 11 };
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: OBJECT_FILL } };
      });
    } else if (node.level === 1) {
      row.font = { bold: true, italic: true };
    } else if (node.level === 3) {
      row.font = { italic: true };
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EMPLOYEE_FILL } };
      });
    }
  }

  const total = groupNode(0, '', TOTAL_LABEL, tree);
  const totalRow = writeRow(total, columns.map((column, index) => (index === 0 ? null : column.value(total))));
  totalRow.font = { bold: true };
  totalRow.eachCell({ includeEmpty: true }, cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
  });

  return workbook;
};
