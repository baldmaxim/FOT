import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';

/**
 * Durable-операции lifecycle (миграция 261): открытие под CAS, lease-протокол,
 * идемпотентные шаги, финализация по lifecycle_revision, компенсация и пробы.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  txQuery: vi.fn(),
  isConfigured: vi.fn(),
  updateEmployee: vi.fn(),
  blockEmployee: vi.fn(),
  unblockEmployee: vi.fn(),
  getEmployeeById: vi.fn(),
  getDepartmentById: vi.fn(),
  invalidateEmployeeCache: vi.fn(),
  getSigurSettings: vi.fn(),
  changeDepartment: vi.fn(),
  ensureLocalArchive: vi.fn(),
  ensureArchiveSigur: vi.fn(),
  syncLinked: vi.fn(),
  upsertAccess: vi.fn(),
  deactivateAccess: vi.fn(),
  invalidate: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query: h.txQuery }),
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    isConfigured: h.isConfigured,
    updateEmployee: h.updateEmployee,
    blockEmployee: h.blockEmployee,
    unblockEmployee: h.unblockEmployee,
    getEmployeeById: h.getEmployeeById,
    getDepartmentById: h.getDepartmentById,
    invalidateEmployeeCache: h.invalidateEmployeeCache,
  },
}));
vi.mock('./settings.service.js', () => ({
  settingsService: { getSigurConnectionSettings: h.getSigurSettings },
}));
vi.mock('./employee-changes.service.js', () => ({
  employeeChangesService: { changeDepartment: h.changeDepartment },
}));
vi.mock('./employee-archive-department.service.js', () => ({
  ensureLocalArchiveDepartment: h.ensureLocalArchive,
}));
vi.mock('./sigur-linked-employees.service.js', () => ({
  ensureArchiveSigurDepartment: h.ensureArchiveSigur,
  syncLinkedEmployeeFromSigur: h.syncLinked,
}));
vi.mock('./employee-department-access.service.js', () => ({
  upsertTechnicalDepartmentAccess: h.upsertAccess,
  deactivateAllDepartmentAccessForEmployee: h.deactivateAccess,
}));
vi.mock('./employee-cache.service.js', () => ({ employeeCache: { invalidate: h.invalidate } }));
vi.mock('./sigur-sync-shared.js', () => ({
  normalizeEmployee: (raw: Record<string, unknown>) => ({
    id: raw.id, name: String(raw.name ?? ''), departmentId: raw.departmentId,
    positionId: raw.positionId, position: String(raw.position ?? ''), tabId: String(raw.tabId ?? ''),
  }),
}));
vi.mock('@sentry/node', () => ({
  captureMessage: h.captureMessage,
  captureException: vi.fn(),
}));

import {
  DismissalSigurError,
  LifecycleOperationError,
  acquireLease,
  isLifecycleProtected,
  mapWithConcurrency,
  openDismissOperation,
  openRehireOperation,
  openRepairOperation,
  probeSigurCard,
  resumeExpiredOperations,
  runOperation,
  type ILifecycleOperation,
} from './employee-lifecycle-operations.service.js';

const OWNER = 'host:1:abc:1';

const baseOp = (over: Partial<ILifecycleOperation> = {}): ILifecycleOperation => ({
  id: 'op-1',
  employee_id: 77,
  kind: 'dismiss',
  status: 'pending',
  source: 'manual',
  base_revision: 3,
  sigur_employee_id: 555,
  from_department_id: 'dept-1',
  target_department_id: 'arch-1',
  target_sigur_department_id: null,
  effective_date: '2026-05-21',
  dismissal_date: '2026-05-20',
  sigur_move_required: true,
  sigur_access_required: true,
  sigur_moved: false,
  sigur_access_toggled: false,
  sigur_detached: false,
  lease_owner: OWNER,
  lease_expires_at: null,
  attempts: 1,
  last_error: null,
  created_by: 'admin-1',
  created_at: '2026-05-20T10:00:00Z',
  applied_at: null,
  ...over,
});

type TxRoute = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number } | undefined;

/** Транзакционный клиент: маршрутизация по фрагментам SQL, по умолчанию 1 строка. */
const routeTx = (route: TxRoute) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  h.txQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return route(sql, params) ?? { rows: [], rowCount: 1 };
  });
  return calls;
};

