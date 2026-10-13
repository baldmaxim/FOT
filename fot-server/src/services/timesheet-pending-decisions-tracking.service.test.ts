import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery }));

const { mockCountPending, mockFacts } = vi.hoisted(() => ({
  mockCountPending: vi.fn(),
  mockFacts: vi.fn(),
}));
vi.mock('./timesheet-pending-decisions.service.js', () => ({
  countPendingDecisionsForApproval: mockCountPending,
  listPendingDecisionFacts: mockFacts,
  countPendingDecisionDays: (facts: { days: unknown[]; requests: unknown[] }) => facts.days.length + facts.requests.length,
}));

// Дерево отделов — справочник за кэшем; в срезе каждый отдел без подотделов, кроме GROUP.
const GROUP = 'dept-group';
vi.mock('./skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(async (departmentId: string) => (
    departmentId === 'dept-group' ? [departmentId, 'dept-child'] : [departmentId]
  )),
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
  lockAffectedApprovals,
  publishPendingDecisionEffects,
  withPendingDecisionTracking,
} from './timesheet-pending-decisions-tracking.service.js';

const DEPT_APPROVAL = {
  id: 1831, department_id: 'dept-disp', manager_employee_id: null,
  start_date: '2026-09-01', end_date: '2026-09-15', status: 'submitted' as const, submitted_by: 'manager-uuid',
};
const PERSONAL_APPROVAL = {
  id: 1900, department_id: null, manager_employee_id: 2063,
  start_date: '2026-09-01', end_date: '2026-09-15', status: 'submitted' as const, submitted_by: 'chepikov-uuid',
};
/** Утверждён, но открыт кадрами для правок. */
const OPENED_APPROVAL = { ...DEPT_APPROVAL, id: 1777, status: 'approved' as const, submitted_by: null };

interface IOpenMonthFixture {
  /** Отделы сотрудника в месяце (кандидаты на «неподанный табель»). */
  candidates?: Array<{ department_id: string; m_start: string; m_end: string }>;
  /** Подачи отдела и вышестоящих, пересекающие месяц. */
  active?: Array<{
    department_id: string; depth: number; start_date: string; end_date: string; status: string; locked: boolean;
  }>;
}
const SEPTEMBER = { department_id: 'dept-disp', m_start: '2026-09-01', m_end: '2026-09-30' };
const DAY = (workDate: string) => ({ adjustment_id: 1, employee_id: 523, work_date: workDate });

/** Клиент транзакции: затронутые подачи, «касание» строк, имена для текста. */
function makeExec(affected: unknown[], openMonth: IOpenMonthFixture = {}) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE OF a')) return { rows: affected };
      if (sql.includes('CROSS JOIN LATERAL')) return { rows: openMonth.candidates ?? [] };
      if (sql.includes('AS locked')) return { rows: openMonth.active ?? [] };
      if (sql.includes('FROM org_departments')) return { rows: [{ name: 'Диспетчерская служба' }] };
      if (sql.includes('FROM employees WHERE id = $1')) return { rows: [{ full_name: 'Чепиков Алексей Владимирович' }] };
      if (sql.includes('SELECT DISTINCT org_department_id')) return { rows: [{ org_department_id: 'dept-a' }, { org_department_id: 'dept-b' }] };
      return { rows: [], rowCount: 1 };
    }),
  };
}
const touchCalls = (exec: ReturnType<typeof makeExec>) => exec.query.mock.calls
  .filter(c => String(c[0]).includes('SET updated_at = updated_at'));
const advisoryCalls = (exec: ReturnType<typeof makeExec>) => exec.query.mock.calls
  .filter(c => String(c[0]).includes('pg_advisory_xact_lock'));
const MONTHS = [{ employeeId: 523, workDate: '2026-09-06' }];

