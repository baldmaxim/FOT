import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx, mockGetEmployeeAssignments, mockGetTransferConfig } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
  mockGetEmployeeAssignments: vi.fn(),
  mockGetTransferConfig: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getEmployeeTransferConfig: mockGetTransferConfig,
  },
}));

vi.mock('./employee-cache.service.js', () => ({
  employeeCache: { invalidate: vi.fn() },
}));

vi.mock('./timesheet-department-assignments.service.js', async () => {
  const actual = await vi.importActual<typeof import('./timesheet-department-assignments.service.js')>(
    './timesheet-department-assignments.service.js',
  );
  return {
    ...actual,
    getEmployeeAssignments: mockGetEmployeeAssignments,
  };
});

vi.mock('./timesheet-transfers.service.js', () => ({
  tryDeleteTransfer: vi.fn().mockResolvedValue({ deleted: false }),
}));

import { employeeChangesService } from './employee-changes.service.js';
import { formatDateShift } from './timesheet-department-assignments.service.js';

interface IExecutedQuery {
  sql: string;
  params: readonly unknown[] | undefined;
}

const createFakeClient = (
  responder: (sql: string, params: readonly unknown[] | undefined) => { rows: unknown[] } | undefined,
) => {
  const queries: IExecutedQuery[] = [];
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    queries.push({ sql, params });
    const result = responder(sql, params);
    return result ?? { rows: [] };
  });
  return { query, queries };
};

describe('employee-changes.service.changeDepartment — overlap regression', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockGetEmployeeAssignments.mockReset();
    mockGetTransferConfig.mockReset();
  });

  it('freezeHistory=true: переоткрывает самую свежую закрытую запись вместо INSERT с hire_date', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: true });

    const employeeId = 2521;
    const closedAssignmentId = 'closed-uuid-1';

    const fake = createFakeClient((sql) => {
      if (/SELECT.+FROM employees WHERE id/i.test(sql)) {
        return { rows: [{ org_department_id: 'archive-dept', position_id: null, hire_date: '2020-03-01' }] };
      }
      if (/SELECT id, effective_from\s+FROM employee_assignments\s+WHERE employee_id = \$1 AND effective_to IS NULL/i.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT id\s+FROM employee_assignments\s+WHERE employee_id = \$1 AND effective_to IS NOT NULL/i.test(sql)) {
        return { rows: [{ id: closedAssignmentId }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await expect(
      employeeChangesService.changeDepartment(employeeId, 'new-dept', {
        reason: 'Восстановление на работу',
        createdBy: 'user-1',
        effectiveDate: '2026-05-13',
      }),
    ).resolves.toBeUndefined();

    const updates = fake.queries.filter(q => /UPDATE employee_assignments/i.test(q.sql));
    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));

    expect(inserts).toHaveLength(0);
    const reopen = updates.find(q => /SET org_department_id\s*=\s*\$1,\s+position_id\s*=\s*\$2,\s+effective_to\s*=\s*NULL/i.test(q.sql));
    expect(reopen).toBeTruthy();
    expect(reopen?.params).toEqual(expect.arrayContaining(['new-dept', null, 'Восстановление на работу']));
    expect(reopen?.params?.slice(-2)).toEqual([closedAssignmentId, employeeId]);
  });

  it('freezeHistory=true: INSERT только если у сотрудника вообще нет ни одной строки', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: true });

    const fake = createFakeClient((sql) => {
      if (/SELECT.+FROM employees WHERE id/i.test(sql)) {
        return { rows: [{ org_department_id: null, position_id: null, hire_date: '2025-01-15' }] };
      }
      if (/SELECT id, effective_from\s+FROM employee_assignments\s+WHERE employee_id = \$1 AND effective_to IS NULL/i.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT id\s+FROM employee_assignments\s+WHERE employee_id = \$1 AND effective_to IS NOT NULL/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      reason: 'Перевод',
      effectiveDate: '2026-05-13',
    });

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[3]).toBe('2025-01-15');
  });

  it('freezeHistory=false: single closed-today row → закрывает в today-1 и INSERT [today, null]', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2024-01-01', effective_to: '2026-05-13' },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
        return { rows: [{ position_id: 'pos-1', org_department_id: 'old-dept' }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      effectiveDate: '2026-05-13',
    });

    const closeUpdate = fake.queries.find(q =>
      /UPDATE employee_assignments\s+SET effective_to = \$1, updated_at = \$2\s+WHERE id = \$3/i.test(q.sql),
    );
    expect(closeUpdate).toBeTruthy();
    expect(closeUpdate?.params?.[0]).toBe('2026-05-12');
    expect(closeUpdate?.params?.[2]).toBe('a-1');

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[3]).toBe('2026-05-13');
  });

  it('freezeHistory=true + forceHistory=true: ведёт полную историю (закрывает старую + INSERT новой)', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: true });

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2024-01-01', effective_to: null },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
        return { rows: [{ position_id: 'pos-1', org_department_id: 'real-dept' }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'archive-dept', {
      reason: 'Увольнение — перевод в папку "Уволенные"',
      effectiveDate: '2026-05-27',
      forceHistory: true,
    });

    // forceHistory обходит freeze: должна сработать non-freeze ветка
    const closeUpdate = fake.queries.find(q =>
      /UPDATE employee_assignments\s+SET effective_to = \$1, updated_at = \$2\s+WHERE id = \$3/i.test(q.sql),
    );
    expect(closeUpdate).toBeTruthy();
    expect(closeUpdate?.params?.[0]).toBe('2026-05-26'); // date-1
    expect(closeUpdate?.params?.[2]).toBe('a-1');

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[1]).toBe('archive-dept');
    expect(inserts[0].params?.[3]).toBe('2026-05-27');

    // НЕ должно быть frozen-перезаписи (reopen с effective_to=NULL)
    const reopen = fake.queries.find(q => /SET org_department_id\s*=\s*\$1,\s+position_id\s*=\s*\$2,\s+effective_to\s*=\s*NULL/i.test(q.sql));
    expect(reopen).toBeFalsy();
  });

  it('freezeHistory=false: closed[X, today-1] + zero-day [today, today] → UPDATE sameDayAssignment, effective_to=null', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2024-01-01', effective_to: '2026-05-12' },
      { id: 'a-2', effective_from: '2026-05-13', effective_to: '2026-05-13' },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
        return { rows: [{ position_id: null, org_department_id: 'archive-dept' }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      effectiveDate: '2026-05-13',
    });

    const sameDayUpdate = fake.queries.find(q =>
      /UPDATE employee_assignments\s+SET org_department_id = \$1,\s+position_id = \$2,\s+effective_to = \$3/i.test(q.sql),
    );
    expect(sameDayUpdate).toBeTruthy();
    expect(sameDayUpdate?.params?.[0]).toBe('new-dept');
    expect(sameDayUpdate?.params?.[2]).toBeNull();
    expect(sameDayUpdate?.params?.[6]).toBe('a-2');

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(0);
  });
});