/** queryOne для шагов: UPDATE employee_lifecycle_operations под lease → id (lease жив). */
const routeStepWrites = (extra?: (sql: string, params: unknown[]) => unknown) => {
  h.queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('UPDATE employee_lifecycle_operations') && sql.includes('lease_owner = $')) return { id: 'op-1' };
    if (extra) return extra(sql, params);
    return null;
  });
};

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.isConfigured.mockResolvedValue(true);
  h.execute.mockResolvedValue(undefined);
  h.changeDepartment.mockResolvedValue('applied');
  h.ensureLocalArchive.mockResolvedValue({ id: 'arch-1', name: 'Уволенные', source: 'sigur' });
  h.ensureArchiveSigur.mockResolvedValue({ sigurDepartmentId: 9, localDepartmentId: 'arch-1', name: 'Уволенные' });
  h.getSigurSettings.mockResolvedValue({ archiveDepartmentId: 9 });
  h.getEmployeeById.mockResolvedValue({ id: 555, departmentId: 42 });
  routeStepWrites();
});

describe('openDismissOperation', () => {
  const lockRow = (over: Record<string, unknown> = {}) => ({
    employment_status: 'active', lifecycle_revision: 3, org_department_id: 'dept-1', sigur_employee_id: 555, dismissal_date: null, ...over,
  });

  it('ручное: lock → нет pending → CAS-claim → INSERT pending с полным payload одной транзакцией', async () => {
    const calls = routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [lockRow()], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO employee_lifecycle_operations')) return { rows: [baseOp()], rowCount: 1 };
      return undefined;
    });

    const op = await openDismissOperation({
      employeeId: 77, dismissalDate: '2026-05-20', source: 'manual', createdBy: 'admin-1', sigurSteps: 'full',
    });

    expect(op.id).toBe('op-1');
    const claim = calls.find(c => c.sql.includes('dismissal_apply_started_at = now()'));
    expect(claim).toBeDefined();
    expect(claim!.sql).toContain("employment_status = 'active'");
    expect(claim!.sql).toMatch(/dismissal_apply_started_at IS NULL\s+OR dismissal_apply_started_at < now\(\)/);
    expect(claim!.params).toEqual([77, '2026-05-20', '30']);

    const insert = calls.find(c => c.sql.includes('INSERT INTO employee_lifecycle_operations'));
    expect(insert).toBeDefined();
    // employee, kind, source, base_revision, sigur_employee_id, from, target, target_sigur, effective, dismissal, move, access, created_by
    expect(insert!.params).toEqual([77, 'dismiss', 'manual', 3, 555, 'dept-1', 'arch-1', null, '2026-05-21', '2026-05-20', true, true, 'admin-1']);
  });

  it('claim не захвачен (чужой активный) → 409 OPERATION_IN_PROGRESS, INSERT не выполняется', async () => {
    const calls = routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [lockRow()], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: [], rowCount: 0 };
      if (sql.includes('dismissal_apply_started_at = now()')) return { rows: [], rowCount: 0 };
      return undefined;
    });

    await expect(openDismissOperation({
      employeeId: 77, dismissalDate: '2026-05-20', source: 'manual', createdBy: 'admin-1', sigurSteps: 'full',
    })).rejects.toMatchObject({ status: 409, code: 'OPERATION_IN_PROGRESS' });
    expect(calls.some(c => c.sql.includes('INSERT INTO employee_lifecycle_operations'))).toBe(false);
  });

  it('планировщик передал claimedAt → claim не перезахватывается', async () => {
    const calls = routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [lockRow()], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO employee_lifecycle_operations')) return { rows: [baseOp({ source: 'scheduler' })], rowCount: 1 };
      return undefined;
    });

    await openDismissOperation({
      employeeId: 77, dismissalDate: '2026-05-20', source: 'scheduler', createdBy: null, claimedAt: '2026-05-20 20:00:00+00', sigurSteps: 'full',
    });

    expect(calls.some(c => c.sql.includes('dismissal_apply_started_at = now()'))).toBe(false);
  });

  it('уже есть pending-операция → 409', async () => {
    routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [lockRow()], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: [baseOp({ kind: 'rehire' })], rowCount: 1 };
      return undefined;
    });

    await expect(openDismissOperation({
      employeeId: 77, dismissalDate: '2026-05-20', source: 'manual', createdBy: 'admin-1', sigurSteps: 'full',
    })).rejects.toMatchObject({ status: 409, code: 'OPERATION_IN_PROGRESS' });
  });

  it('expectedRevision (синк) не совпал со свежей версией → 409 STATE_CHANGED', async () => {
    routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [lockRow({ lifecycle_revision: 4 })], rowCount: 1 };
      return undefined;
    });

    await expect(openDismissOperation({
      employeeId: 77, dismissalDate: '2026-05-20', source: 'sigur_archive', createdBy: null, expectedRevision: 3, sigurSteps: 'access_only',
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CHANGED' });
  });

  it('sigurSteps=access_only (архивная папка) → перенос не нужен, блокировка нужна; none → без шагов Sigur', async () => {
    const calls = routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [lockRow()], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO employee_lifecycle_operations')) return { rows: [baseOp()], rowCount: 1 };
      return undefined;
    });

    await openDismissOperation({ employeeId: 77, dismissalDate: '2026-05-20', source: 'sigur_archive', createdBy: null, sigurSteps: 'access_only', effectiveDate: '2026-05-20' });
    let insert = calls.filter(c => c.sql.includes('INSERT INTO employee_lifecycle_operations')).at(-1)!;
    expect(insert.params.slice(8, 12)).toEqual(['2026-05-20', '2026-05-20', false, true]);

    await openDismissOperation({ employeeId: 77, dismissalDate: '2026-05-20', source: 'sigur_missing', createdBy: null, sigurSteps: 'none' });
    insert = calls.filter(c => c.sql.includes('INSERT INTO employee_lifecycle_operations')).at(-1)!;
    expect(insert.params.slice(10, 12)).toEqual([false, false]);
  });
});

