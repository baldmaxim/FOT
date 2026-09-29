import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Планировщик объекта табелирования (миграция 288): порядок шагов по состоянию в БД —
 * фиксация прошедших месяцев по одному, пересборка объектов редакций, затем пересчёт
 * текущего месяца. applied_date двигает только пересчёт текущего месяца.
 */

const h = vi.hoisted(() => ({
  state: vi.fn(),
  freeze: vi.fn(),
  recompute: vi.fn(),
  rebuild: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.query }));
vi.mock('./employee-timesheet-object.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./employee-timesheet-object.service.js')>()),
  readTimesheetObjectState: h.state,
}));
vi.mock('./employee-timesheet-object-auto.service.js', () => ({
  freezeMonth: h.freeze,
  recomputeCurrentMonth: h.recompute,
}));
vi.mock('./timesheet-version-objects-rebuild.service.js', () => ({
  rebuildVersionObjectsForMonth: h.rebuild,
}));

const {
  nextTimesheetObjectStep,
  resetTimesheetObjectSchedulerState,
  runTimesheetObjectTick,
} = await import('./employee-timesheet-object.scheduler.js');

const msk = (iso: string): Date => new Date(`${iso}+03:00`);

type State = NonNullable<Parameters<typeof nextTimesheetObjectStep>[0]>;
const state = (over: Partial<State> = {}): State => ({
  enabled: true,
  baseline_month: '2026-08-01',
  frozen_month: '2026-08-01',
  objects_rebuilt_month: '2026-08-01',
  applied_date: '2026-09-28',
  ...over,
});

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  resetTimesheetObjectSchedulerState();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('nextTimesheetObjectStep', () => {
  it('выключен или раньше 04:00 МСК — ничего', () => {
    expect(nextTimesheetObjectStep(state({ enabled: false }), msk('2026-09-29T12:00:00'))).toEqual({ kind: 'idle' });
    expect(nextTimesheetObjectStep(null, msk('2026-09-29T12:00:00'))).toEqual({ kind: 'idle' });
    expect(nextTimesheetObjectStep(state({ applied_date: '2026-09-28' }), msk('2026-09-29T03:59:00'))).toEqual({ kind: 'idle' });
  });

  it('1-е число: сначала фиксация прошлого месяца, пересчёта текущего нет', () => {
    const now = msk('2026-10-01T04:05:00');
    expect(nextTimesheetObjectStep(state(), now)).toEqual({ kind: 'freeze', month: '2026-09-01' });
    const afterFreeze = state({ frozen_month: '2026-09-01' });
    expect(nextTimesheetObjectStep(afterFreeze, now)).toEqual({ kind: 'rebuild', month: '2026-09-01' });
    const afterRebuild = state({ frozen_month: '2026-09-01', objects_rebuilt_month: '2026-09-01' });
    expect(nextTimesheetObjectStep(afterRebuild, now)).toEqual({ kind: 'idle' });
  });

  it('пропуск двух границ месяца: фиксация по одному месяцу подряд', () => {
    const now = msk('2026-11-03T10:00:00');
    expect(nextTimesheetObjectStep(state(), now)).toEqual({ kind: 'freeze', month: '2026-09-01' });
    expect(nextTimesheetObjectStep(state({ frozen_month: '2026-09-01' }), now))
      .toEqual({ kind: 'freeze', month: '2026-10-01' });
  });

  it('пересчёт текущего месяца — если за сегодня не делался', () => {
    const now = msk('2026-09-29T04:30:00');
    expect(nextTimesheetObjectStep(state({ applied_date: '2026-09-28' }), now)).toEqual({ kind: 'recompute' });
    expect(nextTimesheetObjectStep(state({ applied_date: '2026-09-29' }), now)).toEqual({ kind: 'idle' });
    expect(nextTimesheetObjectStep(state({ applied_date: null }), now)).toEqual({ kind: 'recompute' });
  });

  it('сбойная пересборка не блокирует пересчёт текущего месяца', () => {
    const now = msk('2026-10-02T05:00:00');
    const s = state({ frozen_month: '2026-09-01', applied_date: '2026-10-01' });
    expect(nextTimesheetObjectStep(s, now)).toEqual({ kind: 'rebuild', month: '2026-09-01' });
    expect(nextTimesheetObjectStep(s, now, { skipRebuild: true })).toEqual({ kind: 'recompute' });
  });
});

describe('runTimesheetObjectTick', () => {
  it('догон: фиксация → пересборка → пересчёт в одном тике, по порядку', async () => {
    const now = msk('2026-10-02T04:10:00');
    let current = state({ applied_date: '2026-09-30' });
    h.state.mockImplementation(async () => current);
    h.freeze.mockImplementation(async (month: string) => {
      current = { ...current, frozen_month: month };
      return { kind: 'frozen', month, changed: 3, rows: 10 };
    });
    h.rebuild.mockResolvedValue({ approvals: 2, created: 1, failures: 0 });
    h.query.mockImplementation(async (_sql: string, params: string[]) => {
      current = { ...current, objects_rebuilt_month: params[0] };
      return [];
    });
    h.recompute.mockResolvedValue({ kind: 'applied', period: { start: '2026-10-01', end: '2026-10-01' }, changed: 0 });

    await runTimesheetObjectTick(now);

    expect(h.freeze).toHaveBeenCalledWith('2026-09-01', now);
    expect(h.rebuild).toHaveBeenCalledWith('2026-09-01');
    expect(h.recompute).toHaveBeenCalledWith(now);
    const order = [h.freeze, h.rebuild, h.recompute].map(fn => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('пересборка со сбоями: месяц не отмечается пересобранным, пересчёт всё равно идёт', async () => {
    const now = msk('2026-10-02T04:10:00');
    h.state.mockResolvedValue(state({ frozen_month: '2026-09-01', applied_date: '2026-10-01' }));
    h.rebuild.mockResolvedValue({ approvals: 2, created: 0, failures: 1 });
    h.recompute.mockResolvedValue({ kind: 'applied', period: { start: '2026-10-01', end: '2026-10-01' }, changed: 0 });

    await runTimesheetObjectTick(now);

    expect(h.query).not.toHaveBeenCalled();
    expect(h.recompute).toHaveBeenCalledTimes(1);
  });

  it('миграция не применена (42P01) — тик тихо выходит', async () => {
    h.state.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    await runTimesheetObjectTick(msk('2026-09-29T05:00:00'));
    expect(h.freeze).not.toHaveBeenCalled();
    expect(h.recompute).not.toHaveBeenCalled();
  });
});
