import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Профиль пропуска перед «Открыть пропуска»: удалённый в Sigur пересоздаётся (НСТ 6579/6588,
 * 12.11.2026), «уволенный» возвращается в папку подрядчика без разблокировки.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
  getEmployees: vi.fn(),
  getCardBindings: vi.fn(),
  getSigurSettings: vi.fn(),
  auditLog: vi.fn(),
  cacheInvalidate: vi.fn(),
  getOrgSigurDept: vi.fn(),
  getFreePoolDept: vi.fn(),
  createEmp: vi.fn(),
  deleteEmp: vi.fn(),
  moveEmp: vi.fn(),
  updateEmp: vi.fn(),
  executeOperation: vi.fn(),
  openRehire: vi.fn(),
  openRepair: vi.fn(),
  probe: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: vi.fn(),
  withTransaction: h.withTransaction,
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: { getEmployees: h.getEmployees, getCardBindings: h.getCardBindings },
}));
vi.mock('./settings.service.js', () => ({
  settingsService: { getSigurConnectionSettings: h.getSigurSettings },
}));
vi.mock('./audit.service.js', () => ({ auditService: { log: h.auditLog } }));
vi.mock('./employee-cache.service.js', () => ({ employeeCache: { invalidate: h.cacheInvalidate } }));
vi.mock('./contractor-scope.service.js', () => ({ getOrgSigurDepartmentId: h.getOrgSigurDept }));
vi.mock('./contractor-pool.service.js', async () => {
  // Чистые помощники пула — настоящие (тот же ключ FOT-POOL:N, что при выпуске).
  const readName = (e: Record<string, unknown>) => String(e.name ?? '').trim();
  return {
    getFreePoolDepartmentId: h.getFreePoolDept,
    buildPoolProfileInput: (passNumber: string, departmentId: number) => ({
      name: `Пропуск ${passNumber}`, departmentId, description: `FOT-POOL:${passNumber}`, blocked: true,
    }),
    findPoolProfileIdsInList: (list: Record<string, unknown>[], passNumber: string) => list
      .filter(e => e.description === `FOT-POOL:${passNumber}` || readName(e) === `Пропуск ${passNumber}`)
      .map(e => Number(e.id)),
  };
});
vi.mock('./sigur-live-employees-crud.service.js', () => ({
  createSigurEmployee: h.createEmp,
  deleteSigurEmployee: h.deleteEmp,
  moveSigurEmployee: h.moveEmp,
  updateSigurEmployee: h.updateEmp,
}));
vi.mock('./employee-lifecycle-operations.service.js', () => ({
  executeOperation: h.executeOperation,
  openRehireOperation: h.openRehire,
  openRepairOperation: h.openRepair,
  probeSigurCard: h.probe,
}));
vi.mock('@sentry/node', () => ({ captureException: h.captureException }));

import {
  ensurePassProfileReady,
  findUnissuedPassByProfile,
  isPassProfileDeleted,
} from './contractor-pass-profile.service.js';
import type { ISigurCardProbe } from './employee-lifecycle-operations.service.js';

const PASS = { id: 'pass-6579', passNumber: '6579', sigurEmployeeId: 151351, orgDepartmentId: 'org-nst' };
const ORG_SIGUR = 145887;
const ARCHIVE = 142094;
const POOL = 500;

/** Состояние «БД»: ссылка пропуска и зеркало; UPDATE … WHERE sigur_employee_id = старый — CAS. */
let db: { passSigurId: number | null; mirror: { id: number; sigurId: number; status: string } | null };
let relinkSql: Array<{ sql: string; params: unknown[] }>;
let lockChain: Promise<void>;