describe('openRehireOperation', () => {
  const firedRow = (over: Record<string, unknown> = {}) => ({
    employment_status: 'fired', lifecycle_revision: 5, org_department_id: 'arch-1', sigur_employee_id: 555, dismissal_date: '2026-05-10', ...over,
  });

  it('уволенный без pending → INSERT rehire с целью и датой прежнего увольнения', async () => {
    const calls = routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [firedRow()], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO employee_lifecycle_operations')) return { rows: [baseOp({ kind: 'rehire' })], rowCount: 1 };
      return undefined;
    });

    await openRehireOperation({ employeeId: 77, targetDepartmentId: 'dept-2', targetSigurDepartmentId: 42, createdBy: 'admin-1' });

    const insert = calls.find(c => c.sql.includes('INSERT INTO employee_lifecycle_operations'))!;
    expect(insert.params.slice(0, 8)).toEqual([77, 'rehire', 'manual', 5, 555, 'arch-1', 'dept-2', 42]);
    expect(insert.params[9]).toBe('2026-05-10');
    expect(insert.params.slice(10, 12)).toEqual([true, true]);
  });

  it('повтор при pending rehire с тем же отделом → та же операция, без INSERT', async () => {
    const pending = baseOp({ id: 'op-r', kind: 'rehire', target_department_id: 'dept-2' });
    const calls = routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [firedRow()], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: [pending], rowCount: 1 };
      return undefined;
    });

    const op = await openRehireOperation({ employeeId: 77, targetDepartmentId: 'dept-2', targetSigurDepartmentId: 42, createdBy: 'admin-1' });

    expect(op.id).toBe('op-r');
    expect(calls.some(c => c.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('pending rehire в ДРУГОЙ отдел → 409', async () => {
    routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [firedRow()], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: [baseOp({ kind: 'rehire', target_department_id: 'dept-9' })], rowCount: 1 };
      return undefined;
    });

    await expect(openRehireOperation({ employeeId: 77, targetDepartmentId: 'dept-2', targetSigurDepartmentId: 42, createdBy: 'admin-1' }))
      .rejects.toMatchObject({ status: 409, code: 'OPERATION_IN_PROGRESS' });
  });

  it('pending dismiss → 409; активный сотрудник → 409 NOT_FIRED', async () => {
    routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [firedRow()], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: [baseOp({ kind: 'dismiss' })], rowCount: 1 };
      return undefined;
    });
    await expect(openRehireOperation({ employeeId: 77, targetDepartmentId: 'dept-2', targetSigurDepartmentId: 42, createdBy: 'admin-1' }))
      .rejects.toMatchObject({ status: 409 });

    routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [firedRow({ employment_status: 'active' })], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: [], rowCount: 0 };
      return undefined;
    });
    await expect(openRehireOperation({ employeeId: 77, targetDepartmentId: 'dept-2', targetSigurDepartmentId: 42, createdBy: 'admin-1' }))
      .rejects.toMatchObject({ status: 409, code: 'NOT_FIRED' });
  });
});

