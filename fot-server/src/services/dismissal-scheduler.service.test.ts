import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  applyDismissal: vi.fn(),
  insertHistory: vi.fn(),
  loadLifecycle: vi.fn(),
  invalidate: vi.fn(),
  auditLog: vi.fn(),
  resumeOps: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.query, execute: h.execute }));
vi.mock('../controllers/employee-lifecycle.controller.js', () => ({
  applyDismissalImmediately: h.applyDismissal,
  insertDismissalHistory: h.insertHistory,
  loadEmployeeLifecycleRow: h.loadLifecycle,
}));
vi.mock('./employee-lifecycle-operations.service.js', () => ({
  resumeExpiredOperations: h.resumeOps,
}));
vi.mock('./audit.service.js', () => ({ auditService: { log: h.auditLog } }));
vi.mock('./employee-cache.service.js', () => ({ employeeCache: { invalidate: h.invalidate } }));
vi.mock('../utils/sentry-cron.js', () => ({
  runWithCronMonitor: async (_name: string, fn: () => Promise<unknown>) => fn(),
}));

import { startDismissalScheduler, stopDismissalScheduler } from './dismissal-scheduler.service.js';

const CLAIMED_AT = '2026-05-20 23:00:01.123456+03';

/** Первый claim отдаёт сотрудника, второй — пусто (цикл завершается). */
const claimOnce = (id = 77): void => {
  let calls = 0;
  h.query.mockImplementation(async () => (calls++ === 0 ? [{ id, claimed_at: CLAIMED_AT }] : []));
};

const runStartupTick = async (): Promise<void> => {
  startDismissalScheduler();
  await vi.advanceTimersByTimeAsync(46_000);
  stopDismissalScheduler();
  await Promise.resolve();
};

describe('dismissal-scheduler', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T20:30:00Z')); // 23:30 МСК — порог пройден
    h.execute.mockResolvedValue(undefined);
    h.loadLifecycle.mockResolvedValue({
      id: 77,
      employment_status: 'active',
      dismissal_date: '2026-05-20',
      sigur_employee_id: 555,
    });
    h.applyDismissal.mockResolvedValue({ fromDepartmentId: 'dept-1' });
    h.resumeOps.mockResolvedValue({ resumed: 0, applied: 0, failed: 0 });
  });
  afterEach(() => {
    stopDismissalScheduler();
    vi.useRealTimers();
  });

  it('после 23:00 МСК берёт сегодняшнюю дату как границу применения', async () => {
    claimOnce();
    await runStartupTick();

    expect(h.query.mock.calls[0][1]).toEqual(['2026-05-20', '30']);
    expect(h.query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(h.applyDismissal).toHaveBeenCalledTimes(1);
    // Событие истории пишет durable-операция, планировщик его не дублирует.
    expect(h.insertHistory).not.toHaveBeenCalled();
    expect(h.applyDismissal).toHaveBeenCalledWith(expect.objectContaining({ claimedAt: CLAIMED_AT, source: 'scheduler' }));
  });

  it('тик сначала доводит незавершённые durable-операции, потом берёт claim', async () => {
    const order: string[] = [];
    h.resumeOps.mockImplementation(async () => { order.push('resume'); return { resumed: 1, applied: 1, failed: 0 }; });
    h.query.mockImplementation(async () => { order.push('claim'); return []; });
    await runStartupTick();

    expect(h.resumeOps).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('resume');
    expect(order).toContain('claim');
  });

  it('ошибка повтора операций не блокирует применение отложенных увольнений', async () => {
    h.resumeOps.mockRejectedValue(new Error('db down'));
    claimOnce();
    await runStartupTick();

    expect(h.applyDismissal).toHaveBeenCalledTimes(1);
  });

  it('до 23:00 МСК граница — вчера (сегодняшние увольнения ещё не применяются)', async () => {
    vi.setSystemTime(new Date('2026-05-20T19:00:00Z')); // 22:00 МСК
    h.query.mockResolvedValue([]);
    await runStartupTick();

    expect(h.query.mock.calls[0][1]).toEqual(['2026-05-19', '30']);
    expect(h.applyDismissal).not.toHaveBeenCalled();
  });

  it('claim → apply → claim, пока запрос не вернёт пусто', async () => {
    let calls = 0;
    h.query.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return [{ id: 70 + calls, claimed_at: CLAIMED_AT }];
      return [];
    });
    await runStartupTick();

    expect(h.applyDismissal).toHaveBeenCalledTimes(2);
    expect(h.query).toHaveBeenCalledTimes(3);
  });

  it('ошибка применения → claim НЕ снимается (повтор после истечения lease)', async () => {
    claimOnce();
    h.applyDismissal.mockRejectedValue(new Error('Sigur down'));
    await runStartupTick();

    // Снятие claim вернуло бы сотрудника в выборку тем же циклом — горячая петля
    // до MAX_PER_CYCLE попыток по падающему Sigur.
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('ошибка применения не приводит к повторному захвату того же сотрудника в цикле', async () => {
    // claim отдаёт сотрудника, пока его lease свободен; после ошибки claim держится,
    // поэтому второй запрос выборки возвращает пусто и цикл завершается.
    let calls = 0;
    h.query.mockImplementation(async () => (calls++ === 0 ? [{ id: 77, claimed_at: CLAIMED_AT }] : []));
    h.applyDismissal.mockRejectedValue(new Error('Sigur down'));
    await runStartupTick();

    expect(h.applyDismissal).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('запись уже не active (успели отменить/уволить) → lease отпускается без применения', async () => {
    claimOnce();
    h.loadLifecycle.mockResolvedValue({ id: 77, employment_status: 'active', dismissal_date: null });
    await runStartupTick();

    expect(h.applyDismissal).not.toHaveBeenCalled();
    expect(h.execute.mock.calls[0][1]).toEqual([77, CLAIMED_AT]);
  });
});
