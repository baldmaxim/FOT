import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Резолвинг режима выгрузки в «Единый файл 1С».
 *
 * Главное, что здесь закреплено, — персональные назначения объектов
 * (employee_object_assignment) в резолвинге НЕ участвуют (миграция 253). Это управление
 * доступом табельщиц; до 253 галочка, поставленная ради доступа, молча меняла человеку
 * строки в выгрузке. Проверяем это на двух уровнях: таблицы нет в SQL и решают только
 * объекты отдела. Режима отдела нет (миграция 290): SQL не читает org_departments.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));

import {
  exportModePairKey,
  listWindowPinnedEmployeeIds,
  resolveExportModes,
  resolveExportModesForPairs,
  resolveRow,
} from './timesheet-export-mode.service.js';

const row = (over: Record<string, unknown> = {}) => ({
  employee_id: 1,
  emp_mode: null,
  emp_object_id: null,
  dept_current_activity: false,
  ...over,
}) as Parameters<typeof resolveRow>[0];

beforeEach(() => {
  pgQuery.mockReset().mockResolvedValue([]);
});

describe('resolveRow — приоритет источников', () => {
  it('явный режим сотрудника выигрывает у всего остального', () => {
    const r = resolveRow(row({ emp_mode: 'skud', dept_current_activity: true }));
    expect(r).toMatchObject({ mode: 'skud', source: 'employee_explicit', pinnedObjectId: null });
  });

  it('режим «объект» тянет за собой закреплённый объект', () => {
    const r = resolveRow(row({ emp_mode: 'object', emp_object_id: 'obj-1' }));
    expect(r).toMatchObject({ mode: 'object', pinnedObjectId: 'obj-1', source: 'employee_explicit' });
  });

  it('личного режима нет, у отдела ТД-объект → current_activity', () => {
    const r = resolveRow(row({ dept_current_activity: true }));
    expect(r).toMatchObject({ mode: 'current_activity', source: 'legacy_department' });
  });

  it('ничего не задано → skud по умолчанию', () => {
    const r = resolveRow(row());
    expect(r).toMatchObject({ mode: 'skud', source: 'legacy_default' });
  });

  it('источник личного режима: skud/auto — правило рабочих; у legacy источника нет', () => {
    expect(resolveRow(row({ emp_mode: 'skud', emp_set_by: 'auto' })).setBy).toBe('auto');
    expect(resolveRow(row({ emp_mode: 'skud', emp_set_by: null })).setBy).toBeUndefined();
    expect(resolveRow(row({ emp_set_by: 'auto' })).setBy).toBeUndefined();
  });
  it('назначение из окна — только у личного режима и только true', () => {
    expect(resolveRow(row({ emp_mode: 'object', emp_object_id: 'obj-1', emp_window_pin: true })).windowPin).toBe(true);
    expect(resolveRow(row({ emp_mode: 'object', emp_object_id: 'obj-1', emp_window_pin: false }))).not.toHaveProperty('windowPin');
    expect(resolveRow(row({ dept_current_activity: true, emp_window_pin: true }))).not.toHaveProperty('windowPin');
  });
});

describe('признак назначения из окна в SQL', () => {
  it('живой режим — из employees, прошедший месяц — из строки фиксации', async () => {
    await resolveExportModes([1]);
    expect(String(pgQuery.mock.calls[0]?.[0])).toContain('e.timesheet_export_set_at IS NOT NULL');

    pgQuery.mockClear();
    await resolveExportModes([1], undefined, { month: '2026-08', now: new Date('2026-10-02T12:00:00+03:00') });
    const sql = String(pgQuery.mock.calls[0]?.[0]);
    expect(sql).toContain('CASE WHEN f.employee_id IS NOT NULL THEN (f.set_by IS NULL');
    expect(sql).toContain('AS emp_window_pin');
  });

  it('listWindowPinnedEmployeeIds — только назначенные', async () => {
    pgQuery.mockResolvedValue([
      { employee_id: 1, emp_mode: 'object', emp_object_id: 'obj-1', emp_window_pin: true, dept_current_activity: false },
      { employee_id: 2, emp_mode: 'object', emp_object_id: 'obj-1', emp_set_by: 'auto', emp_window_pin: false, dept_current_activity: false },
      { employee_id: 3, emp_mode: 'current_activity', emp_object_id: null, emp_window_pin: true, dept_current_activity: false },
    ]);
    expect([...await listWindowPinnedEmployeeIds([1, 2, 3], null)]).toEqual([1, 3]);
  });
});