describe('acquireLease', () => {
  it('CAS: pending и (нет владельца | lease истёк) → строка; иначе null', async () => {
    h.queryOne.mockResolvedValueOnce(baseOp()).mockResolvedValueOnce(null);

    await expect(acquireLease('op-1', OWNER)).resolves.toMatchObject({ id: 'op-1' });
    await expect(acquireLease('op-1', 'other')).resolves.toBeNull();

    const sql = String(h.queryOne.mock.calls[0][0]);
    expect(sql).toContain("status = 'pending'");
    expect(sql).toMatch(/lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now\(\)/);
    expect(sql).toContain('attempts = attempts + 1');
    expect(h.queryOne.mock.calls[0][1]).toEqual(['op-1', OWNER, '30']);
  });
});

describe('runOperation — dismiss', () => {
  const finalizeOk = () => routeTx((sql) => {
    if (sql.includes("employment_status = 'fired'")) return { rows: [{ id: 77, employment_status: 'fired' }], rowCount: 1 };
    return undefined;
  });

  it('полный путь: archive → PUT → block → changeDepartment → deactivate → CAS-финализация + событие + applied', async () => {
    const tx = finalizeOk();
    const op = baseOp();

    const result = await runOperation(op, OWNER);

    expect(result.outcome).toBe('applied');
    expect(h.updateEmployee).toHaveBeenCalledWith(555, { departmentId: 9 }, undefined);
    expect(h.blockEmployee).toHaveBeenCalledWith(555, undefined);
    expect(h.changeDepartment).toHaveBeenCalledWith(77, 'arch-1', expect.objectContaining({
      effectiveDate: '2026-05-21', forceHistory: true, skipIfScheduledToTarget: true, createdBy: 'admin-1',
    }));
    expect(h.deactivateAccess).toHaveBeenCalledWith(77);

    // Шаги пишутся под lease-token.
    const stepWrites = h.queryOne.mock.calls.filter(([sql]) => String(sql).includes('UPDATE employee_lifecycle_operations'));
    expect(stepWrites.length).toBeGreaterThanOrEqual(3);
    for (const [sql, params] of stepWrites) {
      expect(String(sql)).toContain('lease_owner = $');
      expect((params as unknown[]).includes(OWNER)).toBe(true);
    }

    const fire = tx.find(c => c.sql.includes("employment_status = 'fired'"))!;
    expect(fire.sql).toContain('lifecycle_revision = lifecycle_revision + 1');
    expect(fire.sql).toContain('lifecycle_revision = $5');
    expect(fire.sql).toContain("employment_status = 'active'");
    // target, dismissal_date, exclusion D+1, id, base_revision
    expect(fire.params).toEqual(['arch-1', '2026-05-20', '2026-05-21', 77, 3]);

    const evt = tx.find(c => c.sql.includes('INSERT INTO employee_dismissal_events'))!;
    expect(evt.params).toEqual([77, '2026-05-20', false, 'admin-1', 'dept-1', 'op-1']);

    const applied = tx.find(c => c.sql.includes("status = 'applied'"))!;
    expect(applied.params).toEqual(['op-1', OWNER]);
    expect(h.invalidate).toHaveBeenCalledWith(77);
  });

  it('повтор после падения: выполненные шаги Sigur не повторяются (читается payload операции)', async () => {
    finalizeOk();
    const op = baseOp({ sigur_moved: true, target_sigur_department_id: 9 });

    await runOperation(op, OWNER);

    expect(h.ensureArchiveSigur).not.toHaveBeenCalled();
    expect(h.updateEmployee).not.toHaveBeenCalled();
    expect(h.blockEmployee).toHaveBeenCalledTimes(1);
  });

  it('source=scheduler → событие applied_from_scheduled; sigurSteps none → Sigur не трогается', async () => {
    const tx = finalizeOk();
    const op = baseOp({ source: 'scheduler', sigur_move_required: false, sigur_access_required: false, created_by: null });

    await runOperation(op, OWNER);

    expect(h.updateEmployee).not.toHaveBeenCalled();
    expect(h.blockEmployee).not.toHaveBeenCalled();
    const evt = tx.find(c => c.sql.includes('INSERT INTO employee_dismissal_events'))!;
    expect(evt.params[2]).toBe(true);
  });

  it('ошибка на блокировке после переноса → DismissalSigurError SIGUR_PARTIAL_FAILURE, last_error записан, операция pending', async () => {
    h.blockEmployee.mockRejectedValue(new Error('block failed'));
    const op = baseOp();

    await expect(runOperation(op, OWNER)).rejects.toMatchObject({ code: 'SIGUR_PARTIAL_FAILURE', movedToArchive: true, blocked: false });
    expect(h.txQuery).not.toHaveBeenCalled();
    const errWrite = h.execute.mock.calls.find(([sql]) => String(sql).includes('last_error = $3'));
    expect(errWrite).toBeDefined();
    expect(errWrite![1].slice(0, 2)).toEqual(['op-1', OWNER]);
    expect(String(errWrite![1][2])).toContain('block failed');
    expect(h.execute.mock.calls.some(([sql]) => String(sql).includes("status = 'cancelled'"))).toBe(false);
  });

  it('ошибка до переноса → SIGUR_WRITE_FAILED (movedToArchive=false)', async () => {
    h.updateEmployee.mockRejectedValue(new Error('sigur down'));

    await expect(runOperation(baseOp(), OWNER)).rejects.toMatchObject({ code: 'SIGUR_WRITE_FAILED', movedToArchive: false });
    expect(h.blockEmployee).not.toHaveBeenCalled();
  });

  it('lease перехвачен (запись шага вернула 0 строк) → тихий выход, дальше не идём', async () => {
    h.queryOne.mockResolvedValue(null);

    const result = await runOperation(baseOp(), OWNER);

    expect(result.outcome).toBe('lease_lost');
    expect(h.updateEmployee).not.toHaveBeenCalled();
    expect(h.txQuery).not.toHaveBeenCalled();
  });

  it('CAS 0 строк, событие operation_id уже есть → applied_elsewhere (параллельный исполнитель успел)', async () => {
    routeTx((sql) => {
      if (sql.includes("employment_status = 'fired'")) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM employee_dismissal_events WHERE operation_id')) return { rows: [{ id: 'evt' }], rowCount: 1 };
      return undefined;
    });
    routeStepWrites((sql) => (sql.includes('FROM employees WHERE id') ? { id: 77, employment_status: 'fired' } : null));

    const result = await runOperation(baseOp(), OWNER);

    expect(result.outcome).toBe('applied');
    expect(result.employee).toMatchObject({ employment_status: 'fired' });
    expect(h.txQuery.mock.calls.some(([sql]) => String(sql).includes("status = 'cancelled'"))).toBe(false);
  });

  it('CAS 0 строк без события → cancelled + Sentry + 409 STATE_CHANGED', async () => {
    const tx = routeTx((sql) => {
      if (sql.includes("employment_status = 'fired'")) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM employee_dismissal_events WHERE operation_id')) return { rows: [], rowCount: 0 };
      return undefined;
    });

    await expect(runOperation(baseOp(), OWNER)).rejects.toMatchObject({ status: 409, code: 'STATE_CHANGED' });
    expect(tx.some(c => c.sql.includes("status = 'cancelled'"))).toBe(true);
    expect(h.captureMessage).toHaveBeenCalled();
  });

  it('после 50 попыток ошибка уходит алертом в Sentry, операция остаётся pending', async () => {
    h.updateEmployee.mockRejectedValue(new Error('sigur down'));

    await expect(runOperation(baseOp({ attempts: 50 }), OWNER)).rejects.toBeInstanceOf(DismissalSigurError);
    expect(h.captureMessage).toHaveBeenCalledWith(expect.stringContaining('stuck after 50 attempts'), expect.anything());
  });
});

