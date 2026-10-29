import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class DismissalSigurError extends Error {}
  return {
    query: vi.fn(),
    queryOne: vi.fn(),
    txQuery: vi.fn(),
    auditLog: vi.fn(),
    auditLogWithClient: vi.fn(),
    openDismiss: vi.fn(),
    executeOp: vi.fn(),
    DismissalSigurError,
  };
});

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn({ query: h.txQuery }),
}));
vi.mock('./audit.service.js', () => ({
  auditService: { log: h.auditLog, logWithClient: h.auditLogWithClient },
}));
vi.mock('./employee-lifecycle-operations.service.js', () => ({
  DismissalSigurError: h.DismissalSigurError,
  openDismissOperation: h.openDismiss,
  executeOperation: h.executeOp,
}));

import {
  ORPHAN_CLAIM_CUTOFF,
  OrphanClaimRepairError,
  firedPreconditionViolation,
  incidentSignatureViolation,
  repairOrphanDismissalClaims,
  validateTargets,
  type IOrphanClaimState,
  type IOrphanClaimTarget,
} from './orphan-dismissal-claim-repair.service.js';

const ARCHIVE = 'archive-dept';
const CLAIM = '2026-08-05 23:04:19.768+03';

const state = (over: Partial<IOrphanClaimState> = {}): IOrphanClaimState => ({
  full_name: 'Муротов Равшан Жума Угли',
  employment_status: 'active',
  dismissal_date: null,
  claim_at: CLAIM,
  claim_before_cutoff: true,
  lifecycle_revision: 0,
  org_department_id: 'su90',
  pending_operations: 0,
  event_dismissal_date: '2026-08-05',
  event_from_department_id: 'su90',
  event_cancelled: false,
  event_rehired: false,
  skud_after_dismissal: 0,
  open_assignments: [{ org_department_id: ARCHIVE, effective_from: '2026-08-06' }],
  ...over,
});

const FIRED: IOrphanClaimTarget = {
  employeeId: 4214, fullName: 'Муротов Равшан Жума Угли', outcome: 'confirmed_fired', dismissalDate: '2026-08-05',
};
const WORKING: IOrphanClaimTarget = {
  employeeId: 462, fullName: 'Горбенко Константин Николаевич', outcome: 'legitimate_rehire',
};

/** Имена + архивный отдел + состояние каждого сотрудника по порядку. */
const routeDb = (states: Record<number, IOrphanClaimState | null>): void => {
  h.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM employees WHERE id = ANY')) {
      return (params[0] as number[]).map(id => ({ id, full_name: id === 462 ? WORKING.fullName : states[id]?.full_name ?? null }));
    }
    return [];
  });
  h.queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('employees_archive_department_id')) return { id: ARCHIVE };
    return states[params[0] as number] ?? null;
  });
};

beforeEach(() => {
  vi.resetAllMocks();
  h.txQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  h.openDismiss.mockResolvedValue({ id: 'op-1' });
  h.executeOp.mockResolvedValue({ id: 4214, employment_status: 'fired' });
});

describe('validateTargets', () => {
  it('сотрудник дважды → ошибка до любых запросов', () => {
    expect(() => validateTargets([WORKING, { ...WORKING, outcome: 'confirmed_fired' }])).toThrow(OrphanClaimRepairError);
  });

  it('некорректная дата → ошибка', () => {
    expect(() => validateTargets([{ ...FIRED, dismissalDate: '05.08.2026' }])).toThrow(OrphanClaimRepairError);
  });
});

describe('incidentSignatureViolation — общая для обоих исходов', () => {
  it('полная сигнатура → null', () => {
    expect(incidentSignatureViolation(state())).toBeNull();
  });

  it.each([
    ['уволен', { employment_status: 'fired' }],
    ['дата увольнения уже назначена', { dismissal_date: '2026-10-29' }],
    ['claim не задан', { claim_at: null, claim_before_cutoff: null }],
    ['claim новее cutoff', { claim_before_cutoff: false }],
    ['версия не 0', { lifecycle_revision: 1 }],
    ['незавершённая операция', { pending_operations: 1 }],
  ])('%s → пропуск', (_label, over) => {
    expect(incidentSignatureViolation(state(over as Partial<IOrphanClaimState>))).not.toBeNull();
  });
});

describe('firedPreconditionViolation — увольнение восстанавливается только «как было»', () => {
  it('всё сходится → null', () => {
    expect(firedPreconditionViolation(state(), FIRED, ARCHIVE)).toBeNull();
  });

  it.each([
    ['дата в списке не совпала с событием', {}, { dismissalDate: '2026-08-06' }],
    ['нет события', { event_dismissal_date: null }, {}],
    ['последнее событие — восстановление', { event_rehired: true }, {}],
    ['отдел события ≠ текущему', { event_from_department_id: 'brigade' }, {}],
    ['проходы после D', { skud_after_dismissal: 3 }, {}],
    ['нет открытых назначений', { open_assignments: [] }, {}],
    ['лишнее открытое назначение', {
      open_assignments: [
        { org_department_id: ARCHIVE, effective_from: '2026-08-06' },
        { org_department_id: 'su90', effective_from: '2026-08-12' },
      ],
    }, {}],
    ['архив не с D+1', { open_assignments: [{ org_department_id: ARCHIVE, effective_from: '2026-08-12' }] }, {}],
    ['открыт не архив', { open_assignments: [{ org_department_id: 'su90', effective_from: '2026-08-06' }] }, {}],
  ])('%s → пропуск', (_label, over, targetOver) => {
    expect(firedPreconditionViolation(
      state(over as Partial<IOrphanClaimState>), { ...FIRED, ...targetOver }, ARCHIVE,
    )).not.toBeNull();
  });
});

