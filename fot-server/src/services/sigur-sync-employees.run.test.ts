import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Прогон syncEmployeesLogic на моках БД и Sigur. Проверяем поведение вокруг
 * увольнений (инцидент 10–13.08.2026): синк не возвращает уволенных в строй,
 * не двигает их отдел/должность и не опережает запланированные увольнения.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  isConfigured: vi.fn(),
  getEmployeesCached: vi.fn(),
  getSigurSettings: vi.fn(),
  getKnownArchive: vi.fn(),
  ensureLocalArchive: vi.fn(),
  changeDepartment: vi.fn(),
  changePosition: vi.fn(),
  batchMove: vi.fn(),
  auditLog: vi.fn(),
  upsertAccess: vi.fn(),
  getGuards: vi.fn(),
  probe: vi.fn(),
  openDismiss: vi.fn(),
  executeOp: vi.fn(),
  openRepair: vi.fn(),
  resetRehireMove: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: { isConfigured: h.isConfigured, getEmployeesCached: h.getEmployeesCached },
}));
vi.mock('./settings.service.js', () => ({
  settingsService: { getSigurConnectionSettings: h.getSigurSettings },
}));
vi.mock('./employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: h.getKnownArchive,
  ensureLocalArchiveDepartment: h.ensureLocalArchive,
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
vi.mock('./presence-polling-cache.service.js', () => ({
  invalidatePresencePollingEmployeeCache: vi.fn(),
}));
vi.mock('./timekeeper-scope.service.js', () => ({ invalidateTimekeeperScopeCache: vi.fn() }));
vi.mock('./sigur-linked-employees.service.js', () => ({
  ensureArchiveSigurDepartment: vi.fn(),
  syncLinkedEmployeeFromSigur: vi.fn(),
}));
// Исполнитель durable-операций мокаем целиком (кроме чистых функций): синк должен лишь
// правильно открыть/запустить операцию, сама операция тестируется отдельно.
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
    openRepairOperation: h.openRepair,
    resetPendingRehireSigurMove: h.resetRehireMove,
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
import { LifecycleOperationError, type ILifecycleGuard } from './employee-lifecycle-operations.service.js';

const ARCHIVE_LOCAL = 'local-archive-uuid';
const ARCHIVE_SIGUR = 142094;
const BRIGADE_LOCAL = 'local-brigade-uuid';
const BRIGADE_SIGUR = 142383;

interface IDbEmployee {
  id: number;
  sigur_employee_id: number;
  employment_status: string;
  department_locked?: boolean;
  name_locked?: boolean;
  org_department_id: string | null;
  position_id: string | null;
  tab_number: string | null;
  full_name: string | null;
  last_name?: string | null;
  first_name?: string | null;
  middle_name?: string | null;
  dismissal_date: string | null;
  is_archived?: boolean;
  lifecycle_revision?: number;
}

const dbEmployee = (over: Partial<IDbEmployee> = {}): IDbEmployee => ({
  id: 128,
  sigur_employee_id: 91831,
  employment_status: 'active',
  department_locked: false,
  name_locked: false,
  is_archived: false,
  org_department_id: BRIGADE_LOCAL,
  position_id: 'position-1',
  tab_number: '05510',
  full_name: 'Аллакулов Улугбек Туракулович',
  last_name: 'Аллакулов',
  first_name: 'Улугбек',
  middle_name: 'Туракулович',
  dismissal_date: null,
  lifecycle_revision: 3,
  ...over,
});

/** Гард lifecycle по умолчанию: без операций, без недавнего rehire, без метки отсутствия. */
const guardOf = (over: Partial<ILifecycleGuard> & { employee_id: number }): ILifecycleGuard => ({
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
  ...over,
});

const mskToday = (): string => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

/** Роутер моков `query` по характерным фрагментам SQL. */
const setupQueries = (opts: {
  employees: IDbEmployee[];
  freshStatus?: string;
  freshDeptId?: string | null;
}): void => {
  let employeesPage = 0;
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM employees') && sql.includes('sigur_employee_id IS NOT NULL')
      && sql.includes('LIMIT')) {
      return employeesPage++ === 0 ? opts.employees : [];
    }
    if (sql.includes('sigur_employee_id IS NULL')) return [];
    if (sql.includes('FROM org_departments') && sql.includes('sigur_department_id IS NOT NULL')) {
      return [
        { id: ARCHIVE_LOCAL, sigur_department_id: ARCHIVE_SIGUR, name: 'Уволенные', is_active: true },
        { id: BRIGADE_LOCAL, sigur_department_id: BRIGADE_SIGUR, name: 'бр.Аллакулов У.Т.', is_active: true },
      ];
    }
    if (sql.includes('parent_id') && sql.includes('org_departments')) {
      return [{ id: ARCHIVE_LOCAL, parent_id: null }, { id: BRIGADE_LOCAL, parent_id: null }];
    }
    if (sql.includes('FROM positions')) {
      return [{ id: 'position-1', sigur_position_id: 501, name: 'Маляр' }];
    }
    if (sql.includes('FROM employee_assignments')) return [];
    if (sql.includes("employment_status = 'fired'") && sql.includes('sigur_employee_id')) {
      return opts.employees
        .filter(e => e.employment_status === 'fired')
        .map(e => ({ id: e.id, sigur_employee_id: e.sigur_employee_id }));
    }
    return [];
  });

  h.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('dismissal_apply_started_at')) {
      return {
        org_department_id: opts.freshDeptId ?? ARCHIVE_LOCAL,
        employment_status: opts.freshStatus ?? 'fired',
        // Как в БД-фикстуре: у активного без назначенного увольнения — null
        // (иначе decideDeptSyncAction уйдёт в skip-local-dismissal).
        dismissal_date: opts.employees[0]?.dismissal_date ?? null,
        dismissal_apply_started_at: null,
        lifecycle_revision: 3,
      };
    }
    return null;
  });

  // Гарды по умолчанию — из состояния сотрудника в БД-фикстуре.
  h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => {
    const e = opts.employees.find(x => x.id === id);
    return [id, guardOf({
      employee_id: id,
      employment_status: e?.employment_status ?? 'active',
      lifecycle_revision: e?.lifecycle_revision ?? 3,
    })];
  })));
};