describe('runOperation — rehire', () => {
  const rehireOp = (over: Partial<ILifecycleOperation> = {}) => baseOp({
    id: 'op-r', kind: 'rehire', from_department_id: 'arch-1', target_department_id: 'dept-2',
    target_sigur_department_id: 42, effective_date: '2026-05-20', dismissal_date: '2026-05-10', ...over,
  });
  const finalizeOk = () => routeTx((sql) => {
    if (sql.includes("employment_status = 'active'") && sql.includes('UPDATE employees')) return { rows: [{ id: 77, employment_status: 'active' }], rowCount: 1 };
    return undefined;
  });

  it('PUT в цель операции → unblock → сброс кэша выгрузки → syncLinked → changeDepartment → CAS + событие rehired', async () => {
    const tx = finalizeOk();

    const result = await runOperation(rehireOp(), OWNER);

    expect(result.outcome).toBe('applied');
    expect(h.updateEmployee).toHaveBeenCalledWith(555, { departmentId: 42 }, undefined);
    expect(h.unblockEmployee).toHaveBeenCalledWith(555, undefined);
    expect(h.invalidateEmployeeCache).toHaveBeenCalledTimes(1);
    expect(h.syncLinked).toHaveBeenCalledWith(77, undefined);
    expect(h.changeDepartment).toHaveBeenCalledWith(77, 'dept-2', expect.objectContaining({
      reason: 'Восстановление на работу', lockDepartment: false, effectiveDate: '2026-05-20', forceHistory: true, skipIfScheduledToTarget: true,
    }));
    expect(h.upsertAccess).toHaveBeenCalledWith(77, 'dept-2', null, 'sigur_sync');

    const upd = tx.find(c => c.sql.includes("employment_status = 'active'") && c.sql.includes('UPDATE employees'))!;
    expect(upd.sql).toContain("employment_status = 'fired'");
    expect(upd.sql).toContain('lifecycle_revision = lifecycle_revision + 1');
    expect(upd.params).toEqual(['dept-2', false, 77, 3]);

    const evt = tx.find(c => c.sql.includes('INSERT INTO employee_dismissal_events'))!;
    expect(evt.sql).toContain('true, false'); // rehired=true, applied_from_scheduled=false
    expect(evt.params).toEqual([77, '2026-05-10', '2026-05-10', 'admin-1', 'op-r']);
  });

  it('404 на карточку при живом отделе → auto-detach: шаг записан, unblock/syncLinked пропущены, финализация с sigur_employee_id=NULL', async () => {
    const notFound = new AxiosError('nf', '404', undefined, undefined, { status: 404 } as never);
    h.updateEmployee.mockRejectedValue(notFound);
    h.getDepartmentById.mockResolvedValue({ id: 42 });
    finalizeOk();

    const op = rehireOp();
    const result = await runOperation(op, OWNER);

    expect(result.outcome).toBe('applied');
    expect(op.sigur_detached).toBe(true);
    const detachWrite = h.queryOne.mock.calls.find(([sql]) => String(sql).includes('sigur_detached = $'));
    expect(detachWrite).toBeDefined();
    expect(h.unblockEmployee).not.toHaveBeenCalled();
    expect(h.syncLinked).not.toHaveBeenCalled();
    expect(h.changeDepartment).toHaveBeenCalledWith(77, 'dept-2', expect.objectContaining({ lockDepartment: true }));
    expect(h.upsertAccess).toHaveBeenCalledWith(77, 'dept-2', null, 'portal_lifecycle');
    const upd = h.txQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE employees'))!;
    expect(upd[1]).toEqual(['dept-2', true, 77, 3]);
  });

  it('404 и отдел тоже удалён → 409 SIGUR_DEPARTMENT_MISSING, операция pending', async () => {
    h.updateEmployee.mockRejectedValue(new AxiosError('nf', '404', undefined, undefined, { status: 404 } as never));
    h.getDepartmentById.mockRejectedValue(new Error('404'));

    await expect(runOperation(rehireOp(), OWNER)).rejects.toMatchObject({ status: 409, code: 'SIGUR_DEPARTMENT_MISSING' });
    expect(h.txQuery).not.toHaveBeenCalled();
  });

  it('повтор после падения на unblock: PUT не повторяется', async () => {
    finalizeOk();

    await runOperation(rehireOp({ sigur_moved: true }), OWNER);

    expect(h.updateEmployee).not.toHaveBeenCalled();
    expect(h.unblockEmployee).toHaveBeenCalledTimes(1);
  });
});

