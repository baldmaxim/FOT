import { describe, expect, it } from 'vitest';
import {
  buildVersionObjectBreakdown,
  computeObjectsContentHash,
  distributeHoursByWeights,
  CURRENT_ACTIVITY_KEY,
  type IBuildObjectBreakdownInput,
  type IEmployeeDaysSource,
} from './timesheet-object-breakdown.service.js';
import { UNKNOWN_OBJECT_KEY, type IAttendanceObjectEntry } from './timesheet-object.service.js';
import type { IObjectMeta } from './timesheet-object-breakdown.service.js';
import type { IResolvedExportMode } from './timesheet-export-mode.service.js';

const OBJ_A = '11111111-1111-1111-1111-111111111111';
const OBJ_B = '22222222-2222-2222-2222-222222222222';
const OBJ_PINNED = '33333333-3333-3333-3333-333333333333';

const meta = new Map<string, IObjectMeta>([
  [OBJ_A, { name: 'ЖК Примавера К14', address: 'Примавера, адрес' }],
  [OBJ_B, { name: 'ЖК Ситибэй', address: 'Ситибэй, адрес' }],
  [OBJ_PINNED, { name: 'ЖК Дом 56', address: 'Дом 56, адрес' }],
]);

const objectEntry = (
  employeeId: number,
  workDate: string,
  objectId: string | null,
  hours: number,
  objectName?: string,
): IAttendanceObjectEntry => ({
  adjustment_id: null,
  employee_id: employeeId,
  work_date: workDate,
  object_key: objectId ?? UNKNOWN_OBJECT_KEY,
  object_id: objectId,
  object_name: objectName ?? (objectId ? meta.get(objectId)!.name : 'Не определён'),
  hours_worked: hours,
  display_hours_worked: hours,
  base_hours_worked: hours,
  is_correction: false,
});

const employeeDays = (
  employeeId: number,
  days: Record<string, number>,
  fullName = `Сотрудник ${employeeId}`,
): IEmployeeDaysSource => ({
  employee_id: employeeId,
  full_name: fullName,
  days: Object.fromEntries(Object.entries(days).map(([date, hours]) => [date, { hours }])),
});

