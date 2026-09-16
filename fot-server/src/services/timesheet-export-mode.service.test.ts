import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Резолвинг режима табелирования для «Единого файла 1С».
 *
 * Главное, что здесь закреплено, — персональные назначения объектов
 * (employee_object_assignment) в резолвинге НЕ участвуют (миграция 253). Это управление
 * доступом табельщиц; до 253 галочка, поставленная ради доступа, молча меняла человеку
 * строки в выгрузке. Проверяем это на двух уровнях: таблицы нет в SQL и решают только
 * объекты отдела.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));

import {
  exportModePairKey,
  resolveExportModes,
  resolveExportModesForPairs,
  resolveRow,
} from './timesheet-export-mode.service.js';

const row = (over: Record<string, unknown> = {}) => ({
  employee_id: 1,
  emp_mode: null,
  emp_object_id: null,
  dept_mode: null,
  dept_object_id: null,
  dept_current_activity: false,
  ...over,
}) as Parameters<typeof resolveRow>[0];

beforeEach(() => {
  pgQuery.mockReset().mockResolvedValue([]);
});

describe('resolveRow — приоритет источников', () => {
  it('явный режим сотрудника выигрывает у всего остального', () => {
    const r = resolveRow(row({ emp_mode: 'skud', dept_mode: 'current_activity', dept_current_activity: true }));
    expect(r).toMatchObject({ mode: 'skud', source: 'employee_explicit', pinnedObjectId: null });
  });

  it('режим «объект» тянет за собой закреплённый объект', () => {
    const r = resolveRow(row({ emp_mode: 'object', emp_object_id: 'obj-1' }));
    expect(r).toMatchObject({ mode: 'object', pinnedObjectId: 'obj-1', source: 'employee_explicit' });
  });

  it('без режима сотрудника действует режим отдела', () => {
    const r = resolveRow(row({ dept_mode: 'object', dept_object_id: 'obj-2', dept_current_activity: true }));
    expect(r).toMatchObject({ mode: 'object', pinnedObjectId: 'obj-2', source: 'department_explicit' });
  });

  it('оба режима пусты, у отдела ТД-объект → current_activity', () => {
    const r = resolveRow(row({ dept_current_activity: true }));
    expect(r).toMatchObject({ mode: 'current_activity', source: 'legacy_department' });
  });

  it('ничего не задано → skud по умолчанию', () => {
    const r = resolveRow(row());
    expect(r).toMatchObject({ mode: 'skud', source: 'legacy_default' });
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

describe('resolveExportModes — вход', () => {
  it('пустой и мусорный список не идёт в БД', async () => {
    expect((await resolveExportModes([])).size).toBe(0);
    expect((await resolveExportModes([0, -3, Number.NaN])).size).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('дубликаты схлопываются, результат — карта по employee_id', async () => {
    pgQuery.mockResolvedValue([
      { employee_id: 1, emp_mode: 'skud', emp_object_id: null, dept_mode: null, dept_object_id: null, dept_current_activity: false },
    ]);

    const map = await resolveExportModes([1, 1, 1]);

    expect((pgQuery.mock.calls[0]![1] as unknown[])[0]).toEqual([1]);
    expect(map.get(1)).toMatchObject({ mode: 'skud', source: 'employee_explicit' });
  });
});

describe('resolveExportModesForPairs — режим по отделу пары', () => {
  it('SQL берёт режим отдела ПАРЫ (unnest), а не текущий отдел сотрудника', async () => {
    await resolveExportModesForPairs([{ employee_id: 1, org_department_id: 'A' }]);
    const [sql, params] = pgQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('unnest($1::int[], $2::uuid[])');
    expect(sql).toContain('LEFT JOIN org_departments d ON d.id = p.dept_id');
    expect(sql).not.toContain('d.id = e.org_department_id');
    expect(params.slice(0, 2)).toEqual([[1], ['A']]);
  });

  it('один сотрудник в двух отделах получает режим каждого отдела', async () => {
    pgQuery.mockResolvedValue([
      { employee_id: 1, pair_dept_id: 'A', emp_mode: null, emp_object_id: null, dept_mode: 'current_activity', dept_object_id: null, dept_current_activity: false },
      { employee_id: 1, pair_dept_id: 'B', emp_mode: null, emp_object_id: null, dept_mode: 'skud', dept_object_id: null, dept_current_activity: false },
    ]);

    const map = await resolveExportModesForPairs([
      { employee_id: 1, org_department_id: 'A' },
      { employee_id: 1, org_department_id: 'B' },
    ]);

    expect(map.get(exportModePairKey(1, 'A'))).toMatchObject({ mode: 'current_activity', source: 'department_explicit' });
    expect(map.get(exportModePairKey(1, 'B'))).toMatchObject({ mode: 'skud', source: 'department_explicit' });
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