describe('runOperation — repair_sigur', () => {
  const repairOp = () => baseOp({
    id: 'op-rep', kind: 'repair_sigur', source: 'sigur_compensation', target_department_id: 'dept-2',
    target_sigur_department_id: 42, sigur_access_required: false, dismissal_date: null,
  });

  it('PUT в цель → проба подтвердила рабочий отдел → версия +1, applied без события истории', async () => {
    const tx = routeTx((sql) => {
      if (sql.includes('UPDATE employees')) return { rows: [{ id: 77 }], rowCount: 1 };
      return undefined;
    });

    const result = await runOperation(repairOp(), OWNER);

    expect(result.outcome).toBe('applied');
    expect(h.updateEmployee).toHaveBeenCalledWith(555, { departmentId: 42 }, undefined);
    expect(h.invalidateEmployeeCache).toHaveBeenCalled();
    expect(tx.some(c => c.sql.includes('employee_dismissal_events'))).toBe(false);
    expect(tx.some(c => c.sql.includes("status = 'applied'"))).toBe(true);
  });

  it('проба всё ещё показывает архив → ошибка, операция pending (повтор по lease)', async () => {
    h.getEmployeeById.mockResolvedValue({ id: 555, departmentId: 9 });

    await expect(runOperation(repairOp(), OWNER)).rejects.toThrow(/archived/);
    expect(h.txQuery).not.toHaveBeenCalled();
    expect(h.execute.mock.calls.some(([sql]) => String(sql).includes('last_error'))).toBe(true);
  });
});