describe('employee-changes.service.changeDepartment — бэкдейт-перевод доводится до сегодня', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockGetEmployeeAssignments.mockReset();
    mockGetTransferConfig.mockReset();
  });

  it('позднее назначение в другом отделе: закрывает его в today-1 и открывает целевой отдел с today', async () => {
    // Сценарий возвратов из ОСА 08.07.2026: перевод задним числом (01.04) при
    // существующем открытом назначении в другом отделе (ОСА с 28.04). Раньше
    // ОСА оставался открытым навсегда — сотрудник числился в двух отделах.
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

    const todayIso = new Date().toISOString().slice(0, 10);
    const yesterday = formatDateShift(todayIso, -1);

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2010-01-01', effective_to: '2026-04-27' },
      { id: 'a-osa', effective_from: '2026-04-28', effective_to: null },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
        return { rows: [{ position_id: null, org_department_id: 'osa-dept' }] };
      }
      if (/SELECT id, org_department_id, effective_from::text/i.test(sql)) {
        return { rows: [{ id: 'a-osa', org_department_id: 'osa-dept', effective_from: '2026-04-28' }] };
      }
      if (/effective_from > \$2/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'tender-dept', {
      reason: 'Перевод в другой отдел',
      effectiveDate: '2026-04-01',
    });

    const closeUpdates = fake.queries.filter(q =>
      /UPDATE employee_assignments\s+SET effective_to = \$1, updated_at = \$2\s+WHERE id = \$3/i.test(q.sql),
    );
    // Закрытие активного на дату перевода (a-1 в 31.03) + закрытие позднего (a-osa в today-1).
    expect(closeUpdates.map(q => [q.params?.[0], q.params?.[2]])).toEqual([
      ['2026-03-31', 'a-1'],
      [yesterday, 'a-osa'],
    ]);

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(2);
    // Бэкдейт-вставка закрыта началом позднего назначения.
    expect(inserts[0].params?.[1]).toBe('tender-dept');
    expect(inserts[0].params?.[3]).toBe('2026-04-01');
    expect(inserts[0].params?.[4]).toBe('2026-04-27');
    // Довод до сегодня: открытое назначение в целевом отделе с today.
    expect(inserts[1].params?.[1]).toBe('tender-dept');
    expect(inserts[1].params?.[3]).toBe(todayIso);
    expect(inserts[1].params?.[4]).toBeNull();
  });

  it('активное сегодня назначение уже в целевом отделе: лишних записей не создаёт', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2024-01-01', effective_to: null },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
        return { rows: [{ position_id: null, org_department_id: 'old-dept' }] };
      }
      if (/SELECT id, org_department_id, effective_from::text/i.test(sql)) {
        // Основной блок уже вставил открытое назначение целевого отдела с 13.05.
        return { rows: [{ id: 'a-new', org_department_id: 'new-dept', effective_from: '2026-05-13' }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      effectiveDate: '2026-05-13',
    });

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[3]).toBe('2026-05-13');

    // Позднее назначение не трогали.
    const touchedANew = fake.queries.find(q => (q.params || []).includes('a-new') && /UPDATE/i.test(q.sql));
    expect(touchedANew).toBeFalsy();
  });

  it('позднее назначение стартует сегодня: обновляет его отдел вместо нулевого периода', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

    const todayIso = new Date().toISOString().slice(0, 10);

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2010-01-01', effective_to: '2026-03-31' },
      { id: 'a-today', effective_from: todayIso, effective_to: null },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
        return { rows: [{ position_id: null, org_department_id: 'osa-dept' }] };
      }
      if (/SELECT id, org_department_id, effective_from::text/i.test(sql)) {
        return { rows: [{ id: 'a-today', org_department_id: 'osa-dept', effective_from: todayIso }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'tender-dept', {
      effectiveDate: '2026-04-01',
    });

    // Бэкдейт-вставка закрыта днём перед сегодняшним назначением.
    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[3]).toBe('2026-04-01');
    expect(inserts[0].params?.[4]).toBe(formatDateShift(todayIso, -1));

    const deptUpdate = fake.queries.find(q =>
      /UPDATE employee_assignments\s+SET org_department_id = \$1,\s+change_reason = \$2/i.test(q.sql),
    );
    expect(deptUpdate).toBeTruthy();
    expect(deptUpdate?.params?.[0]).toBe('tender-dept');
    expect(deptUpdate?.params?.[4]).toBe('a-today');

    // Закрытия в today-1 для a-today быть не должно (нулевой период to < from).
    const zeroDayClose = fake.queries.find(q =>
      /SET effective_to = \$1, updated_at = \$2\s+WHERE id = \$3/i.test(q.sql) && q.params?.[2] === 'a-today',
    );
    expect(zeroDayClose).toBeFalsy();
  });

  it('существует будущее назначение: довод до сегодня закрывается перед ним, пересечения нет', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

    const todayIso = new Date().toISOString().slice(0, 10);
    const futureFrom = formatDateShift(todayIso, 10);

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2010-01-01', effective_to: '2026-04-27' },
      { id: 'a-osa', effective_from: '2026-04-28', effective_to: formatDateShift(futureFrom, -1) },
      { id: 'a-future', effective_from: futureFrom, effective_to: null },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
        return { rows: [{ position_id: null, org_department_id: 'osa-dept' }] };
      }
      if (/SELECT id, org_department_id, effective_from::text/i.test(sql)) {
        return { rows: [{ id: 'a-osa', org_department_id: 'osa-dept', effective_from: '2026-04-28' }] };
      }
      if (/effective_from > \$2/i.test(sql)) {
        return { rows: [{ effective_from: futureFrom }] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'tender-dept', {
      effectiveDate: '2026-04-01',
    });

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(2);
    // Довод до сегодня НЕ открытый: закрыт днём перед будущим назначением.
    expect(inserts[1].params?.[3]).toBe(todayIso);
    expect(inserts[1].params?.[4]).toBe(formatDateShift(futureFrom, -1));

    // Будущее назначение не тронуто.
    const touchedFuture = fake.queries.find(q =>
      /UPDATE employee_assignments/i.test(q.sql) && (q.params || []).includes('a-future'),
    );
    expect(touchedFuture).toBeFalsy();
  });

  it('промежуточные исторические назначения между датой перевода и сегодня не трогаются', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

    const todayIso = new Date().toISOString().slice(0, 10);
    const yesterday = formatDateShift(todayIso, -1);

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1',    effective_from: '2010-01-01', effective_to: '2026-04-21' },
      { id: 'a-mid1', effective_from: '2026-04-22', effective_to: '2026-05-06' },
      { id: 'a-mid2', effective_from: '2026-05-07', effective_to: '2026-06-30' },
      { id: 'a-osa',  effective_from: '2026-07-01', effective_to: null },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
        return { rows: [{ position_id: null, org_department_id: 'osa-dept' }] };
      }
      if (/SELECT id, org_department_id, effective_from::text/i.test(sql)) {
        return { rows: [{ id: 'a-osa', org_department_id: 'osa-dept', effective_from: '2026-07-01' }] };
      }
      if (/effective_from > \$2/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'tender-dept', {
      effectiveDate: '2026-04-01',
    });

    // Изменяются ровно два назначения: активное на 01.04 (a-1) и активное сегодня (a-osa).
    const closeUpdates = fake.queries.filter(q =>
      /UPDATE employee_assignments\s+SET effective_to = \$1, updated_at = \$2\s+WHERE id = \$3/i.test(q.sql),
    );
    expect(closeUpdates.map(q => [q.params?.[0], q.params?.[2]])).toEqual([
      ['2026-03-31', 'a-1'],
      [yesterday, 'a-osa'],
    ]);

    // Промежуточная история цела.
    const touchedMid = fake.queries.find(q =>
      /UPDATE employee_assignments/i.test(q.sql)
        && ((q.params || []).includes('a-mid1') || (q.params || []).includes('a-mid2')),
    );
    expect(touchedMid).toBeFalsy();
  });

  it('граница суток (UTC vs локальная TZ): закрытие и открытие согласованы от одних часов', async () => {
    // 22:30 UTC = 01:30 следующего дня по Москве (setup ставит TZ=Europe/Moscow).
    // Инвариант: сравнение date<today, закрытие today-1 и открытие today берутся
    // от одного источника времени — стык без дыры и без пересечения.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T22:30:00Z'));
    try {
      mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

      mockGetEmployeeAssignments.mockResolvedValue([
        { id: 'a-1', effective_from: '2010-01-01', effective_to: '2026-04-27' },
        { id: 'a-osa', effective_from: '2026-04-28', effective_to: null },
      ]);

      const fake = createFakeClient((sql) => {
        if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
          return { rows: [{ position_id: null, org_department_id: 'osa-dept' }] };
        }
        if (/SELECT id, org_department_id, effective_from::text/i.test(sql)) {
          return { rows: [{ id: 'a-osa', org_department_id: 'osa-dept', effective_from: '2026-04-28' }] };
        }
        if (/effective_from > \$2/i.test(sql)) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

      await employeeChangesService.changeDepartment(2521, 'tender-dept', {
        effectiveDate: '2026-04-01',
      });

      const closeOsa = fake.queries.find(q =>
        /SET effective_to = \$1, updated_at = \$2\s+WHERE id = \$3/i.test(q.sql) && q.params?.[2] === 'a-osa',
      );
      const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
      const catchUp = inserts[1];

      // today() в сервисе — UTC-дата: 2026-07-14, хотя в Москве уже 15.07.
      expect(catchUp?.params?.[3]).toBe('2026-07-14');
      expect(closeOsa?.params?.[0]).toBe('2026-07-13');
      // Стык согласован независимо от TZ: закрытие = открытие - 1 день.
      expect(closeOsa?.params?.[0]).toBe(formatDateShift(String(catchUp?.params?.[3]), -1));
    } finally {
      vi.useRealTimers();
    }
  });

  it('снапшот в конце транзакции читается через client транзакции и получает целевой отдел', async () => {
    // Защита от гонки с фоновым синком: снапшот считается по данным ЭТОЙ транзакции
    // (глобальный query() ушёл бы в другой коннект и не увидел бы незакоммиченное).
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });

    const todayIso = new Date().toISOString().slice(0, 10);

    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2010-01-01', effective_to: '2026-04-27' },
      { id: 'a-osa', effective_from: '2026-04-28', effective_to: null },
    ]);

    const fake = createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
        return { rows: [{ position_id: null, org_department_id: 'osa-dept' }] };
      }
      if (/SELECT id, org_department_id, effective_from::text/i.test(sql)) {
        return { rows: [{ id: 'a-osa', org_department_id: 'osa-dept', effective_from: '2026-04-28' }] };
      }
      if (/effective_from > \$2/i.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT org_department_id, position_id,\s+effective_from::text/i.test(sql)) {
        // Состояние ВНУТРИ транзакции после правок: ОСА закрыт, целевой открыт с today.
        return {
          rows: [
            { org_department_id: 'osa-dept', position_id: null, effective_from: '2026-04-28', effective_to: formatDateShift(todayIso, -1) },
            { org_department_id: 'tender-dept', position_id: 'pos-9', effective_from: todayIso, effective_to: null },
          ],
        };
      }
      return { rows: [] };
    });

    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'tender-dept', {
      effectiveDate: '2026-04-01',
    });

    // Чтение назначений для снапшота прошло через client транзакции.
    const snapshotRead = fake.queries.find(q =>
      /SELECT org_department_id, position_id,\s+effective_from::text/i.test(q.sql),
    );
    expect(snapshotRead).toBeTruthy();

    // Снапшот employees выставлен по активному-сегодня назначению из транзакции.
    const snapshotWrite = fake.queries.find(q =>
      /UPDATE employees\s+SET position_id = \$1,\s+org_department_id = \$2/i.test(q.sql),
    );
    expect(snapshotWrite).toBeTruthy();
    expect(snapshotWrite?.params?.[0]).toBe('pos-9');
    expect(snapshotWrite?.params?.[1]).toBe('tender-dept');
  });
});

