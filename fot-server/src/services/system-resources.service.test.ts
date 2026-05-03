import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pollingRow: null as Record<string, unknown> | null,
  monitorRow: null as Record<string, unknown> | null,
  monitorStatus: null as Record<string, unknown> | null,
}));

vi.mock('./sigur-runtime-state.service.js', () => ({
  SIGUR_POLLING_STATE_KEY: 'sigur_presence_polling',
  SIGUR_MONITOR_STATE_KEY: 'sigur_monitor',
  getSigurRuntimeState: vi.fn(async (key: string) => {
    if (key === 'sigur_presence_polling') return mocks.pollingRow;
    if (key === 'sigur_monitor') return mocks.monitorRow;
    return null;
  }),
}));

vi.mock('./sigur-monitor.service.js', () => ({
  getSigurMonitorStatus: vi.fn(async () => mocks.monitorStatus),
}));

import { __testing, getSystemResourcesSnapshot } from './system-resources.service.js';

describe('system-resources.service', () => {
  beforeEach(() => {
    __testing.resetCpuSamplers();
    mocks.pollingRow = null;
    mocks.monitorRow = null;
    mocks.monitorStatus = {
      enabled: true,
      latestCheck: null,
      activeIncident: null,
      lastSignalAt: null,
      lastSuccessfulSignalAt: null,
      lastEventFlowAt: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      consecutiveEventFlowSuccesses: 0,
      currentStatus: 'ok',
      settings: {},
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('возвращает снапшот с ожидаемой структурой', async () => {
    const snap = await getSystemResourcesSnapshot();

    expect(snap).toHaveProperty('process.cpuPercent');
    expect(snap).toHaveProperty('process.memory.rss');
    expect(snap).toHaveProperty('process.memory.heapUsed');
    expect(snap).toHaveProperty('process.uptimeSec');
    expect(snap).toHaveProperty('system.cpuPercent');
    expect(snap).toHaveProperty('system.memory.usedPercent');
    expect(snap).toHaveProperty('eventLoop.utilizationPercent');
    expect(snap).toHaveProperty('eventLoop.lagMs');
    expect(snap).toHaveProperty('services.sigurPolling');
    expect(snap).toHaveProperty('services.sigurMonitor');
    expect(typeof snap.capturedAt).toBe('string');

    expect(snap.process.memory.rss).toBeGreaterThan(0);
    expect(snap.system.memory.total).toBeGreaterThan(0);
    expect(snap.system.cpuCount).toBeGreaterThan(0);
  });

  it('CPU процесса возвращает осмысленные проценты в [0, 100]', async () => {
    const first = await getSystemResourcesSnapshot();
    expect(first.process.cpuPercent).toBe(0); // первый вызов — нет окна

    await new Promise(r => setTimeout(r, 50));
    // создаём CPU-нагрузку
    const target = Date.now() + 30;
    while (Date.now() < target) {
      Math.sqrt(Math.random() * 1e6);
    }

    const second = await getSystemResourcesSnapshot();
    expect(second.process.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(second.process.cpuPercent).toBeLessThanOrEqual(100);
  });

  it('sigurPolling.alive=true когда lease_expires_at в будущем', async () => {
    mocks.pollingRow = {
      key: 'sigur_presence_polling',
      checkpoint_at: null,
      lease_owner: 'host:123',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      heartbeat_at: new Date().toISOString(),
      meta: {},
      updated_at: new Date().toISOString(),
    };

    const snap = await getSystemResourcesSnapshot();
    expect(snap.services.sigurPolling.alive).toBe(true);
    expect(snap.services.sigurPolling.leaseOwner).toBe('host:123');
  });

  it('sigurPolling.alive=false когда lease_expires_at в прошлом', async () => {
    mocks.pollingRow = {
      key: 'sigur_presence_polling',
      checkpoint_at: null,
      lease_owner: 'host:123',
      lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
      heartbeat_at: new Date(Date.now() - 120_000).toISOString(),
      meta: {},
      updated_at: new Date().toISOString(),
    };

    const snap = await getSystemResourcesSnapshot();
    expect(snap.services.sigurPolling.alive).toBe(false);
  });

  it('sigurPolling.alive=false когда строки нет', async () => {
    mocks.pollingRow = null;
    const snap = await getSystemResourcesSnapshot();
    expect(snap.services.sigurPolling.alive).toBe(false);
    expect(snap.services.sigurPolling.heartbeatAt).toBeNull();
  });

  it('sigurMonitor включает enabled и hasActiveIncident', async () => {
    mocks.monitorStatus = {
      enabled: true,
      latestCheck: null,
      activeIncident: { id: 7, status: 'open' },
      lastSignalAt: new Date().toISOString(),
      lastSuccessfulSignalAt: null,
      lastEventFlowAt: null,
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
      consecutiveEventFlowSuccesses: 0,
      currentStatus: 'incident_open',
      settings: {},
    };

    const snap = await getSystemResourcesSnapshot();
    expect(snap.services.sigurMonitor.enabled).toBe(true);
    expect(snap.services.sigurMonitor.hasActiveIncident).toBe(true);
    expect(snap.services.sigurMonitor.consecutiveFailures).toBe(3);
  });
});