/** Собирает SQL и параметры всех запросов, выполненных внутри withTransaction. */
const collectTransactionQueries = (
  rowCountByFragment: Record<string, number> = {},
  rowsByFragment: Record<string, unknown[]> = {},
) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const fragment = Object.keys(rowCountByFragment).find(f => sql.includes(f));
      const rowsFragment = Object.keys(rowsByFragment).find(f => sql.includes(f));
      const rows = rowsFragment ? rowsByFragment[rowsFragment] : [];
      return { rows, rowCount: fragment ? rowCountByFragment[fragment] : 1 };
    },
  }));
  return calls;
};

describe('syncEmployeesLogic — увольнения', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.isConfigured.mockResolvedValue(true);
    h.getSigurSettings.mockResolvedValue({ archiveDepartmentId: ARCHIVE_SIGUR });
    h.getKnownArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
    h.ensureLocalArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
    h.changeDepartment.mockResolvedValue('applied');
    h.changePosition.mockResolvedValue(undefined);
    h.batchMove.mockResolvedValue({ moved: 1, requested: 1, failedIds: [] });
    h.execute.mockResolvedValue(1);
    // По умолчанию точечная проба: карточки нет (404).
    h.probe.mockResolvedValue({ state: 'deleted', departmentId: null });
    h.openDismiss.mockImplementation(async (input: { employeeId: number }) => ({ id: `op-${input.employeeId}`, kind: 'dismiss', employee_id: input.employeeId }));
    h.executeOp.mockResolvedValue({ id: 0 });
    h.openRepair.mockResolvedValue(null);
    h.resetRehireMove.mockResolvedValue(true);
    collectTransactionQueries();
  });

  const sigurCard = (over: Record<string, unknown> = {}) => ({
    id: 91831, name: 'Аллакулов Улугбек Туракулович', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '05510', ...over,
  });
  const OTHER_CARD = { id: 777, name: 'Иванов Иван Иванович', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '1' };

  it('уволенный, которого Sigur отдаёт в бригаде: без реактивации, с фиксацией расхождения', async () => {
    setupQueries({ employees: [dbEmployee({ employment_status: 'fired', org_department_id: ARCHIVE_LOCAL, dismissal_date: '2026-08-12' })] });
    h.getEmployeesCached.mockResolvedValue([sigurCard()]);

    const result = await syncEmployeesLogic();

    expect(result.fired_mismatch_detected).toBe(1);
    // Расхождение устранено переносом в архивную папку Sigur тем же прогоном.
    expect(result.fired_mismatch_unresolved).toBe(0);
    expect(h.batchMove).toHaveBeenCalledWith([91831], ARCHIVE_SIGUR, undefined);
    expect(h.changeDepartment).not.toHaveBeenCalled();
    expect(h.changePosition).not.toHaveBeenCalled();
    expect(h.openDismiss).not.toHaveBeenCalled();
    // Ни один UPDATE не выставляет сотруднику active.
    const statusUpdates = h.execute.mock.calls.filter(([sql]) => String(sql).includes('employment_status'));
    expect(statusUpdates).toHaveLength(0);
    expect(h.auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'SIGUR_SYNC_FIRED_MISMATCH' }));
  });

  it('пустая архивная настройка: реактивации по-прежнему нет, расхождение остаётся нерешённым', async () => {
    h.getSigurSettings.mockResolvedValue({ archiveDepartmentId: null });
    setupQueries({ employees: [dbEmployee({ employment_status: 'fired', org_department_id: ARCHIVE_LOCAL, dismissal_date: '2026-08-12' })] });
    h.getEmployeesCached.mockResolvedValue([sigurCard()]);

    const result = await syncEmployeesLogic();

    expect(result.fired_mismatch_detected).toBe(1);
    expect(result.fired_mismatch_unresolved).toBe(1);
    expect(h.changeDepartment).not.toHaveBeenCalled();
    expect(h.batchMove).not.toHaveBeenCalled();
  });

  it('уволенный с прежним отделом, но новой должностью в Sigur: должность не меняется', async () => {
    setupQueries({
      employees: [dbEmployee({
        employment_status: 'fired',
        org_department_id: ARCHIVE_LOCAL,
        position_id: 'position-old',
        dismissal_date: '2026-08-12',
      })],
      freshStatus: 'fired',
      freshDeptId: ARCHIVE_LOCAL,
    });
    // Sigur отдаёт того же архивного отдела, но с другой должностью.
    h.getEmployeesCached.mockResolvedValue([sigurCard({ departmentId: ARCHIVE_SIGUR })]);

    await syncEmployeesLogic();

    expect(h.changePosition).not.toHaveBeenCalled();
    expect(h.changeDepartment).not.toHaveBeenCalled();
    expect(h.openDismiss).not.toHaveBeenCalled();
  });

  // ─── Увольнение по архивной папке Sigur (archive-fire) ───

  it('карточка в архивной папке: увольнение — durable-операция source=sigur_archive по свежей версии', async () => {
    setupQueries({
      employees: [dbEmployee({ employment_status: 'active', org_department_id: BRIGADE_LOCAL, dismissal_date: null })],
      freshStatus: 'active',
      freshDeptId: BRIGADE_LOCAL,
    });
    h.getEmployeesCached.mockResolvedValue([sigurCard({ departmentId: ARCHIVE_SIGUR })]);
    h.probe.mockResolvedValue({ state: 'archived', departmentId: ARCHIVE_SIGUR });

    const result = await syncEmployeesLogic();

    expect(result.archive_fired).toBe(1);
    expect(h.probe).toHaveBeenCalledWith(91831, ARCHIVE_SIGUR, undefined);
    expect(h.openDismiss).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 128,
      source: 'sigur_archive',
      sigurSteps: 'access_only',
      expectedRevision: 3,
      dismissalDate: mskToday(),
      effectiveDate: mskToday(),
      createdBy: null,
    }));
    expect(h.executeOp).toHaveBeenCalledWith(expect.objectContaining({ id: 'op-128' }), undefined);
    // Синк сам не трогает историю/employees/техдоступ — всё внутри операции.
    expect(h.changeDepartment).not.toHaveBeenCalled();
    expect(h.upsertAccess).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalledWith(expect.stringContaining('employee_dismissal_events'), expect.anything());
    const statusUpdates = h.execute.mock.calls.filter(([sql]) => String(sql).includes("employment_status = 'fired'"));
    expect(statusUpdates).toHaveLength(0);
  });

  it('карточка в архиве по выгрузке, но точечно — рабочий отдел (устаревшая выгрузка): не увольняем', async () => {
    setupQueries({
      employees: [dbEmployee({ employment_status: 'active', org_department_id: BRIGADE_LOCAL, dismissal_date: null })],
      freshStatus: 'active',
      freshDeptId: BRIGADE_LOCAL,
    });
    h.getEmployeesCached.mockResolvedValue([sigurCard({ departmentId: ARCHIVE_SIGUR })]);
    h.probe.mockResolvedValue({ state: 'working', departmentId: BRIGADE_SIGUR });

    const result = await syncEmployeesLogic();

    expect(result.archive_fired).toBe(0);
    expect(result.archive_fire_skipped_stale).toBe(1);
    expect(h.openDismiss).not.toHaveBeenCalled();
    expect(h.changeDepartment).not.toHaveBeenCalled();
    expect(result.errors).toHaveLength(0);
  });

  it('точечная проба не удалась (timeout/5xx): консервативный skip с ошибкой в отчёте', async () => {
    setupQueries({
      employees: [dbEmployee({ employment_status: 'active', org_department_id: BRIGADE_LOCAL, dismissal_date: null })],
      freshStatus: 'active',
      freshDeptId: BRIGADE_LOCAL,
    });
    h.getEmployeesCached.mockResolvedValue([sigurCard({ departmentId: ARCHIVE_SIGUR })]);
    h.probe.mockResolvedValue({ state: 'unknown', departmentId: null, error: 'timeout' });

    const result = await syncEmployeesLogic();

    expect(h.openDismiss).not.toHaveBeenCalled();
    expect(result.errors.some(e => e.includes('archive-fire') && e.includes('unknown'))).toBe(true);
  });

  it('pending-операция (rehire в полёте) защищает от увольнения по архивной папке', async () => {
    setupQueries({
      employees: [dbEmployee({ employment_status: 'active', org_department_id: BRIGADE_LOCAL, dismissal_date: null })],
      freshStatus: 'active',
      freshDeptId: BRIGADE_LOCAL,
    });
    h.getEmployeesCached.mockResolvedValue([sigurCard({ departmentId: ARCHIVE_SIGUR })]);
    h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, guardOf({
      employee_id: id, pending_kind: 'rehire', pending_operation_id: 'op-rehire',
    })])));

    const result = await syncEmployeesLogic();

    expect(result.archive_fire_skipped_protected).toBe(1);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.openDismiss).not.toHaveBeenCalled();
  });

  it('недавний rehire (< 60 мин) защищает от увольнения по архивной папке (лаг Sigur)', async () => {
    setupQueries({
      employees: [dbEmployee({ employment_status: 'active', org_department_id: BRIGADE_LOCAL, dismissal_date: null })],
      freshStatus: 'active',
      freshDeptId: BRIGADE_LOCAL,
    });
    h.getEmployeesCached.mockResolvedValue([sigurCard({ departmentId: ARCHIVE_SIGUR })]);
    h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, guardOf({
      employee_id: id, last_rehire_applied_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    })])));

    const result = await syncEmployeesLogic();

    expect(result.archive_fire_skipped_protected).toBe(1);
    expect(h.openDismiss).not.toHaveBeenCalled();
  });

  it('гонка: версия ушла между решением и открытием операции (CAS) → skip без ошибки', async () => {
    setupQueries({
      employees: [dbEmployee({ employment_status: 'active', org_department_id: BRIGADE_LOCAL, dismissal_date: null })],
      freshStatus: 'active',
      freshDeptId: BRIGADE_LOCAL,
    });
    h.getEmployeesCached.mockResolvedValue([sigurCard({ departmentId: ARCHIVE_SIGUR })]);
    h.probe.mockResolvedValue({ state: 'archived', departmentId: ARCHIVE_SIGUR });
    h.openDismiss.mockRejectedValue(new LifecycleOperationError(409, 'Состояние изменилось', 'STATE_CHANGED'));

    const result = await syncEmployeesLogic();

    expect(result.archive_fired).toBe(0);
    expect(result.archive_fire_skipped_stale).toBe(1);
    expect(h.executeOp).not.toHaveBeenCalled();
    expect(result.errors).toHaveLength(0);
  });

  // ─── Auto-fire: карточки нет в выгрузке ───

  it('auto-fire не трогает сотрудника с уже назначенным увольнением', async () => {
    setupQueries({
      employees: [
        dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: '2026-08-20' }),
        dbEmployee({ id: 922, sigur_employee_id: 125204, dismissal_date: '2026-08-12' }),
      ],
    });
    // Обоих нет в выгрузке Sigur, но у обоих назначено увольнение.
    h.getEmployeesCached.mockResolvedValue([OTHER_CARD]);

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(0);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.openDismiss).not.toHaveBeenCalled();
  });

  it('auto-fire, первый такт: 404 только ставит метку отсутствия — увольнения нет', async () => {
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null })] });
    h.getEmployeesCached.mockResolvedValue([OTHER_CARD]);

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(0);
    expect(result.auto_fire_deferred).toBe(1);
    expect(h.probe).toHaveBeenCalledWith(125203, ARCHIVE_SIGUR, undefined);
    expect(h.openDismiss).not.toHaveBeenCalled();
    const mark = h.execute.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO employee_sigur_absence_marks'));
    expect(mark).toBeDefined();
    expect(mark![1]).toEqual([921, 125203, 3]);
  });

  it('auto-fire, второй такт: старая метка с той же версией + повторный 404 → увольнение операцией sigur_missing', async () => {
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null })] });
    h.getEmployeesCached.mockResolvedValue([OTHER_CARD]);
    h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, guardOf({
      employee_id: id,
      absence_revision: 3,
      absence_first_seen_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      absence_strikes: 1,
    })])));

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(1);
    expect(result.auto_fire_deferred).toBe(0);
    expect(h.openDismiss).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: 921,
      source: 'sigur_missing',
      sigurSteps: 'none',
      expectedRevision: 3,
      dismissalDate: mskToday(),
      effectiveDate: mskToday(),
    }));
    expect(h.executeOp).toHaveBeenCalledWith(expect.objectContaining({ id: 'op-921' }), undefined);
    const del = h.execute.mock.calls.find(([sql, params]) =>
      String(sql).includes('DELETE FROM employee_sigur_absence_marks WHERE employee_id = $1') && (params as unknown[])[0] === 921);
    expect(del).toBeDefined();
  });

  it('auto-fire: метка есть, но версия сменилась (был lifecycle-переход) → снова первый такт', async () => {
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null, lifecycle_revision: 4 })] });
    h.getEmployeesCached.mockResolvedValue([OTHER_CARD]);
    h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, guardOf({
      employee_id: id,
      lifecycle_revision: 4,
      absence_revision: 3,
      absence_first_seen_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    })])));

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(0);
    expect(result.auto_fire_deferred).toBe(1);
    expect(h.openDismiss).not.toHaveBeenCalled();
  });

  it('auto-fire: метка слишком свежая (тот же прогон) → ждём следующего прогона', async () => {
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null })] });
    h.getEmployeesCached.mockResolvedValue([OTHER_CARD]);
    h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, guardOf({
      employee_id: id, absence_revision: 3, absence_first_seen_at: new Date(Date.now() - 10_000).toISOString(),
    })])));

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(0);
    expect(result.auto_fire_deferred).toBe(1);
  });

  it('auto-fire: точечно карточка найдена (выпала из выгрузки на границе страницы) → не увольняем, метка снята', async () => {
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null })] });
    h.getEmployeesCached.mockResolvedValue([OTHER_CARD]);
    h.probe.mockResolvedValue({ state: 'working', departmentId: BRIGADE_SIGUR });

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(0);
    expect(result.auto_fire_skipped_present).toBe(1);
    expect(h.openDismiss).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM employee_sigur_absence_marks WHERE employee_id = $1'), [921]);
  });

  it('auto-fire: проба не удалась (unknown) → skip с ошибкой в отчёте, метка не ставится', async () => {
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null })] });
    h.getEmployeesCached.mockResolvedValue([OTHER_CARD]);
    h.probe.mockResolvedValue({ state: 'unknown', departmentId: null, error: 'timeout' });

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(0);
    expect(result.auto_fire_skipped_present).toBe(1);
    expect(result.errors.some(e => e.includes('auto-fire 921'))).toBe(true);
    expect(h.execute).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO employee_sigur_absence_marks'), expect.anything());
  });

  it('auto-fire: pending-операция защищает даже при подтверждённом 404', async () => {
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null })] });
    h.getEmployeesCached.mockResolvedValue([OTHER_CARD]);
    h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, guardOf({
      employee_id: id,
      pending_kind: 'rehire',
      pending_operation_id: 'op-r',
      absence_revision: 3,
      absence_first_seen_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    })])));

    const result = await syncEmployeesLogic();

    expect(result.auto_fire_skipped_protected).toBe(1);
    expect(h.openDismiss).not.toHaveBeenCalled();
  });

  it('auto-fire: версия ушла при открытии операции (CAS) → skip без ошибки', async () => {
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null })] });
    h.getEmployeesCached.mockResolvedValue([OTHER_CARD]);
    h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, guardOf({
      employee_id: id, absence_revision: 3, absence_first_seen_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    })])));
    h.openDismiss.mockRejectedValue(new LifecycleOperationError(409, 'Состояние изменилось', 'STATE_CHANGED'));

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(0);
    expect(result.auto_fire_skipped_stale).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('auto-fire: ошибка исполнения операции попадает в отчёт, сотрудник не считается уволенным', async () => {
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null })] });
    h.getEmployeesCached.mockResolvedValue([OTHER_CARD]);
    h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, guardOf({
      employee_id: id, absence_revision: 3, absence_first_seen_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    })])));
    h.executeOp.mockRejectedValue(new Error('insert failed'));

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(0);
    expect(result.errors.some(e => e.includes('auto-fire 921'))).toBe(true);
  });

  // ─── Перенос fired → архив Sigur: гонка с rehire ───

  it('fired→archive: сотрудник с pending rehire не переносится в архив Sigur', async () => {
    setupQueries({ employees: [dbEmployee({ employment_status: 'fired', org_department_id: ARCHIVE_LOCAL, dismissal_date: '2026-08-12' })] });
    h.getEmployeesCached.mockResolvedValue([sigurCard()]);
    h.getGuards.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, guardOf({
      employee_id: id, employment_status: 'fired', pending_kind: 'rehire', pending_operation_id: 'op-r',
    })])));

    const result = await syncEmployeesLogic();

    expect(h.batchMove).not.toHaveBeenCalled();
    expect(result.archive_move_skipped_protected).toBe(1);
  });

  it('fired→archive обогнал rehire: post-check открывает repair_sigur в цель rehire-операции, не в org_department_id', async () => {
    setupQueries({ employees: [dbEmployee({ employment_status: 'fired', org_department_id: ARCHIVE_LOCAL, dismissal_date: '2026-08-12' })] });
    h.getEmployeesCached.mockResolvedValue([sigurCard()]);
    let guardCalls = 0;
    h.getGuards.mockImplementation(async (ids: number[]) => {
      guardCalls++;
      return new Map(ids.map(id => [id, guardOf(guardCalls === 1
        ? { employee_id: id, employment_status: 'fired', lifecycle_revision: 5 }
        : {
          employee_id: id, employment_status: 'active', lifecycle_revision: 6,
          last_rehire_applied_at: new Date().toISOString(),
          last_rehire_target_department_id: BRIGADE_LOCAL,
          last_rehire_target_sigur_department_id: BRIGADE_SIGUR,
        })]));
    });
    h.openRepair.mockResolvedValue({ id: 'op-repair', kind: 'repair_sigur', employee_id: 128 });

    const result = await syncEmployeesLogic();

    expect(h.batchMove).toHaveBeenCalledTimes(1);
    expect(h.openRepair).toHaveBeenCalledWith({
      employeeId: 128,
      targetDepartmentId: BRIGADE_LOCAL,
      targetSigurDepartmentId: BRIGADE_SIGUR,
      createdBy: null,
    });
    expect(h.executeOp).toHaveBeenCalledWith(expect.objectContaining({ id: 'op-repair' }), undefined);
    expect(result.archive_move_compensated).toBe(1);
  });

  it('fired→archive обогнал rehire, который ещё pending: сбрасываем шаг PUT у операции, repair не открываем', async () => {
    setupQueries({ employees: [dbEmployee({ employment_status: 'fired', org_department_id: ARCHIVE_LOCAL, dismissal_date: '2026-08-12' })] });
    h.getEmployeesCached.mockResolvedValue([sigurCard()]);
    let guardCalls = 0;
    h.getGuards.mockImplementation(async (ids: number[]) => {
      guardCalls++;
      return new Map(ids.map(id => [id, guardOf(guardCalls === 1
        ? { employee_id: id, employment_status: 'fired', lifecycle_revision: 5 }
        : { employee_id: id, employment_status: 'fired', lifecycle_revision: 5, pending_kind: 'rehire', pending_operation_id: 'op-r' })]));
    });

    const result = await syncEmployeesLogic();

    expect(h.resetRehireMove).toHaveBeenCalledWith('op-r');
    expect(h.openRepair).not.toHaveBeenCalled();
    expect(result.archive_move_compensated).toBe(1);
  });

  it('fired→archive: ошибка компенсации попадает в отчёт', async () => {
    setupQueries({ employees: [dbEmployee({ employment_status: 'fired', org_department_id: ARCHIVE_LOCAL, dismissal_date: '2026-08-12' })] });
    h.getEmployeesCached.mockResolvedValue([sigurCard()]);
    let guardCalls = 0;
    h.getGuards.mockImplementation(async (ids: number[]) => {
      guardCalls++;
      return new Map(ids.map(id => [id, guardOf(guardCalls === 1
        ? { employee_id: id, employment_status: 'fired', lifecycle_revision: 5 }
        : { employee_id: id, employment_status: 'active', lifecycle_revision: 6 })]));
    });
    // Rehire через операции не было и текущий отдел не резолвится → компенсация невозможна.
    h.queryOne.mockImplementation(async () => null);

    const result = await syncEmployeesLogic();

    expect(result.errors.some(e => e.includes('fired->archive compensation 128'))).toBe(true);
  });
});