const relinkRoute = async (sql: string, params: unknown[]) => {
  relinkSql.push({ sql, params });
  if (sql.includes('UPDATE contractor_passes')) {
    if (db.passSigurId !== params[1]) return { rows: [], rowCount: 0 };
    db.passSigurId = params[2] as number;
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('UPDATE employees')) {
    if (db.mirror && db.mirror.sigurId === params[0]) {
      db.mirror.sigurId = params[1] as number;
      return { rows: [{ id: db.mirror.id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 1 };
};

const probeState = (states: Record<number, ISigurCardProbe>) => {
  h.probe.mockImplementation(async (id: number) => states[id] ?? { state: 'unknown', departmentId: null });
};
const working = (departmentId = ORG_SIGUR): ISigurCardProbe => ({ state: 'working', departmentId });
const archived = (): ISigurCardProbe => ({ state: 'archived', departmentId: ARCHIVE });
const deleted422 = (): ISigurCardProbe => ({ state: 'unknown', departmentId: null, httpStatus: 422 });

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  db = { passSigurId: PASS.sigurEmployeeId, mirror: { id: 14036, sigurId: PASS.sigurEmployeeId, status: 'fired' } };
  relinkSql = [];
  lockChain = Promise.resolve();

  // withTransaction: advisory-лок сериализует вызовы (как pg_advisory_xact_lock до конца транзакции).
  h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
    let release: () => void = () => {};
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('pg_advisory_xact_lock')) {
          const prev = lockChain;
          lockChain = new Promise<void>(resolve => { release = resolve; });
          await prev;
          return { rows: [], rowCount: 1 };
        }
        return relinkRoute(sql, params);
      }),
    };
    try {
      return await fn(client);
    } finally {
      release();
    }
  });
  h.queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM contractor_passes WHERE id')) {
      return { sigur_employee_id: db.passSigurId == null ? null : String(db.passSigurId) };
    }
    if (sql.includes('FROM employees')) {
      return db.mirror && db.mirror.sigurId === params[0]
        ? { id: db.mirror.id, employment_status: db.mirror.status }
        : null;
    }
    return null;
  });
  h.query.mockResolvedValue([]);
  h.getSigurSettings.mockResolvedValue({ archiveDepartmentId: ARCHIVE });
  h.getOrgSigurDept.mockResolvedValue(ORG_SIGUR);
  h.getFreePoolDept.mockResolvedValue(POOL);
  h.getEmployees.mockResolvedValue([]);
  h.getCardBindings.mockResolvedValue([]);
  h.createEmp.mockImplementation(async (_input: unknown, _conn: unknown, hooks?: { onCreated?: (id: number) => void }) => {
    hooks?.onCreated?.(900);
    return { sigurEmployeeId: 900 };
  });
  h.openRehire.mockResolvedValue({ id: 'op-rehire' });
  h.openRepair.mockResolvedValue({ id: 'op-repair' });
  h.executeOperation.mockResolvedValue({});
  h.auditLog.mockResolvedValue(undefined);
});

describe('isPassProfileDeleted', () => {
  it('удалён только по точечному GET: 404 или 422; иные ошибки — нет', () => {
    expect(isPassProfileDeleted({ state: 'deleted', departmentId: null })).toBe(true);
    expect(isPassProfileDeleted({ state: 'unknown', departmentId: null, httpStatus: 422 })).toBe(true);
    expect(isPassProfileDeleted({ state: 'unknown', departmentId: null, httpStatus: 500 })).toBe(false);
    expect(isPassProfileDeleted({ state: 'unknown', departmentId: null })).toBe(false);
    expect(isPassProfileDeleted({ state: 'archived', departmentId: ARCHIVE })).toBe(false);
  });
});

