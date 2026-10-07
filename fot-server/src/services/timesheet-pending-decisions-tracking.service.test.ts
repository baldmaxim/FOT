import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));

const { mockCountPending } = vi.hoisted(() => ({ mockCountPending: vi.fn() }));
vi.mock('./timesheet-pending-decisions.service.js', () => ({
  countPendingDecisionsForApproval: mockCountPending,
}));

const { mockVisibleSnapshot } = vi.hoisted(() => ({ mockVisibleSnapshot: vi.fn(async () => []) }));
vi.mock('./timesheet-approval-employees-snapshot.service.js', () => ({
  listVisibleApprovalEmployees: mockVisibleSnapshot,
}));

const { mockRecipients } = vi.hoisted(() => ({
  mockRecipients: vi.fn(async (departmentId: string) => [`hr-${departmentId}`]),
}));
vi.mock('./timesheet-workflow-recipients.service.js', () => ({
  listTimesheetWorkflowRecipientIds: mockRecipients,
}));

const { mockInsertTx, mockEmitInserted } = vi.hoisted(() => ({
  mockInsertTx: vi.fn(async (_exec: unknown, items: Array<{ userId: string }>) => (
    items.map((item, i) => ({ id: `n${i}`, user_id: item.userId }))
  )),
  mockEmitInserted: vi.fn(async () => undefined),
}));
vi.mock('./notification.service.js', () => ({
  notificationService: { insertManyTx: mockInsertTx, emitInserted: mockEmitInserted },
}));

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn(async () => []) }));
vi.mock('./push.service.js', () => ({ pushService: { sendGenericNotification: mockPush } }));
vi.mock('./realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));

import { emitDomainChange } from './realtime-broadcast.service.js';
import {
  lockAffectedSubmittedApprovals,
  publishPendingDecisionEffects,
  withPendingDecisionTracking,
} from './timesheet-pending-decisions-tracking.service.js';

const DEPT_APPROVAL = {
  id: 1831, department_id: 'dept-disp', manager_employee_id: null,
  start_date: '2026-09-01', end_date: '2026-09-15', submitted_by: 'manager-uuid',
};
const PERSONAL_APPROVAL = {
  id: 1900, department_id: null, manager_employee_id: 2063,
  start_date: '2026-09-01', end_date: '2026-09-15', submitted_by: 'chepikov-uuid',
};

/** Клиент транзакции: затронутые подачи, «касание» строк, имена для текста. */
function makeExec(affected: unknown[]) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE OF a')) return { rows: affected };
      if (sql.includes('FROM org_departments')) return { rows: [{ name: 'Диспетчерская служба' }] };
      if (sql.includes('FROM employees WHERE id = $1')) return { rows: [{ full_name: 'Чепиков Алексей Владимирович' }] };
      if (sql.includes('SELECT DISTINCT org_department_id')) return { rows: [{ org_department_id: 'dept-a' }, { org_department_id: 'dept-b' }] };
      return { rows: [], rowCount: 1 };
    }),
  };
}
const touchCalls = (exec: ReturnType<typeof makeExec>) => exec.query.mock.calls
  .filter(c => String(c[0]).includes('SET updated_at = updated_at'));
const MONTHS = [{ employeeId: 523, workDate: '2026-09-06' }];

beforeEach(() => {
  vi.clearAllMocks();
  mockCountPending.mockReset();
});

describe('lockAffectedSubmittedApprovals', () => {
  it('месяц сотрудника → границы месяца, FOR UPDATE по id; пустой вход — без запроса', async () => {
    const exec = makeExec([DEPT_APPROVAL]);

    expect(await lockAffectedSubmittedApprovals(exec as never, [])).toEqual([]);
    expect(exec.query).not.toHaveBeenCalled();

    const affected = await lockAffectedSubmittedApprovals(exec as never, [
      { employeeId: 523, workDate: '2026-09-06' },
      { employeeId: 523, workDate: '2026-09-20' }, // тот же месяц — одна пара
      { employeeId: 523, workDate: '2026-10-01' },
    ]);

    expect(affected).toEqual([DEPT_APPROVAL]);
    const [sql, params] = exec.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("a.status = 'submitted'");
    expect(sql).toMatch(/ORDER BY a\.id\s+FOR UPDATE OF a/);
    expect(params).toEqual([[523, 523], ['2026-09-01', '2026-10-01'], ['2026-09-30', '2026-10-31']]);
  });
});