/**
 * Смена карточки Sigur у одного человека (инцидент 14.08.2026): старая карточка
 * уходит в архивную папку, новая появляется в рабочем отделе. Без гарда синк
 * оформлял это как «увольнение + приём нового» и порождал дубль в табеле.
 */
describe('syncEmployeesLogic — смена карточки Sigur (rebind)', () => {
  const OLD_SIGUR = 143276;
  const NEW_SIGUR = 125698;
  const NAME = 'Шарипов Исмоилджон Нуруллоевич';

  const employee = (over: Partial<IDbEmployee> = {}): IDbEmployee => dbEmployee({
    id: 2568,
    sigur_employee_id: OLD_SIGUR,
    employment_status: 'active',
    org_department_id: BRIGADE_LOCAL,
    tab_number: '05919',
    full_name: NAME,
    last_name: 'Шарипов',
    first_name: 'Исмоилджон',
    middle_name: 'Нуруллоевич',
    dismissal_date: null,
    ...over,
  });

  const card = (sigurId: number, deptId: number, tabId: string | null = null) => ({
    id: sigurId, name: NAME, departmentId: deptId, positionId: 501, position: 'Маляр', tabId,
  });

  /** Строка сотрудника, которую отдаёт SELECT … FOR UPDATE внутри rebind-транзакции. */
  const freshRow = (over: Record<string, unknown> = {}) => ({
    'FOR UPDATE': [{
      sigur_employee_id: OLD_SIGUR,
      employment_status: 'active',
      dismissal_date: null,
      dismissal_apply_started_at: null,
      org_department_id: BRIGADE_LOCAL,
      position_id: 'position-1',
      department_locked: false,
      ...over,
    }],
  });

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.isConfigured.mockResolvedValue(true);
    h.getSigurSettings.mockResolvedValue({ archiveDepartmentId: ARCHIVE_SIGUR });
    h.getKnownArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
    h.ensureLocalArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
    h.changeDepartment.mockResolvedValue('applied');
    h.changePosition.mockResolvedValue(undefined);
    h.batchMove.mockResolvedValue({ moved: 0, requested: 0, failedIds: [] });
    h.execute.mockResolvedValue(1);
    collectTransactionQueries({}, freshRow());
  });

  const insertCalls = () => h.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO employees'));

  it('переносит привязку на новую карточку, без вставки и без увольнения', async () => {
    const txCalls = collectTransactionQueries({}, freshRow());
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(1);
    expect(result.imported).toBe(0);
    expect(insertCalls()).toHaveLength(0);

    const rebindUpdate = txCalls.find(c => c.sql.includes('SET sigur_employee_id'));
    expect(rebindUpdate).toBeDefined();
    expect(rebindUpdate!.params[0]).toBe(NEW_SIGUR);
    expect(rebindUpdate!.params[1]).toBe(BRIGADE_LOCAL);
    // Увольнения в этот тик нет — ни в транзакции, ни прямым update.
    expect(txCalls.some(c => c.sql.includes("employment_status = 'fired'"))).toBe(false);
    expect(h.execute.mock.calls.filter(([sql]) => String(sql).includes('employment_status'))).toHaveLength(0);
    // Технический доступ пишется той же транзакцией.
    expect(txCalls.some(c => c.sql.includes('employee_department_access'))).toBe(true);
    expect(h.auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'SIGUR_SYNC_CARD_REBIND' }));
  });

  it('обратный порядок карточек в выгрузке даёт тот же результат', async () => {
    const txCalls = collectTransactionQueries({}, freshRow());
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(NEW_SIGUR, BRIGADE_SIGUR),
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(1);
    expect(insertCalls()).toHaveLength(0);
    expect(txCalls.some(c => c.sql.includes('SET sigur_employee_id'))).toBe(true);
  });

  it('повторный тик после rebind: изменений нет', async () => {
    setupQueries({ employees: [employee({ sigur_employee_id: NEW_SIGUR })] });
    h.getEmployeesCached.mockResolvedValue([card(NEW_SIGUR, BRIGADE_SIGUR)]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(result.imported).toBe(0);
    expect(insertCalls()).toHaveLength(0);
  });

  it('две новые карточки с тем же ФИО: вставки нет, обе в unmatched', async () => {
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
      card(NEW_SIGUR + 1, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId).sort()).toEqual([NEW_SIGUR, NEW_SIGUR + 1].sort());
  });

  it('две архивные карточки с тем же ФИО: новая уходит в unmatched', async () => {
    setupQueries({ employees: [employee(), employee({ id: 2569, sigur_employee_id: OLD_SIGUR + 1 })] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(OLD_SIGUR + 1, ARCHIVE_SIGUR),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('кандидат уже уволен: автоматической реактивации нет, новая карточка в unmatched', async () => {
    setupQueries({
      employees: [employee({ employment_status: 'fired', org_department_id: ARCHIVE_LOCAL, dismissal_date: '2026-08-14' })],
    });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
    expect(h.execute.mock.calls.filter(([sql]) => String(sql).includes("employment_status = 'active'"))).toHaveLength(0);
  });

  it('кандидат с назначенным увольнением: rebind не делаем', async () => {
    setupQueries({ employees: [employee({ dismissal_date: '2026-08-20' })] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('department_locked и другой отдел: в unmatched, сотрудник не остаётся в «Уволенных»', async () => {
    setupQueries({ employees: [employee({ department_locked: true, org_department_id: 'other-dept-uuid' })] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('состояние разошлось (увольнение применилось параллельно): изменений нет, карточка в unmatched', async () => {
    collectTransactionQueries({}, freshRow({ employment_status: 'fired', dismissal_date: '2026-08-14' }));
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('ошибка транзакции rebind: пара в unmatched, прогон продолжается', async () => {
    h.withTransaction.mockImplementation(async () => { throw new Error('deadlock detected'); });
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(result.errors.some(e => e.includes('card rebind 2568'))).toBe(true);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('архивный локальный профиль не перепривязывается и не порождает второй профиль', async () => {
    const txCalls = collectTransactionQueries({}, freshRow());
    setupQueries({ employees: [employee({ is_archived: true })] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(txCalls.some(c => c.sql.includes('SET sigur_employee_id'))).toBe(false);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('профиль стал архивным между планом и применением: rebind не выполняется', async () => {
    const txCalls = collectTransactionQueries({}, freshRow({ is_archived: true }));
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(txCalls.some(c => c.sql.includes('SET sigur_employee_id'))).toBe(false);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('portal-only привязка: пустой tabId не затирает табельный номер', async () => {
    setupQueries({ employees: [] });
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM employees') && sql.includes('sigur_employee_id IS NOT NULL') && sql.includes('LIMIT')) return [];
      if (sql.includes('sigur_employee_id IS NULL')) {
        return [{
          id: 2568, full_name: NAME, last_name: 'Шарипов', first_name: 'Исмоилджон', middle_name: 'Нуруллоевич',
          org_department_id: BRIGADE_LOCAL, position_id: 'position-1', tab_number: '05919',
          department_locked: false, name_locked: false,
        }];
      }
      if (sql.includes('FROM org_departments') && sql.includes('sigur_department_id IS NOT NULL')) {
        return [
          { id: ARCHIVE_LOCAL, sigur_department_id: ARCHIVE_SIGUR, name: 'Уволенные', is_active: true },
          { id: BRIGADE_LOCAL, sigur_department_id: BRIGADE_SIGUR, name: 'бр.Прозорова А.В.', is_active: true },
        ];
      }
      if (sql.includes('parent_id') && sql.includes('org_departments')) {
        return [{ id: ARCHIVE_LOCAL, parent_id: null }, { id: BRIGADE_LOCAL, parent_id: null }];
      }
      if (sql.includes('FROM positions')) return [{ id: 'position-1', sigur_position_id: 501, name: 'Маляр' }];
      return [];
    });
    h.getEmployeesCached.mockResolvedValue([card(NEW_SIGUR, BRIGADE_SIGUR, null)]);

    await syncEmployeesLogic();

    const tabUpdates = h.execute.mock.calls.filter(([sql]) => String(sql).includes('tab_number'));
    expect(tabUpdates).toHaveLength(0);
    // Привязка к существующей портальной записи всё равно произошла.
    expect(h.execute.mock.calls.some(([sql]) => String(sql).includes('sigur_employee_id'))).toBe(true);
  });

  it('пустой tabId из Sigur не затирает табельный номер', async () => {
    setupQueries({ employees: [employee({ sigur_employee_id: NEW_SIGUR })] });
    h.getEmployeesCached.mockResolvedValue([card(NEW_SIGUR, BRIGADE_SIGUR, null)]);

    await syncEmployeesLogic();

    const tabUpdates = h.execute.mock.calls.filter(([sql]) => String(sql).includes('tab_number'));
    expect(tabUpdates).toHaveLength(0);
  });

  it('обычный новый сотрудник без пары: вставка как раньше', async () => {
    setupQueries({ employees: [employee({ sigur_employee_id: NEW_SIGUR })] });
    h.getEmployeesCached.mockResolvedValue([
      card(NEW_SIGUR, BRIGADE_SIGUR),
      { id: 777, name: 'Иванов Иван Иванович', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '1' },
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(1);
  });
});

/**
 * Смена ФИО в Sigur должна доезжать до профиля портала (user_profiles.full_name):
 * ЛК показывает именно его, и до 25.08.2026 фамилия там оставалась девичьей.
 */
describe('syncEmployeesLogic — зеркалирование ФИО в профиль портала', () => {
  const RENAMED = 'Чернышева Екатерина Андреевна';

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.isConfigured.mockResolvedValue(true);
    h.getSigurSettings.mockResolvedValue({ archiveDepartmentId: ARCHIVE_SIGUR });
    h.getKnownArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
    h.ensureLocalArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
    h.changeDepartment.mockResolvedValue('applied');
    h.changePosition.mockResolvedValue(undefined);
    h.batchMove.mockResolvedValue({ moved: 0, requested: 0, failedIds: [] });
    h.execute.mockResolvedValue(1);
  });

  /** Активный сотрудник в бригаде, в Sigur — с новой фамилией. */
  const setupRename = (over: Partial<IDbEmployee> = {}) => {
    setupQueries({ employees: [dbEmployee({ employment_status: 'active', ...over })] });
    h.getEmployeesCached.mockResolvedValue([
      { id: 91831, name: RENAMED, departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '05510' },
    ]);
  };

  it('новая фамилия: карточка и профиль обновляются в одной транзакции', async () => {
    const calls = collectTransactionQueries();
    setupRename();

    const result = await syncEmployeesLogic();

    expect(result.updated).toBe(1);
    expect(h.withTransaction).toHaveBeenCalledTimes(1);

    const cardUpdate = calls.find(c => c.sql.includes('UPDATE employees SET'));
    expect(cardUpdate?.params).toContain(RENAMED);
    // Зеркало идёт тем же клиентом транзакции, имя берётся из employees.
    const profileUpdate = calls.find(c => c.sql.includes('UPDATE user_profiles'));
    expect(profileUpdate).toBeDefined();
    expect(profileUpdate?.params).toEqual([128]);
    // Вне транзакции UPDATE карточки не дублируется.
    expect(h.execute.mock.calls.some(([sql]) => String(sql).includes('UPDATE employees'))).toBe(false);
  });

  it('name_locked: ФИО не трогаем, профиль тоже', async () => {
    const calls = collectTransactionQueries();
    setupRename({ name_locked: true });

    await syncEmployeesLogic();

    expect(calls.some(c => c.sql.includes('UPDATE user_profiles'))).toBe(false);
    expect(h.execute.mock.calls.some(([, params]) => (params as unknown[])?.includes(RENAMED))).toBe(false);
  });

  it('падение зеркала откатывает правку карточки и попадает в errors', async () => {
    h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({
      query: async (sql: string) => {
        if (sql.includes('UPDATE user_profiles')) throw new Error('deadlock detected');
        return { rows: [], rowCount: 1 };
      },
    }));
    setupRename();

    const result = await syncEmployeesLogic();

    expect(result.updated).toBe(0);
    expect(result.errors.join(' ')).toContain('deadlock detected');
  });

  it('правка без смены ФИО идёт мимо транзакции', async () => {
    collectTransactionQueries();
    setupQueries({ employees: [dbEmployee({ employment_status: 'active', tab_number: '00001' })] });
    h.getEmployeesCached.mockResolvedValue([
      { id: 91831, name: 'Аллакулов Улугбек Туракулович', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '05510' },
    ]);

    await syncEmployeesLogic();

    expect(h.withTransaction).not.toHaveBeenCalled();
    expect(h.execute.mock.calls.some(([sql]) => String(sql).includes('UPDATE employees'))).toBe(true);
  });
});