describe('resumeExpiredOperations', () => {
  it('берёт только бесхозные/просроченные, каждую под своим lease; чужой lease пропускает', async () => {
    h.query.mockResolvedValue([{ id: 'op-a' }, { id: 'op-b' }]);
    h.queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('attempts = attempts + 1')) {
        return params[0] === 'op-a'
          ? baseOp({ id: 'op-a', sigur_move_required: false, sigur_access_required: false, lease_owner: String(params[1]) })
          : null;
      }
      if (sql.includes('UPDATE employee_lifecycle_operations')) return { id: params[params.length - 2] };
      return null;
    });
    routeTx((sql) => (sql.includes("employment_status = 'fired'") ? { rows: [{ id: 77 }], rowCount: 1 } : undefined));

    const result = await resumeExpiredOperations();

    expect(String(h.query.mock.calls[0][0])).toMatch(/lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now\(\)/);
    expect(result).toEqual({ resumed: 1, applied: 1, failed: 0 });
  });
});

describe('openRepairOperation', () => {
  it('активный без pending → INSERT repair_sigur; с pending → null', async () => {
    const lock = { employment_status: 'active', lifecycle_revision: 6, org_department_id: 'arch-1', sigur_employee_id: 555, dismissal_date: null };
    let pendingRow: unknown[] = [];
    const calls = routeTx((sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('FROM employees')) return { rows: [lock], rowCount: 1 };
      if (sql.includes('FROM employee_lifecycle_operations')) return { rows: pendingRow, rowCount: pendingRow.length };
      if (sql.includes('INSERT INTO employee_lifecycle_operations')) return { rows: [baseOp({ kind: 'repair_sigur' })], rowCount: 1 };
      return undefined;
    });

    const op = await openRepairOperation({ employeeId: 77, targetDepartmentId: 'dept-2', targetSigurDepartmentId: 42, createdBy: null });
    expect(op?.kind).toBe('repair_sigur');
    const insert = calls.find(c => c.sql.includes('INSERT INTO'))!;
    expect(insert.params.slice(0, 8)).toEqual([77, 'repair_sigur', 'sigur_compensation', 6, 555, 'arch-1', 'dept-2', 42]);

    pendingRow = [baseOp({ kind: 'rehire' })];
    await expect(openRepairOperation({ employeeId: 77, targetDepartmentId: 'dept-2', targetSigurDepartmentId: 42, createdBy: null })).resolves.toBeNull();
  });
});