const skudMode: IResolvedExportMode = { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' };

const build = (over: Partial<IBuildObjectBreakdownInput> = {}) => buildVersionObjectBreakdown({
  employees: [],
  objectEntries: [],
  ownsDay: () => true,
  modeByEmployee: new Map(),
  objectMetaById: meta,
  ...over,
});

describe('distributeHoursByWeights', () => {
  it('раздаёт ровно целевую сумму, без потерь на округлении', () => {
    const shares = distributeHoursByWeights(8, [1, 1, 1]);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(8);
  });

  it('нулевой вес не получает часов', () => {
    expect(distributeHoursByWeights(8, [3, 0])).toEqual([8, 0]);
  });

  it('нулевая сумма весов — нули, а не деление на ноль', () => {
    expect(distributeHoursByWeights(8, [0, 0])).toEqual([0, 0]);
  });
});

describe('buildVersionObjectBreakdown', () => {
  it('два объекта в одном дне: сумма по объектам равна часам дня', () => {
    const result = build({
      employees: [employeeDays(1, { '2026-08-03': 8.5 })],
      objectEntries: [
        objectEntry(1, '2026-08-03', OBJ_A, 5),
        objectEntry(1, '2026-08-03', OBJ_B, 3.5),
      ],
      modeByEmployee: new Map([[1, skudMode]]),
    });

    const employee = result.payload.employees[0]!;
    expect(employee.objects).toHaveLength(2);
    const sum = employee.objects.reduce((acc, row) => acc + (row.days['2026-08-03'] ?? 0), 0);
    expect(sum).toBe(8.5);
    expect(employee.total_hours).toBe(8.5);
  });

  it('нормирует к часам версии, а не к сумме объектных интервалов', () => {
    // Классический случай: объектные интервалы — сырое присутствие без обеда (9 ч),
    // а в табеле за день 8. В 1С должна уйти восьмёрка, разложенная по объектам.
    const result = build({
      employees: [employeeDays(1, { '2026-08-03': 8 })],
      objectEntries: [
        objectEntry(1, '2026-08-03', OBJ_A, 6),
        objectEntry(1, '2026-08-03', OBJ_B, 3),
      ],
      modeByEmployee: new Map([[1, skudMode]]),
    });

    const objects = result.payload.employees[0]!.objects;
    expect(objects.reduce((acc, row) => acc + row.total_hours, 0)).toBe(8);
  });

  it('несогласованный выходной: часы в табеле обнулены — объектных строк нет', () => {
    // dataMap гасит такой день через includeExportDayHours, а objectEntries остаются.
    // Наивная группировка дала бы часы там, где в табеле ноль.
    const result = build({
      employees: [employeeDays(1, { '2026-08-08': 0 })],
      objectEntries: [objectEntry(1, '2026-08-08', OBJ_A, 7)],
      modeByEmployee: new Map([[1, skudMode]]),
    });

    expect(result.payload.employees[0]!.objects).toEqual([]);
    expect(result.totalHours).toBe(0);
  });

  it('день вне владения подачей в разбивку не попадает', () => {
    const result = build({
      employees: [employeeDays(1, { '2026-08-03': 8, '2026-08-04': 8 })],
      objectEntries: [
        objectEntry(1, '2026-08-03', OBJ_A, 8),
        objectEntry(1, '2026-08-04', OBJ_B, 8),
      ],
      modeByEmployee: new Map([[1, skudMode]]),
      ownsDay: (_id, date) => date === '2026-08-03',
    });

    const objects = result.payload.employees[0]!.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]!.days).toEqual({ '2026-08-03': 8 });
  });

  it('часы есть, проходов нет — всё уходит в «Не определён», ничего не теряется', () => {
    const result = build({
      employees: [employeeDays(1, { '2026-08-03': 8 })],
      objectEntries: [],
      modeByEmployee: new Map([[1, skudMode]]),
    });

    const objects = result.payload.employees[0]!.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]!.object_key).toBe(UNKNOWN_OBJECT_KEY);
    expect(objects[0]!.object_id).toBeNull();
    expect(objects[0]!.total_hours).toBe(8);
  });

  it('режим «объект»: одна строка на закреплённый объект, даже если проходы по другому', () => {
    const result = build({
      employees: [employeeDays(1, { '2026-08-03': 8 })],
      objectEntries: [objectEntry(1, '2026-08-03', OBJ_A, 8)],
      modeByEmployee: new Map([[1, {
        mode: 'object', pinnedObjectId: OBJ_PINNED, source: 'employee_explicit',
      }]]),
    });

    const objects = result.payload.employees[0]!.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]!.object_id).toBe(OBJ_PINNED);
    expect(objects[0]!.object_address).toBe('Дом 56, адрес');
    expect(result.configErrors).toEqual([]);
  });

  it('режим «объект» без закреплённого объекта: не падает, часы в «Не определён» + config_errors', () => {
    // Excel-выгрузка тут бросает исключение. Здесь код выполняется в транзакции закрытия
    // табеля — падение остановило бы работу всем, поэтому ошибка едет данными.
    const result = build({
      employees: [employeeDays(1, { '2026-08-03': 8 })],
      modeByEmployee: new Map([[1, { mode: 'object', pinnedObjectId: null, source: 'employee_explicit' }]]),
    });

    expect(result.configErrors).toEqual([
      { employee_id: 1, code: 'PINNED_OBJECT_MISSING', message: 'Режим «объект» без закреплённого объекта' },
    ]);
    expect(result.payload.employees[0]!.objects[0]!.object_key).toBe(UNKNOWN_OBJECT_KEY);
  });

  it('режим «объект» с удалённым объектом: PINNED_OBJECT_NOT_FOUND', () => {
    const result = build({
      employees: [employeeDays(1, { '2026-08-03': 8 })],
      modeByEmployee: new Map([[1, {
        mode: 'object', pinnedObjectId: '99999999-9999-9999-9999-999999999999', source: 'employee_explicit',
      }]]),
    });

    expect(result.configErrors[0]!.code).toBe('PINNED_OBJECT_NOT_FOUND');
  });

  it('режим «текущая деятельность»: одна строка, object_id = null', () => {
    const result = build({
      employees: [employeeDays(1, { '2026-08-03': 8, '2026-08-04': 4 })],
      objectEntries: [objectEntry(1, '2026-08-03', OBJ_A, 8)],
      modeByEmployee: new Map([[1, { mode: 'current_activity', pinnedObjectId: null, source: 'legacy_department' }]]),
    });

    const objects = result.payload.employees[0]!.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]!.object_key).toBe(CURRENT_ACTIVITY_KEY);
    expect(objects[0]!.object_id).toBeNull();
    expect(objects[0]!.object_name).toBe('Текущая деятельность');
    expect(objects[0]!.total_hours).toBe(12);
  });

  it('персональная подача собирается так же: состав задаётся списком, отдел не нужен', () => {
    // У ЛИНИИ/ЛИНИЯ-Общестрой подачи персональные (department_id = null) — это их
    // основной путь в 1С, и разбивка обязана работать без опоры на отдел.
    const result = build({
      employees: [employeeDays(2617, { '2026-08-03': 8 })],
      objectEntries: [objectEntry(2617, '2026-08-03', OBJ_A, 8)],
      modeByEmployee: new Map([[2617, skudMode]]),
    });

    expect(result.payload.employees[0]!.objects[0]!.object_id).toBe(OBJ_A);
  });

  it('период через границу месяцев: дни обоих месяцев в одной строке объекта', () => {
    const result = build({
      employees: [employeeDays(1, { '2026-07-31': 8, '2026-08-01': 8 })],
      objectEntries: [
        objectEntry(1, '2026-07-31', OBJ_A, 8),
        objectEntry(1, '2026-08-01', OBJ_A, 8),
      ],
      modeByEmployee: new Map([[1, skudMode]]),
    });

    const objects = result.payload.employees[0]!.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]!.days).toEqual({ '2026-07-31': 8, '2026-08-01': 8 });
  });

  it('сотрудник без часов: objects пуст, но строка сохраняется', () => {
    const result = build({
      employees: [employeeDays(1, { '2026-08-03': 0 })],
      modeByEmployee: new Map([[1, skudMode]]),
    });

    expect(result.payload.employees).toHaveLength(1);
    expect(result.payload.employees[0]!.objects).toEqual([]);
  });
});