beforeEach(() => {
  vi.clearAllMocks();
  mockCountPending.mockReset();
  mockFacts.mockReset();
  mockFacts.mockResolvedValue({ days: [], requests: [] });
  // «Завершённый месяц» зависит от сегодняшней даты: фиксируем её, сентябрь 2026 завершён.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T09:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('lockAffectedApprovals', () => {
  it('месяц сотрудника → границы месяца, FOR UPDATE по id; пустой вход — без запроса', async () => {
    const exec = makeExec([DEPT_APPROVAL]);

    expect(await lockAffectedApprovals(exec as never, [])).toEqual([]);
    expect(exec.query).not.toHaveBeenCalled();

    const affected = await lockAffectedApprovals(exec as never, [
      { employeeId: 523, workDate: '2026-09-06' },
      { employeeId: 523, workDate: '2026-09-20' }, // тот же месяц — одна пара
      { employeeId: 523, workDate: '2026-10-01' },
    ]);

    expect(affected).toEqual([DEPT_APPROVAL]);
    const [sql, params] = exec.query.mock.calls[0] as [string, unknown[]];
    // Поданные и утверждённые, открытые для правок; закрытые утверждённые — нет.
    expect(sql).toContain("(a.status = 'submitted' OR (a.status = 'approved' AND a.unlocked_at IS NOT NULL))");
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
    // «Готов к утверждению» видят и наблюдатели (табельщицы).
    expect(mockRecipients).toHaveBeenCalledWith('dept-disp', ['review', 'monitor']);
  });

  it('утверждённый открытый табель: «можно закрыть» только тем, кто закрывает, с напоминанием о файле', async () => {
    const exec = makeExec([OPENED_APPROVAL]);
    mockCountPending.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const { effects } = await withPendingDecisionTracking(exec as never, MONTHS, async () => ({ value: null, changed: true }));

    const items = mockInsertTx.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(items).toEqual([expect.objectContaining({
      userId: 'hr-dept-disp',
      type: 'timesheet_close_ready',
      title: 'Табель можно закрыть',
      body: 'Отдел Диспетчерская служба: табель за 1–15 сен 2026 — выходные согласованы. '
        + 'Закройте табель и выгрузите единый файл для 1С заново.',
    })]);
    expect(mockRecipients).toHaveBeenCalledWith('dept-disp', ['review']);
    expect(effects.pushes[0].data).toEqual(expect.objectContaining({ tag: 'timesheet-close-ready:1777' }));
    // Строку «касаемся»: параллельное «Закрыть табель» обязано увидеть свежие выходные.
    expect(touchCalls(exec)[0][1]).toEqual([[1777]]);
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

describe('неподанный табель завершённого месяца', () => {
  const decide = (exec: ReturnType<typeof makeExec>, months = MONTHS) => withPendingDecisionTracking(
    exec as never, months, async () => ({ value: null, changed: true }),
  );
  const closeReadyItems = () => ((mockInsertTx.mock.calls[0]?.[1] ?? []) as Array<Record<string, unknown>>)
    .filter(item => item.type === 'timesheet_close_ready');

  it('в месяце решён последний выходной → одно «можно закрыть» за весь месяц, только закрывающим', async () => {
    const exec = makeExec([], { candidates: [SEPTEMBER] });
    mockFacts
      .mockResolvedValueOnce({ days: [DAY('2026-09-19')], requests: [] })
      .mockResolvedValueOnce({ days: [], requests: [] });

    const { effects } = await decide(exec);

    // Счётчик — по отделу за весь месяц, через клиент транзакции.
    expect(mockFacts).toHaveBeenCalledWith(
      { kind: 'department', departmentId: 'dept-disp' },
      { startDate: '2026-09-01', endDate: '2026-09-30' },
      exec,
    );
    expect(advisoryCalls(exec)).toHaveLength(1);
    expect(advisoryCalls(exec)[0][1]).toEqual(['timesheet:open-month:dept-disp:2026-09']);
    expect(closeReadyItems()).toEqual([expect.objectContaining({
      userId: 'hr-dept-disp',
      title: 'Табель можно закрыть',
      body: 'Отдел Диспетчерская служба: табель за 1–30 сен 2026 — выходные согласованы. '
        + 'Выгрузите единый файл для 1С и закройте табель.',
      metadata: expect.objectContaining({ departmentId: 'dept-disp', start_date: '2026-09-01', end_date: '2026-09-30' }),
    })]);
    expect(mockRecipients).toHaveBeenCalledWith('dept-disp', ['review']);
    expect(effects.pushes).toEqual([expect.objectContaining({
      data: expect.objectContaining({ tag: 'timesheet-close-ready:dept-disp:2026-09-01' }),
    })]);
    // Подач нет — «касаться» нечего.
    expect(touchCalls(exec)).toHaveLength(0);
  });

  it('в месяце ещё ждёт другой выходной (2 → 1) — уведомления нет', async () => {
    const exec = makeExec([], { candidates: [SEPTEMBER] });
    mockFacts
      .mockResolvedValueOnce({ days: [DAY('2026-09-05'), DAY('2026-09-19')], requests: [] })
      .mockResolvedValueOnce({ days: [DAY('2026-09-19')], requests: [] });

    await decide(exec);

    expect(closeReadyItems()).toEqual([]);
  });

  it('1–15 подан, 16–30 нет: «можно закрыть» только за неподанную половину', async () => {
    const exec = makeExec([], {
      candidates: [SEPTEMBER],
      active: [{ department_id: 'dept-disp', depth: 1, start_date: '2026-09-01', end_date: '2026-09-15', status: 'submitted', locked: true }],
    });
    mockFacts
      .mockResolvedValueOnce({ days: [DAY('2026-09-19')], requests: [] })
      .mockResolvedValueOnce({ days: [], requests: [] });

    await decide(exec);

    expect(closeReadyItems()).toEqual([expect.objectContaining({
      body: 'Отдел Диспетчерская служба: табель за 16–30 сен 2026 — выходные согласованы. '
        + 'Выгрузите единый файл для 1С и закройте табель.',
    })]);
  });

  it('выходной в уже закрытой половине закрытию остального не мешает — его не считаем', async () => {
    const exec = makeExec([], {
      candidates: [SEPTEMBER],
      active: [{ department_id: 'dept-disp', depth: 1, start_date: '2026-09-01', end_date: '2026-09-15', status: 'approved', locked: true }],
    });
    // Единственное ожидание месяца лежит за замком 1–15: неподанной половине ждать нечего.
    mockFacts.mockResolvedValue({ days: [DAY('2026-09-05')], requests: [] });

    const { effects } = await decide(exec);

    expect(mockFacts).toHaveBeenCalledTimes(1);
    expect(mockInsertTx).not.toHaveBeenCalled();
    expect(effects).toEqual({ affected: [], notifications: [], pushes: [] });
  });

  it.each([
    ['оба полупериода поданы или утверждены', [
      { department_id: 'dept-disp', depth: 1, start_date: '2026-09-01', end_date: '2026-09-15', status: 'approved', locked: true },
      { department_id: 'dept-disp', depth: 1, start_date: '2026-09-16', end_date: '2026-09-30', status: 'submitted', locked: true },
    ]],
    ['возвращённая подача нестандартного диапазона — её закрывают вручную', [
      { department_id: 'dept-disp', depth: 1, start_date: '2026-09-10', end_date: '2026-09-20', status: 'returned', locked: true },
    ]],
    ['действующая подача вышестоящего отдела', [
      { department_id: 'dept-disp', depth: 2, start_date: '2026-09-01', end_date: '2026-09-30', status: 'returned', locked: true },
    ]],
  ])('неподанных половин нет (%s) — месяц не отслеживается', async (_name, active) => {
    const exec = makeExec([], { candidates: [SEPTEMBER], active });

    await decide(exec);

    expect(mockFacts).not.toHaveBeenCalled();
    expect(mockInsertTx).not.toHaveBeenCalled();
  });

  it('своя возвращённая подача, покрывающая половину, — половина считается неподанной', async () => {
    const exec = makeExec([], {
      candidates: [SEPTEMBER],
      active: [
        { department_id: 'dept-disp', depth: 1, start_date: '2026-09-01', end_date: '2026-09-15', status: 'returned', locked: true },
        { department_id: 'dept-disp', depth: 1, start_date: '2026-09-16', end_date: '2026-09-30', status: 'approved', locked: true },
      ],
    });
    mockFacts
      .mockResolvedValueOnce({ days: [DAY('2026-09-05')], requests: [] })
      .mockResolvedValueOnce({ days: [], requests: [] });

    await decide(exec);

    expect(closeReadyItems()).toEqual([expect.objectContaining({
      metadata: expect.objectContaining({ start_date: '2026-09-01', end_date: '2026-09-15' }),
    })]);
  });

  it('отдел с подотделами не отслеживается — его табель подаёт руководитель', async () => {
    const exec = makeExec([], { candidates: [{ ...SEPTEMBER, department_id: GROUP }] });

    await decide(exec);

    expect(advisoryCalls(exec)).toHaveLength(0);
    expect(mockFacts).not.toHaveBeenCalled();
  });

  it('месяц ещё не завершён — закрывать нечего, ветка не выполняется', async () => {
    const exec = makeExec([], { candidates: [{ department_id: 'dept-disp', m_start: '2026-10-01', m_end: '2026-10-31' }] });

    await decide(exec, [{ employeeId: 523, workDate: '2026-10-10' }]);

    expect(exec.query.mock.calls.some(c => String(c[0]).includes('CROSS JOIN LATERAL'))).toBe(false);
    expect(mockFacts).not.toHaveBeenCalled();
    expect(mockInsertTx).not.toHaveBeenCalled();
  });
});