describe('isLifecycleProtected', () => {
  const now = new Date('2026-09-01T12:00:00Z');
  const guard = (over: Record<string, unknown>) => ({
    employee_id: 1, employment_status: 'active', lifecycle_revision: 1, pending_kind: null, pending_operation_id: null,
    pending_target_sigur_department_id: null, last_rehire_applied_at: null, last_rehire_target_department_id: null,
    last_rehire_target_sigur_department_id: null, absence_revision: null, absence_first_seen_at: null, absence_strikes: null,
    ...over,
  }) as never;

  it('pending-операция защищает без срока; недавний rehire — только 60 минут', () => {
    expect(isLifecycleProtected(undefined, now)).toBe(false);
    expect(isLifecycleProtected(guard({}), now)).toBe(false);
    expect(isLifecycleProtected(guard({ pending_kind: 'repair_sigur' }), now)).toBe(true);
    expect(isLifecycleProtected(guard({ last_rehire_applied_at: '2026-09-01T11:30:00Z' }), now)).toBe(true);
    expect(isLifecycleProtected(guard({ last_rehire_applied_at: '2026-09-01T10:30:00Z' }), now)).toBe(false);
  });
});

describe('probeSigurCard', () => {
  it('классифицирует исходы: working / archived / deleted (404) / unknown', async () => {
    h.getEmployeeById.mockResolvedValueOnce({ id: 555, departmentId: 42 });
    await expect(probeSigurCard(555, 9)).resolves.toEqual({ state: 'working', departmentId: 42 });

    h.getEmployeeById.mockResolvedValueOnce({ id: 555, departmentId: 9 });
    await expect(probeSigurCard(555, 9)).resolves.toEqual({ state: 'archived', departmentId: 9 });

    h.getEmployeeById.mockRejectedValueOnce(new AxiosError('nf', '404', undefined, undefined, { status: 404 } as never));
    await expect(probeSigurCard(555, 9)).resolves.toEqual({ state: 'deleted', departmentId: null });

    h.getEmployeeById.mockRejectedValueOnce(new Error('timeout'));
    await expect(probeSigurCard(555, 9)).resolves.toMatchObject({ state: 'unknown', error: 'timeout' });

    h.getEmployeeById.mockResolvedValueOnce({ id: 556, departmentId: 42 });
    await expect(probeSigurCard(555, 9)).resolves.toMatchObject({ state: 'unknown' });

    h.getEmployeeById.mockResolvedValueOnce(null);
    await expect(probeSigurCard(555, 9)).resolves.toMatchObject({ state: 'unknown' });
  });
});

describe('mapWithConcurrency', () => {
  it('сохраняет порядок и не превышает лимит параллелизма', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return n * 10;
    });

    expect(result).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });
});

describe('LifecycleOperationError', () => {
  it('несёт status и code для HTTP-ответа', () => {
    const e = new LifecycleOperationError(409, 'x', 'STATE_CHANGED');
    expect(e).toMatchObject({ status: 409, code: 'STATE_CHANGED', message: 'x' });
  });
});