describe('computeObjectsContentHash', () => {
  const baseInput = (): IBuildObjectBreakdownInput => ({
    employees: [employeeDays(1, { '2026-08-03': 8, '2026-08-04': 8 })],
    objectEntries: [
      objectEntry(1, '2026-08-03', OBJ_A, 8),
      objectEntry(1, '2026-08-04', OBJ_B, 8),
    ],
    ownsDay: () => true,
    modeByEmployee: new Map([[1, skudMode]]),
    objectMetaById: meta,
  });

  const hashOf = (input: IBuildObjectBreakdownInput): string => {
    const built = buildVersionObjectBreakdown(input);
    return computeObjectsContentHash(built.payload, built.configErrors);
  };

  it('одинаковый вход — одинаковый хэш', () => {
    expect(hashOf(baseInput())).toBe(hashOf(baseInput()));
  });

  it('порядок объектных записей на входе на хэш не влияет', () => {
    const shuffled = baseInput();
    expect(hashOf({ ...shuffled, objectEntries: [...shuffled.objectEntries].reverse() }))
      .toBe(hashOf(baseInput()));
  });

  it('тот же общий итог, но часы переехали между объектами — хэш другой', () => {
    // Главный тест на идемпотентность: content_hash самого табеля в этом случае не
    // меняется, и без объектного хэша 1С об изменении не узнала бы.
    const moved = baseInput();
    expect(hashOf({
      ...moved,
      objectEntries: [
        objectEntry(1, '2026-08-03', OBJ_B, 8),
        objectEntry(1, '2026-08-04', OBJ_A, 8),
      ],
    })).not.toBe(hashOf(baseInput()));
  });

  it('тот же payload, но опустевший config_errors — хэш другой', () => {
    // Режим «объект» без объекта починили на «skud», а проходов у человека нет: payload
    // остаётся «Не определён», меняется только набор ошибок. Хэш только по payload не
    // заметил бы этого, и версия навсегда осталась бы с ответом 409.
    const broken: IBuildObjectBreakdownInput = {
      employees: [employeeDays(1, { '2026-08-03': 8 })],
      objectEntries: [],
      ownsDay: () => true,
      modeByEmployee: new Map([[1, { mode: 'object', pinnedObjectId: null, source: 'employee_explicit' }]]),
      objectMetaById: meta,
    };
    const fixed: IBuildObjectBreakdownInput = { ...broken, modeByEmployee: new Map([[1, skudMode]]) };

    const brokenBuilt = buildVersionObjectBreakdown(broken);
    const fixedBuilt = buildVersionObjectBreakdown(fixed);

    // payload различается только режимом строки; ошибки исчезли.
    expect(brokenBuilt.configErrors).toHaveLength(1);
    expect(fixedBuilt.configErrors).toHaveLength(0);
    expect(hashOf(broken)).not.toBe(hashOf(fixed));
  });
});
