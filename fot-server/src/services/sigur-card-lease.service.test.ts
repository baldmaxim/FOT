import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  tryAcquire: vi.fn(),
  release: vi.fn(),
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
  heartbeatParams: null as null | {
    onLost?: () => void;
    onError?: (error: Error) => void;
  },
}));

vi.mock('./sigur-runtime-state.service.js', () => ({
  tryAcquireSigurRuntimeLease: h.tryAcquire,
  releaseSigurRuntimeLease: h.release,
  startSigurRuntimeLeaseHeartbeat: h.startHeartbeat,
}));

const {
  acquireSigurCardLease,
  withSigurCardWriteLease,
  SigurCardLeaseBusyError,
  SIGUR_CARD_WRITE_LEASE_KEY,
} = await import('./sigur-card-lease.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  h.heartbeatParams = null;
  h.tryAcquire.mockResolvedValue({ acquired: true, row: null });
  h.release.mockResolvedValue(true);
  h.startHeartbeat.mockImplementation((params: NonNullable<typeof h.heartbeatParams>) => {
    h.heartbeatParams = params;
    return h.stopHeartbeat;
  });
});

describe('acquireSigurCardLease', () => {
  it('занятый lock даёт SigurCardLeaseBusyError', async () => {
    h.tryAcquire.mockResolvedValue({ acquired: false, row: null });

    await expect(acquireSigurCardLease({ owner: 'op-1', ttlSeconds: 60 }))
      .rejects.toBeInstanceOf(SigurCardLeaseBusyError);
  });

  it('refreshed=false считается потерей lease и гасит heartbeat', async () => {
    const lease = await acquireSigurCardLease({ owner: 'op-1', ttlSeconds: 60 });
    expect(lease.isLost()).toBe(false);

    h.heartbeatParams?.onLost?.();

    expect(lease.isLost()).toBe(true);
    expect(h.stopHeartbeat).toHaveBeenCalled();
  });

  it('ошибка heartbeat тоже означает потерю: продлить lease мы не смогли', async () => {
    const lease = await acquireSigurCardLease({ owner: 'op-1', ttlSeconds: 60 });

    h.heartbeatParams?.onError?.(new Error('db down'));

    expect(lease.isLost()).toBe(true);
  });

  it('release идемпотентна и сначала гасит таймер', async () => {
    const lease = await acquireSigurCardLease({ owner: 'op-1', ttlSeconds: 60 });

    await lease.release();
    await lease.release();

    expect(h.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith({ key: SIGUR_CARD_WRITE_LEASE_KEY, owner: 'op-1' });
  });

  it('ошибка отпускания не роняет операцию', async () => {
    h.release.mockRejectedValue(new Error('db down'));
    const lease = await acquireSigurCardLease({ owner: 'op-1', ttlSeconds: 60 });

    await expect(lease.release()).resolves.toBeUndefined();
  });
});

describe('withSigurCardWriteLease', () => {
  it('отпускает lease после успешной записи', async () => {
    const result = await withSigurCardWriteLease(42, async () => 'ok');

    expect(result).toBe('ok');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('отпускает lease и при исключении внутри операции', async () => {
    await expect(withSigurCardWriteLease(42, async () => {
      throw new Error('sigur 400');
    })).rejects.toThrow('sigur 400');

    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('во время массовой операции одиночная запись не выполняется', async () => {
    h.tryAcquire.mockResolvedValue({ acquired: false, row: null });
    const write = vi.fn();

    await expect(withSigurCardWriteLease(42, write)).rejects.toBeInstanceOf(SigurCardLeaseBusyError);
    expect(write).not.toHaveBeenCalled();
  });
});