describe('withPendingDecisionTracking', () => {
  it('переход до > 0 → после = 0: уведомление «готов» в той же транзакции, строка табеля «касается»', async () => {
    const exec = makeExec([DEPT_APPROVAL]);
    mockCountPending.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const mutate = vi.fn(async () => ({ value: 'ok', changed: true }));

    const { value, effects } = await withPendingDecisionTracking(exec as never, MONTHS, mutate);

    expect(value).toBe('ok');
    // «до» считается до мутации, «после» — после неё и через тот же клиент.
    expect(mockCountPending.mock.invocationCallOrder[0]).toBeLessThan(mutate.mock.invocationCallOrder[0]);
    expect(mockCountPending.mock.calls.every(c => c[1] === exec)).toBe(true);
    expect(touchCalls(exec)).toHaveLength(1);
    expect(touchCalls(exec)[0][1]).toEqual([[1831]]);
    expect(mockInsertTx).toHaveBeenCalledTimes(1);
    const [txArg, items] = mockInsertTx.mock.calls[0] as [unknown, Array<Record<string, unknown>>];
    expect(txArg).toBe(exec);
    expect(items).toEqual([expect.objectContaining({
      userId: 'hr-dept-disp',
      type: 'timesheet_approval_ready',
      title: 'Табель готов к утверждению',
      body: 'Отдел Диспетчерская служба: табель за 1–15 сен 2026 — выходные согласованы, можно утверждать.',
    })]);
    expect(effects.affected).toEqual([DEPT_APPROVAL]);
    expect(effects.notifications).toHaveLength(1);
    expect(effects.pushes).toEqual([expect.objectContaining({
      recipients: ['hr-dept-disp'],
      data: expect.objectContaining({ tag: 'timesheet-ready:1831' }),
    })]);
  });

  it('остались нерешённые (2 → 1) — без уведомления', async () => {
    const exec = makeExec([DEPT_APPROVAL]);
    mockCountPending.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    const { effects } = await withPendingDecisionTracking(exec as never, MONTHS, async () => ({ value: null, changed: true }));

    expect(mockInsertTx).toHaveBeenCalledWith(exec, []);
    expect(effects.notifications).toEqual([]);
    expect(effects.affected).toEqual([DEPT_APPROVAL]);
  });

  it('ждать было нечего (0 → новое заявление) — «после» не считается, уведомления нет', async () => {
    const exec = makeExec([DEPT_APPROVAL]);
    mockCountPending.mockResolvedValueOnce(0);

    const { effects } = await withPendingDecisionTracking(exec as never, MONTHS, async () => ({ value: null, changed: true }));

    expect(mockCountPending).toHaveBeenCalledTimes(1);
    expect(effects.notifications).toEqual([]);
    // Строку табеля «касаемся» всё равно: HR-утверждение должно увидеть новое заявление.
    expect(touchCalls(exec)).toHaveLength(1);
  });

  it('мутация ничего не записала (повтор, замок) — ни «касания», ни «после», ни эффектов', async () => {
    const exec = makeExec([DEPT_APPROVAL]);
    mockCountPending.mockResolvedValueOnce(1);

    const { effects } = await withPendingDecisionTracking(exec as never, MONTHS, async () => ({ value: null, changed: false }));

    expect(mockCountPending).toHaveBeenCalledTimes(1);
    expect(touchCalls(exec)).toHaveLength(0);
    expect(mockInsertTx).not.toHaveBeenCalled();
    expect(effects).toEqual({ affected: [], notifications: [], pushes: [] });
  });

  it('ошибка мутации пробрасывается — уведомление не пишется (транзакция откатится)', async () => {
    const exec = makeExec([DEPT_APPROVAL]);
    mockCountPending.mockResolvedValue(1);

    await expect(withPendingDecisionTracking(exec as never, MONTHS, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(mockInsertTx).not.toHaveBeenCalled();
  });

  it('персональная подача: получатели — по отделам видимого снимка', async () => {
    const exec = makeExec([PERSONAL_APPROVAL]);
    mockVisibleSnapshot.mockResolvedValueOnce([{ employee_id: 523 }, { employee_id: 1600 }] as never);
    mockCountPending.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await withPendingDecisionTracking(exec as never, MONTHS, async () => ({ value: null, changed: true }));

    const items = mockInsertTx.mock.calls[0][1] as Array<{ userId: string; body: string }>;
    expect(items.map(i => i.userId).sort()).toEqual(['hr-dept-a', 'hr-dept-b']);
    expect(items[0].body).toBe(
      'Персональная подача (Чепиков Алексей Владимирович): табель за 1–15 сен 2026 — выходные согласованы, можно утверждать.',
    );
  });
});

describe('publishPendingDecisionEffects', () => {
  it('realtime подавшему и кадрам по каждой затронутой подаче, затем socket и push «готов»', async () => {
    await publishPendingDecisionEffects({
      affected: [DEPT_APPROVAL],
      notifications: [{ id: 'n0', user_id: 'hr-dept-disp' } as never],
      pushes: [{ recipients: ['hr-dept-disp'], title: 'T', body: 'B', data: { tag: 'timesheet-ready:1831' } }],
    });

    expect(emitDomainChange).toHaveBeenCalledWith({
      event: 'timesheet_approval:changed',
      targetUserIds: expect.arrayContaining(['hr-dept-disp', 'manager-uuid']),
      payload: { entityId: 1831, action: 'pending_decisions' },
    });
    expect(mockEmitInserted).toHaveBeenCalledWith([{ id: 'n0', user_id: 'hr-dept-disp' }]);
    expect(mockPush).toHaveBeenCalledWith(['hr-dept-disp'], 'T', 'B', { tag: 'timesheet-ready:1831' });
  });

  it('сбой доставки не пробрасывается (best effort после коммита)', async () => {
    mockRecipients.mockRejectedValueOnce(new Error('db down'));
    await expect(publishPendingDecisionEffects({
      affected: [DEPT_APPROVAL], notifications: [], pushes: [],
    })).resolves.toBeUndefined();
  });
});
