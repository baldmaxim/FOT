import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshot = vi.hoisted(() => ({
  loadActiveSnapshotRun: vi.fn(),
  rebuildMainObjectSnapshot: vi.fn(),
}));
vi.mock('./employee-main-object-snapshot.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./employee-main-object-snapshot.service.js')>();
  return { ...actual, ...snapshot };
});

const {
  resetMainObjectSnapshotSchedulerState,
  runMainObjectSnapshotTick,
  shouldRebuildSnapshot,
  SNAPSHOT_RETRY_AFTER_FAILURE_MS,
} = await import('./employee-main-object-snapshot.scheduler.js');

/** МСК = UTC+3. */
const msk = (iso: string): Date => new Date(`${iso}+03:00`);
const run = (end: string) => ({ id: 1, period: { start: '2026-08-15', end }, finishedAt: null });

beforeEach(() => {
  snapshot.loadActiveSnapshotRun.mockReset();
  snapshot.rebuildMainObjectSnapshot.mockReset().mockResolvedValue({
    period: { start: '2026-08-15', end: '2026-09-13' }, employees: 10, withObject: 5, durationMs: 1, dryRun: false,
  });
  resetMainObjectSnapshotSchedulerState();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('shouldRebuildSnapshot', () => {
  it('снимка нет — считать сразу, в любое время', () => {
    expect(shouldRebuildSnapshot(null, msk('2026-09-14T12:00:00'))).toBe(true);
    expect(shouldRebuildSnapshot(null, msk('2026-09-14T01:00:00'))).toBe(true);
  });

  it('в снимке уже есть вчерашний день — не считать', () => {
    expect(shouldRebuildSnapshot(run('2026-09-13'), msk('2026-09-14T12:00:00'))).toBe(false);
    expect(shouldRebuildSnapshot(run('2026-09-13'), msk('2026-09-14T03:05:00'))).toBe(false);
  });

  it('снимок устарел — только с 03:00 МСК', () => {
    const stale = run('2026-09-12');
    expect(shouldRebuildSnapshot(stale, msk('2026-09-14T00:30:00'))).toBe(false);
    expect(shouldRebuildSnapshot(stale, msk('2026-09-14T02:59:00'))).toBe(false);
    expect(shouldRebuildSnapshot(stale, msk('2026-09-14T03:00:00'))).toBe(true);
    expect(shouldRebuildSnapshot(stale, msk('2026-09-14T15:00:00'))).toBe(true);
  });
});

describe('runMainObjectSnapshotTick', () => {
  it('свежий снимок — пересчёт не запускается', async () => {
    snapshot.loadActiveSnapshotRun.mockResolvedValue(run('2026-09-13'));
    await runMainObjectSnapshotTick(msk('2026-09-14T04:00:00'));
    expect(snapshot.rebuildMainObjectSnapshot).not.toHaveBeenCalled();
  });

  it('устаревший снимок ночью — пересчёт с тем же now', async () => {
    const now = msk('2026-09-14T04:00:00');
    snapshot.loadActiveSnapshotRun.mockResolvedValue(run('2026-09-12'));
    await runMainObjectSnapshotTick(now);
    expect(snapshot.rebuildMainObjectSnapshot).toHaveBeenCalledWith({ now });
  });

  it('параллельные тики не запускают второй пересчёт', async () => {
    snapshot.loadActiveSnapshotRun.mockResolvedValue(null);
    let release: () => void = () => {};
    snapshot.rebuildMainObjectSnapshot.mockImplementation(() => new Promise(resolve => {
      release = () => resolve({ period: { start: 'a', end: 'b' }, employees: 0, withObject: 0, durationMs: 0, dryRun: false });
    }));

    const now = msk('2026-09-14T04:00:00');
    const first = runMainObjectSnapshotTick(now);
    const second = runMainObjectSnapshotTick(now);
    await vi.waitFor(() => expect(snapshot.rebuildMainObjectSnapshot).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    expect(snapshot.rebuildMainObjectSnapshot).toHaveBeenCalledTimes(1);
  });

  it('после сбоя повтор не раньше чем через час', async () => {
    snapshot.loadActiveSnapshotRun.mockResolvedValue(run('2026-09-12'));
    snapshot.rebuildMainObjectSnapshot.mockRejectedValueOnce(new Error('boom'));
    const failedAt = msk('2026-09-14T04:00:00');

    await runMainObjectSnapshotTick(failedAt);
    await runMainObjectSnapshotTick(new Date(failedAt.getTime() + 15 * 60_000));
    expect(snapshot.rebuildMainObjectSnapshot).toHaveBeenCalledTimes(1);

    await runMainObjectSnapshotTick(new Date(failedAt.getTime() + SNAPSHOT_RETRY_AFTER_FAILURE_MS));
    expect(snapshot.rebuildMainObjectSnapshot).toHaveBeenCalledTimes(2);
  });

  it('флаг «идёт расчёт» не залипает: после пропущенных тиков следующий работает', async () => {
    snapshot.loadActiveSnapshotRun.mockResolvedValueOnce(run('2026-09-13')); // свежий — пропуск
    await runMainObjectSnapshotTick(msk('2026-09-14T04:00:00'));
    snapshot.loadActiveSnapshotRun.mockResolvedValueOnce(run('2026-09-13'));
    await runMainObjectSnapshotTick(msk('2026-09-14T04:15:00'));
    snapshot.loadActiveSnapshotRun.mockResolvedValueOnce(run('2026-09-13'));
    await runMainObjectSnapshotTick(msk('2026-09-15T04:00:00')); // уже устарел
    expect(snapshot.loadActiveSnapshotRun).toHaveBeenCalledTimes(3);
    expect(snapshot.rebuildMainObjectSnapshot).toHaveBeenCalledTimes(1);
  });

  it('сбой чтения журнала не роняет тик', async () => {
    snapshot.loadActiveSnapshotRun.mockRejectedValue(new Error('db down'));
    await expect(runMainObjectSnapshotTick(msk('2026-09-14T04:00:00'))).resolves.toBeUndefined();
    expect(snapshot.rebuildMainObjectSnapshot).not.toHaveBeenCalled();
  });
});