describe('ensurePassProfileReady', () => {
  it('профиль в порядке (папка подрядчика, зеркало активно) → ничего не меняется', async () => {
    db.mirror!.status = 'active';
    probeState({ 151351: working() });

    const result = await ensurePassProfileReady(PASS, 'admin-1', 'external');

    expect(result).toEqual({ sigurEmployeeId: 151351, recreated: false, restored: null });
    expect(h.createEmp).not.toHaveBeenCalled();
    expect(h.openRehire).not.toHaveBeenCalled();
    expect(h.openRepair).not.toHaveBeenCalled();
    expect(h.moveEmp).not.toHaveBeenCalled();
  });

  it('удалён в Sigur (GET 422) → новый «Пропуск N» в папке подрядчика; id в пропуске, зеркале и ростере; зеркало восстановлено без разблокировки', async () => {
    probeState({ 151351: deleted422(), 900: working() });

    const result = await ensurePassProfileReady(PASS, 'admin-1', 'external');

    expect(result).toEqual({ sigurEmployeeId: 900, recreated: true, restored: 'rehire' });
    expect(h.createEmp).toHaveBeenCalledTimes(1);
    expect(h.createEmp).toHaveBeenCalledWith(
      { name: 'Пропуск 6579', departmentId: ORG_SIGUR, description: 'FOT-POOL:6579', blocked: true },
      'external',
      expect.objectContaining({ onCreated: expect.any(Function) }),
    );
    // Кандидаты ищутся в папках подрядчика, архива и пула.
    expect(h.getEmployees.mock.calls.map(c => c[0])).toEqual([
      { departmentId: ORG_SIGUR }, { departmentId: ARCHIVE }, { departmentId: POOL },
    ]);
    // CAS по старому id во всех трёх местах, зеркало — та же строка (без второй).
    expect(db.passSigurId).toBe(900);
    expect(db.mirror).toEqual({ id: 14036, sigurId: 900, status: 'fired' });
    const roster = relinkSql.find(c => c.sql.includes('UPDATE contractor_roster'))!;
    expect(roster.params).toEqual(['org-nst', 151351, 900]);
    expect(roster.sql).toContain('NOT EXISTS');
    const employees = relinkSql.find(c => c.sql.includes('UPDATE employees'))!;
    expect(employees.sql).toContain('NOT EXISTS');
    expect(h.cacheInvalidate).toHaveBeenCalledWith(14036);
    expect(h.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      entity_id: '900',
      details: expect.objectContaining({ action: 'recreate_pass_profile', previous_sigur_employee_id: 151351, reused: false }),
    }));
    // Зеркало было «уволено» → восстановление в отдел подрядчика без разблокировки.
    expect(h.openRehire).toHaveBeenCalledWith({
      employeeId: 14036,
      targetDepartmentId: 'org-nst',
      targetSigurDepartmentId: ORG_SIGUR,
      createdBy: 'admin-1',
      source: 'contractor_admin',
      sigurAccessRequired: false,
    });
    expect(h.executeOperation).toHaveBeenCalledWith({ id: 'op-rehire' }, 'external');
  });

  it('прочая ошибка GET (500) — не удаление: профиль не пересоздаётся, дальше обычные шаги', async () => {
    probeState({ 151351: { state: 'unknown', departmentId: null, httpStatus: 500 } });

    const result = await ensurePassProfileReady(PASS, 'admin-1', 'external');

    expect(result).toEqual({ sigurEmployeeId: 151351, recreated: false, restored: null });
    expect(h.withTransaction).not.toHaveBeenCalled();
    expect(h.openRehire).not.toHaveBeenCalled();
  });

  it('два одновременных «Открыть» по одному пропуску → один новый профиль, оба получают его id', async () => {
    probeState({ 151351: deleted422(), 900: working() });

    const [a, b] = await Promise.all([
      ensurePassProfileReady(PASS, 'admin-1', 'external'),
      ensurePassProfileReady(PASS, 'admin-2', 'external'),
    ]);

    expect(h.createEmp).toHaveBeenCalledTimes(1);
    expect(a.sigurEmployeeId).toBe(900);
    expect(b.sigurEmployeeId).toBe(900);
    expect([a.recreated, b.recreated].sort()).toEqual([false, true]);
    expect(db.passSigurId).toBe(900);
  });

  it('пропуск сменил профиль под нами (CAS) → ошибка, созданный профиль удаляется', async () => {
    probeState({ 151351: deleted422() });
    h.createEmp.mockImplementation(async (_i: unknown, _c: unknown, hooks?: { onCreated?: (id: number) => void }) => {
      hooks?.onCreated?.(901);
      db.passSigurId = 777; // параллельная смена ссылки другим путём
      return { sigurEmployeeId: 901 };
    });

    await expect(ensurePassProfileReady(PASS, 'admin-1', 'external')).rejects.toThrow('пропуск изменился');
    expect(h.deleteEmp).toHaveBeenCalledWith(901, 'external');
    expect(db.passSigurId).toBe(777);
    expect(db.mirror!.sigurId).toBe(151351);
    expect(h.auditLog).not.toHaveBeenCalled();
  });

  it('в Sigur есть другой профиль «Пропуск N» (с картой) → ручная проверка, ничего не создаётся', async () => {
    probeState({ 151351: deleted422() });
    h.getEmployees.mockImplementation(async ({ departmentId }: { departmentId: number }) => (
      departmentId === ARCHIVE ? [{ id: 333, name: 'Пропуск 6579', description: null }] : []
    ));

    await expect(ensurePassProfileReady(PASS, 'admin-1', 'external')).rejects.toThrow('нужна ручная проверка');
    expect(h.createEmp).not.toHaveBeenCalled();
    expect(db.passSigurId).toBe(151351);
  });

  it('профиль другого живого пропуска не переиспользуется', async () => {
    probeState({ 151351: deleted422(), 900: working() });
    h.getEmployees.mockImplementation(async ({ departmentId }: { departmentId: number }) => (
      departmentId === ORG_SIGUR ? [{ id: 444, name: 'Пропуск 6579', description: 'FOT-POOL:6579' }] : []
    ));
    h.query.mockResolvedValueOnce([{ sid: '444' }]); // 444 занят другим живым пропуском

    const result = await ensurePassProfileReady(PASS, 'admin-1', 'external');

    expect(result.sigurEmployeeId).toBe(900);
    expect(h.createEmp).toHaveBeenCalledTimes(1);
    expect(h.updateEmp).not.toHaveBeenCalled();
  });

  it('свой осиротевший профиль (папка подрядчика, без карт) → переиспользуется и блокируется', async () => {
    probeState({ 151351: deleted422(), 555: working() });
    h.getEmployees.mockImplementation(async ({ departmentId }: { departmentId: number }) => (
      departmentId === ORG_SIGUR ? [{ id: 555, name: 'Пропуск 6579', description: 'FOT-POOL:6579' }] : []
    ));

    const result = await ensurePassProfileReady(PASS, 'admin-1', 'external');

    expect(result.sigurEmployeeId).toBe(555);
    expect(h.createEmp).not.toHaveBeenCalled();
    expect(h.getCardBindings).toHaveBeenCalledWith({ employeeId: 555 }, 'external');
    expect(h.updateEmp).toHaveBeenCalledWith(555, { blocked: true }, 'external');
    expect(db.passSigurId).toBe(555);
  });

  it('профиль в «Уволенных», зеркало активно → ремонт карточки (перенос в папку подрядчика)', async () => {
    db.mirror!.status = 'active';
    probeState({ 151351: archived() });

    const result = await ensurePassProfileReady(PASS, 'admin-1', 'external');

    expect(result).toEqual({ sigurEmployeeId: 151351, recreated: false, restored: 'repair' });
    expect(h.openRepair).toHaveBeenCalledWith({
      employeeId: 14036, targetDepartmentId: 'org-nst', targetSigurDepartmentId: ORG_SIGUR, createdBy: 'admin-1',
    });
    expect(h.executeOperation).toHaveBeenCalledWith({ id: 'op-repair' }, 'external');
    expect(h.openRehire).not.toHaveBeenCalled();
  });

  it('профиль в «Уволенных», зеркало «уволено» → восстановление без разблокировки', async () => {
    probeState({ 151351: archived() });

    const result = await ensurePassProfileReady(PASS, 'admin-1', 'external');

    expect(result.restored).toBe('rehire');
    expect(h.openRehire).toHaveBeenCalledWith(expect.objectContaining({ sigurAccessRequired: false, source: 'contractor_admin' }));
    expect(h.createEmp).not.toHaveBeenCalled();
  });

  it('профиль в «Уволенных», зеркала ещё нет → прямой перенос в папку подрядчика', async () => {
    db.mirror = null;
    probeState({ 151351: archived() });

    const result = await ensurePassProfileReady(PASS, 'admin-1', 'external');

    expect(result.restored).toBe('move');
    expect(h.moveEmp).toHaveBeenCalledWith(151351, ORG_SIGUR, 'external');
  });

  it('сбой возврата из архива не роняет одобрение: id прежний, ошибка — в Sentry', async () => {
    probeState({ 151351: archived() });
    h.executeOperation.mockRejectedValueOnce(new Error('Sigur timeout'));

    const result = await ensurePassProfileReady(PASS, 'admin-1', 'external');

    expect(result).toEqual({ sigurEmployeeId: 151351, recreated: false, restored: null });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('findUnissuedPassByProfile', () => {
  it('ищет живой невыданный пропуск по профилю (не applied, не revoked)', async () => {
    h.queryOne.mockResolvedValueOnce({ id: 'pass-6579', pass_number: '6579' });

    const found = await findUnissuedPassByProfile(151351);

    expect(found).toEqual({ id: 'pass-6579', pass_number: '6579' });
    const [sql, params] = h.queryOne.mock.calls[0];
    expect(sql).toContain("status NOT IN ('applied', 'revoked')");
    expect(params).toEqual([151351]);
  });
});