describe('персональные назначения объектов не влияют на режим', () => {
  it('SQL резолвера не читает employee_object_assignment', async () => {
    await resolveExportModes([1, 2]);

    const sql = String(pgQuery.mock.calls[0]![0]);
    expect(sql).not.toContain('employee_object_assignment');
    // Объекты ОТДЕЛА остаются — на них держится поведение офисных подразделений.
    expect(sql).toContain('department_object_assignment');
  });

  it('лишние поля в строке игнорируются: решают только объекты отдела', () => {
    // Эмулируем строку «как раньше»: персональное назначение обычного объекта плюс ТД
    // у отдела. До 253 это давало skud, теперь — ТД отдела.
    const r = resolveRow(row({
      dept_current_activity: true,
      has_personal_assignment: true,
      personal_current_activity: false,
    } as Record<string, unknown>));
    expect(r).toMatchObject({ mode: 'current_activity', source: 'legacy_department' });
  });

  it('эквивалент миграции 253: явный skud даёт то же, что давала снятая legacy-ветка', () => {
    const r = resolveRow(row({ emp_mode: 'skud', dept_current_activity: true }));
    expect(r.mode).toBe('skud');
  });

  it('эквивалент миграции 253: явный current_activity даёт то же для офисных', () => {
    const r = resolveRow(row({ emp_mode: 'current_activity' }));
    expect(r.mode).toBe('current_activity');
  });
});

describe('режима отдела нет (миграция 290)', () => {
  it('SQL резолверов не читает org_departments — ни живой режим, ни за месяц', async () => {
    const month = { month: '2026-08', now: new Date('2026-09-15T12:00:00Z') };
    await resolveExportModes([1]);
    await resolveExportModes([1], undefined, month);
    await resolveExportModesForPairs([{ employee_id: 1, org_department_id: 'A' }]);
    await resolveExportModesForPairs([{ employee_id: 1, org_department_id: 'A' }], undefined, month);

    expect(pgQuery).toHaveBeenCalledTimes(4);
    for (const [sql] of pgQuery.mock.calls) expect(String(sql)).not.toContain('org_departments');
  });
});

describe('resolveExportModes — вход', () => {
  it('пустой и мусорный список не идёт в БД', async () => {
    expect((await resolveExportModes([])).size).toBe(0);
    expect((await resolveExportModes([0, -3, Number.NaN])).size).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('дубликаты схлопываются, результат — карта по employee_id', async () => {
    pgQuery.mockResolvedValue([
      { employee_id: 1, emp_mode: 'skud', emp_object_id: null, dept_current_activity: false },
    ]);

    const map = await resolveExportModes([1, 1, 1]);

    expect((pgQuery.mock.calls[0]![1] as unknown[])[0]).toEqual([1]);
    expect(map.get(1)).toMatchObject({ mode: 'skud', source: 'employee_explicit' });
  });
});

describe('resolveExportModesForPairs — legacy-режим по отделу пары', () => {
  it('SQL берёт объекты отдела ПАРЫ (unnest), а не текущий отдел сотрудника', async () => {
    await resolveExportModesForPairs([{ employee_id: 1, org_department_id: 'A' }]);
    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('unnest($1::int[], $2::uuid[])');
    expect(sql).toContain('dc.org_department_id = p.dept_id');
    expect(sql).not.toContain('= e.org_department_id');
    expect(params.slice(0, 2)).toEqual([[1], ['A']]);
  });

  it('один сотрудник в двух отделах получает legacy-режим каждого отдела', async () => {
    pgQuery.mockResolvedValue([
      { employee_id: 1, pair_dept_id: 'A', emp_mode: null, emp_object_id: null, dept_current_activity: true },
      { employee_id: 1, pair_dept_id: 'B', emp_mode: null, emp_object_id: null, dept_current_activity: false },
    ]);

    const map = await resolveExportModesForPairs([
      { employee_id: 1, org_department_id: 'A' },
      { employee_id: 1, org_department_id: 'B' },
    ]);

    expect(map.get(exportModePairKey(1, 'A'))).toMatchObject({ mode: 'current_activity', source: 'legacy_department' });
    expect(map.get(exportModePairKey(1, 'B'))).toMatchObject({ mode: 'skud', source: 'legacy_default' });
  });

  it('дубли пар схлопываются, мусорные id не идут в БД, отдел null допустим', async () => {
    expect((await resolveExportModesForPairs([{ employee_id: 0, org_department_id: 'A' }])).size).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();

    await resolveExportModesForPairs([
      { employee_id: 2, org_department_id: null },
      { employee_id: 2, org_department_id: null },
    ]);
    expect((pgQuery.mock.calls[0]![1] as unknown[]).slice(0, 2)).toEqual([[2], [null]]);
  });

  it('exec транзакции используется вместо пула', async () => {
    const exec = { query: vi.fn(async () => ({ rows: [] })) };
    await resolveExportModesForPairs([{ employee_id: 1, org_department_id: 'A' }], exec as never);
    expect(exec.query).toHaveBeenCalledTimes(1);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});
