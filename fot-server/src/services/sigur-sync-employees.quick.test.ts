import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

/**
 * Точечный режим syncEmployeesLogic (onlySigurIds) и отказ полного синка от пустых
 * UPDATE. Моки БД и Sigur — как в sigur-sync-employees.run.test.ts.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  isConfigured: vi.fn(),
  getEmployeesCached: vi.fn(),
  getEmployeeById: vi.fn(),
  getSigurSettings: vi.fn(),
  getKnownArchive: vi.fn(),
  changeDepartment: vi.fn(),
  changePosition: vi.fn(),
  batchMove: vi.fn(),
  auditLog: vi.fn(),
  upsertAccess: vi.fn(),
  getGuards: vi.fn(),
  probe: vi.fn(),
  openDismiss: vi.fn(),
  executeOp: vi.fn(),
  countsInvalidateAll: vi.fn(),
  invalidateStructureCache: vi.fn(),
  invalidateCache: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    isConfigured: h.isConfigured,
    getEmployeesCached: h.getEmployeesCached,
    getEmployeeById: h.getEmployeeById,
  },
}));
vi.mock('./settings.service.js', () => ({
  settingsService: { getSigurConnectionSettings: h.getSigurSettings },
}));
vi.mock('./employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: h.getKnownArchive,
  ensureLocalArchiveDepartment: vi.fn(),
}));
vi.mock('./employee-changes.service.js', () => ({
  employeeChangesService: { changeDepartment: h.changeDepartment, changePosition: h.changePosition },
}));
vi.mock('./sigur-live-employees-crud.service.js', () => ({ batchMoveSigurEmployees: h.batchMove }));
vi.mock('./audit.service.js', () => ({ auditService: { log: h.auditLog } }));
vi.mock('./employee-department-access.service.js', () => ({
  upsertTechnicalDepartmentAccess: h.upsertAccess,
  deactivateAllDepartmentAccessForEmployee: vi.fn(),
}));
vi.mock('./employee-cache.service.js', () => ({ employeeCache: { invalidate: vi.fn() } }));
vi.mock('./employee-counts-cache.service.js', () => ({
  employeeCountsCache: { invalidateAll: h.countsInvalidateAll },
}));
vi.mock('./employee-mapper.service.js', () => ({ invalidateStructureCache: h.invalidateStructureCache }));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCache: h.invalidateCache }));
vi.mock('./presence-polling-cache.service.js', () => ({
  invalidatePresencePollingEmployeeCache: vi.fn(),
}));
vi.mock('./timekeeper-scope.service.js', () => ({ invalidateTimekeeperScopeCache: vi.fn() }));
vi.mock('./sigur-linked-employees.service.js', () => ({
  ensureArchiveSigurDepartment: vi.fn(),
  syncLinkedEmployeeFromSigur: vi.fn(),
}));
vi.mock('./employee-lifecycle-operations.service.js', async () => {
  const actual = await vi.importActual<typeof import('./employee-lifecycle-operations.service.js')>(
    './employee-lifecycle-operations.service.js',
  );
  return {
    ...actual,
    getLifecycleGuards: h.getGuards,
    probeSigurCard: h.probe,
    openDismissOperation: h.openDismiss,
    executeOperation: h.executeOp,
    openRepairOperation: vi.fn(),
    resetPendingRehireSigurMove: vi.fn(),
  };
});
vi.mock('./sigur-sync-shared.js', async () => {
  const actual = await vi.importActual<typeof import('./sigur-sync-shared.js')>('./sigur-sync-shared.js');
  return {
    ...actual,
    getWhitelistedDepartmentIdsCached: vi.fn(async () => null),
    getPositionsRaw: vi.fn(async () => []),
    logSampleAndWarn: vi.fn(),
  };
});

import { syncEmployeesLogic } from './sigur-sync-employees.service.js';
import { getWhitelistedDepartmentIdsCached } from './sigur-sync-shared.js';

const ARCHIVE_LOCAL = 'local-archive-uuid';
const ARCHIVE_SIGUR = 142094;
const BRIGADE_LOCAL = 'local-brigade-uuid';
const BRIGADE_SIGUR = 142383;
const OTHER_LOCAL = 'local-other-uuid';
const OTHER_SIGUR = 142999;

interface IDbEmployee {
  id: number;
  sigur_employee_id: number;
  employment_status: string;
  department_locked: boolean;
  name_locked: boolean;
  org_department_id: string | null;
  position_id: string | null;
  tab_number: string | null;
  full_name: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  dismissal_date: string | null;
  is_archived: boolean;
  lifecycle_revision: number;
}

const dbEmployee = (over: Partial<IDbEmployee> = {}): IDbEmployee => ({
  id: 14761,
  sigur_employee_id: 151896,
  employment_status: 'active',
  department_locked: false,
  name_locked: false,
  org_department_id: BRIGADE_LOCAL,
  position_id: 'position-1',
  tab_number: null,
  full_name: 'Сангалии Зикрулло',
  last_name: 'Сангалии',
  first_name: 'Зикрулло',
  middle_name: null,
  dismissal_date: null,
  is_archived: false,
  lifecycle_revision: 3,
  ...over,
});

const card = (over: Record<string, unknown> = {}) => ({
  id: 151896, name: 'Сангалии Зикрулло', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Подсобный рабочий', tabId: '', ...over,
});

interface INamesake { id: number; sigur_employee_id: number | null; employment_status: string; name_key: string }

interface IQueryOpts {
  employees?: IDbEmployee[];
  portalOnly?: Record<string, unknown>[];
  namesakes?: INamesake[];
  accessRows?: Array<{ id: number; org_department_id: string; has_access: boolean }>;
  insertFails?: boolean;
  positions?: Array<{ id: string; sigur_position_id: number | null; name: string }>;
}

const setupQueries = (opts: IQueryOpts = {}): void => {
  const employees = opts.employees ?? [];
  const positions = opts.positions ?? [{ id: 'position-1', sigur_position_id: 501, name: 'Подсобный рабочий' }];
  h.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO employees')) {
      if (opts.insertFails) throw new Error('insert failed');
      // RETURNING id, org_department_id, sigur_employee_id — по параметрам пачки (11 колонок).
      const rows: unknown[] = [];
      const p = params ?? [];
      for (let i = 0; i < p.length; i += 11) {
        rows.push({ id: 90000 + i, org_department_id: p[i + 8], sigur_employee_id: p[i + 7] });
      }
      return rows;
    }
    if (sql.includes('INSERT INTO positions')) {
      return [{ id: 'position-new', name: (params ?? [])[0] }];
    }
    if (sql.includes('FROM employees') && sql.includes('sigur_employee_id IS NOT NULL') && sql.includes('LIMIT')) {
      const ids = sql.includes('ANY($1') ? new Set((params?.[0] as number[]) ?? []) : null;
      return ids ? employees.filter(e => ids.has(e.sigur_employee_id)) : employees;
    }
    if (sql.includes('name_key')) return opts.namesakes ?? [];
    if (sql.includes('sigur_employee_id IS NULL')) return opts.portalOnly ?? [];
    if (sql.includes('employee_department_access')) return opts.accessRows ?? [];
    if (sql.includes('FROM org_departments') && sql.includes('sigur_department_id IS NOT NULL')) {
      return [
        { id: ARCHIVE_LOCAL, sigur_department_id: ARCHIVE_SIGUR, name: 'Уволенные', is_active: true },
        { id: BRIGADE_LOCAL, sigur_department_id: BRIGADE_SIGUR, name: 'бр.Баротов З.Б.', is_active: true },
        { id: OTHER_LOCAL, sigur_department_id: OTHER_SIGUR, name: 'бр.Другая', is_active: true },
      ];
    }
    if (sql.includes('parent_id') && sql.includes('org_departments')) {
      return [
        { id: ARCHIVE_LOCAL, parent_id: null },
        { id: BRIGADE_LOCAL, parent_id: null },
        { id: OTHER_LOCAL, parent_id: null },
      ];
    }
    if (sql.includes('FROM positions')) return positions;
    if (sql.includes('FROM employee_assignments')) return [];
    return [];
  });
  h.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('dismissal_apply_started_at')) {
      const e = employees[0];
      return {
        org_department_id: e?.org_department_id ?? null,
        employment_status: e?.employment_status ?? 'active',
        dismissal_date: null,
        dismissal_apply_started_at: null,
        lifecycle_revision: 3,
      };
    }
    if (sql.includes('count(*)') && sql.includes('employee_assignments')) return { count: 1 };
    return null;
  });
  h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, {
    employee_id: id,
    employment_status: 'active',
    lifecycle_revision: 3,
    pending_kind: null,
    pending_operation_id: null,
    pending_target_sigur_department_id: null,
    last_rehire_applied_at: null,
    last_rehire_target_department_id: null,
    last_rehire_target_sigur_department_id: null,
    absence_revision: null,
    absence_first_seen_at: null,
    absence_strikes: null,
  }])));
};

const notFound = (): AxiosError => {
  const error = new AxiosError('Not Found', 'ERR_BAD_REQUEST');
  error.response = { status: 404, statusText: 'Not Found', data: {}, headers: {}, config: { headers: new AxiosHeaders() } };
  return error;
};

const employeeUpdates = () => h.execute.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE employees'));

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  vi.mocked(getWhitelistedDepartmentIdsCached).mockResolvedValue(null);
  h.isConfigured.mockResolvedValue(true);
  h.getSigurSettings.mockResolvedValue({ archiveDepartmentId: ARCHIVE_SIGUR });
  h.getKnownArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
  h.changeDepartment.mockResolvedValue('applied');
  h.changePosition.mockResolvedValue(undefined);
  h.execute.mockResolvedValue(1);
  h.upsertAccess.mockResolvedValue(undefined);
  h.auditLog.mockResolvedValue(undefined);
  h.probe.mockResolvedValue({ state: 'archived', departmentId: ARCHIVE_SIGUR });
  h.openDismiss.mockImplementation(async (input: { employeeId: number }) => ({ id: `op-${input.employeeId}` }));
  h.executeOp.mockResolvedValue({ id: 0 });
  h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({
    query: async () => ({ rows: [], rowCount: 1 }),
  }));
});

describe('полный синк: только реальные изменения', () => {
  it('неизменные отдел и должность не дают UPDATE', async () => {
    setupQueries({ employees: [dbEmployee()] });
    h.getEmployeesCached.mockResolvedValue([card()]);

    const result = await syncEmployeesLogic();

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(employeeUpdates()).toHaveLength(0);
    expect(h.changeDepartment).not.toHaveBeenCalled();
    expect(h.changePosition).not.toHaveBeenCalled();
    expect(result.quick_outcomes).toBeUndefined();
  });

  it('новая должность в Sigur — смена должности, отдел не трогается', async () => {
    setupQueries({
      employees: [dbEmployee({ position_id: 'position-old' })],
    });
    h.getEmployeesCached.mockResolvedValue([card()]);

    await syncEmployeesLogic();

    expect(h.changePosition).toHaveBeenCalledWith(14761, 'position-1', expect.anything());
    expect(h.changeDepartment).not.toHaveBeenCalled();
    // В прямой UPDATE отдел не попадает.
    expect(employeeUpdates().some(([sql]) => String(sql).includes('org_department_id'))).toBe(false);
  });
});

describe('точечный режим syncEmployeesLogic', () => {
  it('пустой список — пустой прогон, не полный синк', async () => {
    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [] });

    expect(result.quick_outcomes?.size).toBe(0);
    expect(h.getEmployeesCached).not.toHaveBeenCalled();
    expect(h.getEmployeeById).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('новая карточка: вставка без полной выгрузки, техдоступ, сброс счётчиков; глобальные фазы не идут', async () => {
    setupQueries();
    h.getEmployeeById.mockResolvedValue(card());

    const result = await syncEmployeesLogic('external', undefined, {}, true, { onlySigurIds: [151896] });

    expect(result.quick_outcomes?.get(151896)).toBe('inserted');
    expect(result.imported).toBe(1);
    expect(h.getEmployeeById).toHaveBeenCalledWith(151896, 'external');
    expect(h.getEmployeesCached).not.toHaveBeenCalled();
    expect(h.upsertAccess).toHaveBeenCalledWith(90000, BRIGADE_LOCAL, null, 'sigur_sync');
    expect(h.countsInvalidateAll).toHaveBeenCalled();
    // Ни auto-fire (метки отсутствия, пробы), ни fired→архив.
    expect(h.execute.mock.calls.some(([sql]) => String(sql).includes('employee_sigur_absence_marks'))).toBe(false);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.batchMove).not.toHaveBeenCalled();
    // Связанные сотрудники читаются только по запрошенным карточкам.
    const existingSql = h.query.mock.calls.find(([sql]) => String(sql).includes('sigur_employee_id IS NOT NULL'));
    expect(String(existingSql?.[0])).toContain('ANY($1::int[])');
    expect(existingSql?.[1]).toEqual([[151896]]);
  });

  it('тёзки ищутся по full_name с нормализацией (пробелы, регистр, ё)', async () => {
    setupQueries();
    h.getEmployeeById.mockResolvedValue(card({ name: '  Семёнов   Пётр  ' }));

    await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    const namesakeCall = h.query.mock.calls.find(([sql]) => String(sql).includes('name_key'));
    expect(String(namesakeCall?.[0])).toContain('lower(btrim(full_name))');
    expect(namesakeCall?.[1]).toEqual([['семенов петр']]);
  });

  it.each([
    ['уволенный тёзка', { id: 500, sigur_employee_id: 140000, employment_status: 'fired' }],
    ['тёзка с другой карточкой', { id: 501, sigur_employee_id: 140001, employment_status: 'active' }],
    ['legacy-тёзка без last_name (найден по full_name)', { id: 502, sigur_employee_id: null, employment_status: 'fired' }],
  ])('%s: вставки нет, аудит с причиной', async (_title, namesake) => {
    setupQueries({ namesakes: [{ ...namesake, name_key: 'сангалии зикрулло' }] });
    h.getEmployeeById.mockResolvedValue(card());

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(result.quick_outcomes?.get(151896)).toBe('skipped_namesake');
    expect(result.imported).toBe(0);
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO employees'))).toBe(false);
    expect(h.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'SIGUR_QUICK_SYNC_SKIPPED',
      entity_id: '151896',
      details: expect.objectContaining({ reason: 'namesake', namesake_employee_ids: [namesake.id] }),
    }));
  });

  it('единственный активный portal-only тёзка — привязка', async () => {
    const portal = {
      id: 700, full_name: 'Сангалии Зикрулло', last_name: 'Сангалии', first_name: 'Зикрулло', middle_name: null,
      org_department_id: BRIGADE_LOCAL, position_id: 'position-1', tab_number: null, department_locked: false, name_locked: false,
    };
    setupQueries({
      portalOnly: [portal],
      namesakes: [{ id: 700, sigur_employee_id: null, employment_status: 'active', name_key: 'сангалии зикрулло' }],
      accessRows: [{ id: 700, org_department_id: BRIGADE_LOCAL, has_access: true }],
    });
    h.getEmployeeById.mockResolvedValue(card());

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(result.quick_outcomes?.get(151896)).toBe('linked');
    expect(employeeUpdates().some(([sql, params]) => String(sql).includes('sigur_employee_id')
      && (params as unknown[]).includes(151896))).toBe(true);
    expect(result.imported).toBe(0);
  });

  it('portal-only плюс уволенный тёзка — неоднозначно, привязки нет', async () => {
    const portal = {
      id: 700, full_name: 'Сангалии Зикрулло', last_name: 'Сангалии', first_name: 'Зикрулло', middle_name: null,
      org_department_id: BRIGADE_LOCAL, position_id: 'position-1', tab_number: null, department_locked: false, name_locked: false,
    };
    setupQueries({
      portalOnly: [portal],
      namesakes: [
        { id: 700, sigur_employee_id: null, employment_status: 'active', name_key: 'сангалии зикрулло' },
        { id: 701, sigur_employee_id: 140000, employment_status: 'fired', name_key: 'сангалии зикрулло' },
      ],
    });
    h.getEmployeeById.mockResolvedValue(card());

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(result.quick_outcomes?.get(151896)).toBe('skipped_namesake');
    expect(employeeUpdates()).toHaveLength(0);
  });

  it('смена отдела у существующего — через changeDepartment, исход updated', async () => {
    setupQueries({ employees: [dbEmployee({ org_department_id: OTHER_LOCAL })] });
    h.getEmployeeById.mockResolvedValue(card());

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(h.changeDepartment).toHaveBeenCalledWith(14761, BRIGADE_LOCAL, expect.objectContaining({ reason: 'Синхронизация Sigur' }));
    expect(result.quick_outcomes?.get(151896)).toBe('updated');
  });

  it('неизменный сотрудник без техдоступа (повтор после сбоя) — доступ восстанавливается', async () => {
    setupQueries({
      employees: [dbEmployee()],
      accessRows: [{ id: 14761, org_department_id: BRIGADE_LOCAL, has_access: false }],
    });
    h.getEmployeeById.mockResolvedValue(card());

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(result.quick_outcomes?.get(151896)).toBe('unchanged');
    expect(employeeUpdates()).toHaveLength(0);
    expect(h.upsertAccess).toHaveBeenCalledWith(14761, BRIGADE_LOCAL, null, 'sigur_sync');
  });

  it('неизменный сотрудник с техдоступом — доступ не трогаем', async () => {
    setupQueries({
      employees: [dbEmployee()],
      accessRows: [{ id: 14761, org_department_id: BRIGADE_LOCAL, has_access: true }],
    });
    h.getEmployeeById.mockResolvedValue(card());

    await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(h.upsertAccess).not.toHaveBeenCalled();
  });

  it('404 — not_found, сбой GET — retryable, остальные карточки обрабатываются', async () => {
    setupQueries();
    h.getEmployeeById.mockImplementation(async (id: number) => {
      if (id === 1) throw notFound();
      if (id === 2) throw new Error('ECONNRESET');
      return card({ id, name: 'Новиков Олег' });
    });

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [1, 2, 3] });

    expect(result.quick_outcomes?.get(1)).toBe('not_found');
    expect(result.quick_outcomes?.get(2)).toBe('retryable');
    expect(result.quick_outcomes?.get(3)).toBe('inserted');
  });

  it('ошибка UPDATE — retryable именно для своей карточки', async () => {
    setupQueries({
      employees: [
        dbEmployee({ tab_number: 'old' }),
        dbEmployee({ id: 14762, sigur_employee_id: 151897, full_name: 'Макарова Евгения', last_name: 'Макарова', first_name: 'Евгения', tab_number: 'old' }),
      ],
    });
    h.getEmployeeById.mockImplementation(async (id: number) => (id === 151896
      ? card({ tabId: 'new-1' })
      : card({ id: 151897, name: 'Макарова Евгения', tabId: 'new-2' })));
    h.execute.mockImplementation(async (sql: string, params: unknown[]) => {
      if (String(sql).startsWith('UPDATE employees') && params.includes(14761)) throw new Error('deadlock');
      return 1;
    });

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896, 151897] });

    expect(result.quick_outcomes?.get(151896)).toBe('retryable');
    expect(result.quick_outcomes?.get(151897)).toBe('updated');
  });

  it('ошибка INSERT — retryable', async () => {
    setupQueries({ insertFails: true });
    h.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO employees')) throw new Error('unique violation');
      return null;
    });
    h.getEmployeeById.mockResolvedValue(card());

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(result.quick_outcomes?.get(151896)).toBe('retryable');
  });

  it('INSERT прошёл, техдоступ упал — retryable', async () => {
    setupQueries();
    h.upsertAccess.mockRejectedValue(new Error('access failed'));
    h.getEmployeeById.mockResolvedValue(card());

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(result.imported).toBe(1);
    expect(result.quick_outcomes?.get(151896)).toBe('retryable');
  });

  it('карточка в архивной папке — увольнение операцией с контрольной пробой', async () => {
    setupQueries({ employees: [dbEmployee()] });
    h.getEmployeeById.mockResolvedValue(card({ departmentId: ARCHIVE_SIGUR }));

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(h.probe).toHaveBeenCalledWith(151896, ARCHIVE_SIGUR, undefined);
    expect(h.openDismiss).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 14761, source: 'sigur_archive' }));
    expect(result.archive_fired).toBe(1);
    expect(result.quick_outcomes?.get(151896)).toBe('updated');
  });

  it('новая карточка вне whitelist — skipped_whitelist, окончательно', async () => {
    setupQueries();
    vi.mocked(getWhitelistedDepartmentIdsCached).mockResolvedValue(new Set([OTHER_SIGUR]));
    h.getEmployeeById.mockResolvedValue(card());

    const result = await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(result.quick_outcomes?.get(151896)).toBe('skipped_whitelist');
    expect(result.imported).toBe(0);
  });

  it('создание должности сбрасывает кэш структуры и structure:positions', async () => {
    setupQueries({ positions: [] });
    h.getEmployeeById.mockResolvedValue(card({ positionId: 999, position: 'Электрогазосварщик' }));

    await syncEmployeesLogic(undefined, undefined, {}, true, { onlySigurIds: [151896] });

    expect(h.invalidateStructureCache).toHaveBeenCalled();
    expect(h.invalidateCache).toHaveBeenCalledWith('structure:positions');
  });
});