describe('repairOrphanDismissalClaims — работает (снять claim)', () => {
  it('условный UPDATE с полной сигнатурой: claim NULL, версия +1, аудит той же транзакцией, без события rehired', async () => {
    routeDb({ 462: state({ full_name: WORKING.fullName }) });
    const [item] = await repairOrphanDismissalClaims([WORKING], { apply: true });

    expect(item.result).toEqual({ status: 'claim_cleared' });
    const sql = String(h.txQuery.mock.calls[0][0]);
    expect(sql).toContain('dismissal_apply_started_at = NULL');
    expect(sql).toContain('lifecycle_revision = lifecycle_revision + 1');
    for (const guard of [
      "employment_status = 'active'",
      'dismissal_date IS NULL',
      'dismissal_apply_started_at < $2::timestamptz',
      'lifecycle_revision = 0',
      "o.status = 'pending'",
    ]) expect(sql).toContain(guard);
    expect(h.txQuery.mock.calls[0][1]).toEqual([462, ORPHAN_CLAIM_CUTOFF]);
    expect(h.auditLogWithClient).toHaveBeenCalledWith(
      expect.objectContaining({ query: h.txQuery }),
      expect.objectContaining({ action: 'RECONCILE_EMPLOYEE_REHIRE', entity_id: '462' }),
    );
    expect(h.txQuery.mock.calls.some(([q]) => String(q).includes('employee_dismissal_events'))).toBe(false);
    expect(h.openDismiss).not.toHaveBeenCalled();
  });

  it('UPDATE не задел строку → ошибка, аудита нет', async () => {
    routeDb({ 462: state({ full_name: WORKING.fullName }) });
    h.txQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const [item] = await repairOrphanDismissalClaims([WORKING], { apply: true });

    expect(item.result.status).toBe('failed');
    expect(h.auditLogWithClient).not.toHaveBeenCalled();
  });

  it('сухой прогон: запись в транзакции и откат — «planned»', async () => {
    routeDb({ 462: state({ full_name: WORKING.fullName }) });
    const [item] = await repairOrphanDismissalClaims([WORKING], { apply: false });

    expect(item.result).toEqual({ status: 'planned' });
    expect(h.txQuery).toHaveBeenCalledTimes(1);
  });

  it('неполная сигнатура → пропуск без записи', async () => {
    routeDb({ 462: state({ full_name: WORKING.fullName, lifecycle_revision: 1 }) });
    const [item] = await repairOrphanDismissalClaims([WORKING], { apply: true });

    expect(item.result.status).toBe('skipped');
    expect(h.txQuery).not.toHaveBeenCalled();
  });
});

describe('repairOrphanDismissalClaims — уволен по факту (штатная операция)', () => {
  it('операция с исходной D, D+1, текущим claim и CAS по версии 0; аудит; выполнение', async () => {
    routeDb({ 4214: state() });
    const [item] = await repairOrphanDismissalClaims([FIRED], { apply: true });

    expect(h.openDismiss).toHaveBeenCalledWith({
      employeeId: 4214,
      dismissalDate: '2026-08-05',
      source: 'manual',
      createdBy: null,
      claimedAt: CLAIM,
      expectedRevision: 0,
      effectiveDate: '2026-08-06',
      sigurSteps: 'full',
    });
    expect(h.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'FIX_SYNC_REVERTED_DISMISSAL',
      details: expect.objectContaining({ dismissal_date: '2026-08-05', operation_id: 'op-1' }),
    }));
    expect(h.executeOp).toHaveBeenCalledWith({ id: 'op-1' });
    expect(item.result).toEqual({ status: 'dismissed', dismissalDate: '2026-08-05', operationId: 'op-1' });
    expect(h.txQuery).not.toHaveBeenCalled();
  });

  it('Sigur не ответил → «в очереди», не ошибка', async () => {
    routeDb({ 4214: state() });
    h.executeOp.mockRejectedValue(new h.DismissalSigurError('Sigur 503'));
    const [item] = await repairOrphanDismissalClaims([FIRED], { apply: true });

    expect(item.result).toMatchObject({ status: 'sigur_pending', operationId: 'op-1' });
  });

  it('сухой прогон операцию не открывает', async () => {
    routeDb({ 4214: state() });
    const [item] = await repairOrphanDismissalClaims([FIRED], { apply: false });

    expect(item.result).toEqual({ status: 'planned', dismissalDate: '2026-08-05' });
    expect(h.openDismiss).not.toHaveBeenCalled();
    expect(h.executeOp).not.toHaveBeenCalled();
  });

  it('проходы после D → пропуск, операция не открывается', async () => {
    routeDb({ 4214: state({ skud_after_dismissal: 2 }) });
    const [item] = await repairOrphanDismissalClaims([FIRED], { apply: true });

    expect(item.result.status).toBe('skipped');
    expect(h.openDismiss).not.toHaveBeenCalled();
  });
});

describe('repairOrphanDismissalClaims — общие гарды', () => {
  it('ФИО не совпадает с id → ошибка до любой записи', async () => {
    routeDb({ 4214: state({ full_name: 'Другой Человек' }) });
    await expect(repairOrphanDismissalClaims([FIRED], { apply: true })).rejects.toThrow(OrphanClaimRepairError);
    expect(h.openDismiss).not.toHaveBeenCalled();
  });

  it('ошибка у одного не останавливает остальных', async () => {
    routeDb({ 4214: state(), 462: state({ full_name: WORKING.fullName }) });
    h.openDismiss.mockRejectedValue(new Error('Операция по сотруднику уже выполняется'));
    const items = await repairOrphanDismissalClaims([FIRED, WORKING], { apply: true });

    expect(items.map(item => item.result.status)).toEqual(['failed', 'claim_cleared']);
  });
});