describe('employee-changes.service.changeDepartment — snapshot-only: синтез прежнего отдела', () => {
  const SYNTH_REASON = 'Автозапись прежнего отдела при переводе';

  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockGetEmployeeAssignments.mockReset();
    mockGetTransferConfig.mockReset();
  });

  const makeFake = (hireDate: string | null) =>
    createFakeClient((sql) => {
      if (/SELECT position_id, org_department_id.* FROM employees/i.test(sql)) {
        return { rows: [{ position_id: 'pos-1', org_department_id: 'old-dept', hire_date: hireDate }] };
      }
      return { rows: [] };
    });

  it('backdate: нет истории → создаёт пару (старый [hire..date-1] + новый с date)', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });
    mockGetEmployeeAssignments.mockResolvedValue([]);
    const fake = makeFake('2026-05-01');
    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      effectiveDate: '2026-07-01',
      createdBy: 'u1',
    });

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(2);
    // синтез прежнего отдела первым
    expect(inserts[0].params?.[1]).toBe('old-dept');
    expect(inserts[0].params?.[3]).toBe('2026-05-01');
    expect(inserts[0].params?.[4]).toBe('2026-06-30'); // date-1
    expect(inserts[0].params?.[5]).toBe(SYNTH_REASON);
    // затем новый отдел с даты перевода
    expect(inserts[1].params?.[1]).toBe('new-dept');
    expect(inserts[1].params?.[3]).toBe('2026-07-01');
  });

  it('будущая дата: нет истории → пара (старый закрыт date-1, новый с date), без задвоения', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });
    mockGetEmployeeAssignments.mockResolvedValue([]);
    const fake = makeFake('2026-05-01');
    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      effectiveDate: '2026-12-01', // заведомо будущая относительно текущей даты
    });

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params?.[1]).toBe('old-dept');
    expect(inserts[0].params?.[4]).toBe('2026-11-30');
    expect(inserts[1].params?.[1]).toBe('new-dept');
    expect(inserts[1].params?.[3]).toBe('2026-12-01');
  });

  it('date === hire_date: прежнего периода нет → синтез не создаётся', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });
    mockGetEmployeeAssignments.mockResolvedValue([]);
    const fake = makeFake('2026-05-01');
    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      effectiveDate: '2026-05-01',
    });

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    const synth = inserts.find(q => (q.params || []).includes(SYNTH_REASON));
    expect(synth).toBeFalsy();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[1]).toBe('new-dept');
  });

  it('date < hire_date: отклоняет как ошибку, ничего не пишет', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });
    mockGetEmployeeAssignments.mockResolvedValue([]);
    const fake = makeFake('2026-05-01');
    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await expect(
      employeeChangesService.changeDepartment(2521, 'new-dept', { effectiveDate: '2026-04-01' }),
    ).rejects.toThrow(/раньше даты найма/i);

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    expect(inserts).toHaveLength(0);
  });

  it('есть закрытая история (исключённый) → синтез не срабатывает', async () => {
    mockGetTransferConfig.mockResolvedValue({ freezeHistory: false });
    mockGetEmployeeAssignments.mockResolvedValue([
      { id: 'a-1', effective_from: '2026-05-01', effective_to: '2026-06-01' },
    ]);
    const fake = makeFake('2026-05-01');
    pgTx.mockImplementation(async (fn: (client: typeof fake) => Promise<unknown>) => fn(fake));

    await employeeChangesService.changeDepartment(2521, 'new-dept', {
      effectiveDate: '2026-07-01',
    });

    const inserts = fake.queries.filter(q => /INSERT INTO employee_assignments/i.test(q.sql));
    const synth = inserts.find(q => (q.params || []).includes(SYNTH_REASON));
    expect(synth).toBeFalsy();
  });
});
