import os from 'node:os';
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';
import {
  SIGUR_MONITOR_STATE_KEY,
  SIGUR_POLLING_STATE_KEY,
  getSigurRuntimeState,
} from './sigur-runtime-state.service.js';
import { getSigurMonitorStatus } from './sigur-monitor.service.js';

export interface ISystemResourcesSnapshot {
  process: {
    cpuPercent: number;
    memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
    uptimeSec: number;
    pid: number;
    nodeVersion: string;
  };
  system: {
    cpuPercent: number;
    memory: { total: number; free: number; usedPercent: number };
    uptimeSec: number;
    loadavg: [number, number, number];
    platform: string;
    cpuModel: string;
    cpuCount: number;
  };
  eventLoop: {
    utilizationPercent: number;
    lagMs: number;
  };
  services: {
    sigurPolling: IServiceState;
    sigurMonitor: IServiceState & {
      lastSignalAt: string | null;
      consecutiveFailures: number;
      hasActiveIncident: boolean;
      enabled: boolean;
    };
  };
  capturedAt: string;
}

interface IServiceState {
  alive: boolean;
  heartbeatAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

interface ICpuTimes {
  idle: number;
  total: number;
}

let lastProcCpu: NodeJS.CpuUsage | null = null;
let lastProcCpuAt: number | null = null;
let lastSysCpu: ICpuTimes | null = null;
let lastEluSample: EventLoopUtilization | null = null;

const eventLoopDelayHistogram = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelayHistogram.enable();

function readSystemCpuTimes(): ICpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.idle + t.user + t.nice + t.sys + t.irq;
  }
  return { idle, total };
}

function calcProcessCpuPercent(): number {
  const now = Date.now();
  const usage = process.cpuUsage();
  if (!lastProcCpu || lastProcCpuAt == null) {
    lastProcCpu = usage;
    lastProcCpuAt = now;
    return 0;
  }
  const elapsedMs = now - lastProcCpuAt;
  if (elapsedMs <= 0) return 0;
  const userMs = (usage.user - lastProcCpu.user) / 1000;
  const sysMs = (usage.system - lastProcCpu.system) / 1000;
  lastProcCpu = usage;
  lastProcCpuAt = now;
  const cores = Math.max(1, os.cpus().length);
  const percent = ((userMs + sysMs) / (elapsedMs * cores)) * 100;
  return clampPercent(percent);
}

function calcSystemCpuPercent(): number {
  const cur = readSystemCpuTimes();
  if (!lastSysCpu) {
    lastSysCpu = cur;
    return 0;
  }
  const dIdle = cur.idle - lastSysCpu.idle;
  const dTotal = cur.total - lastSysCpu.total;
  lastSysCpu = cur;
  if (dTotal <= 0) return 0;
  const percent = (1 - dIdle / dTotal) * 100;
  return clampPercent(percent);
}

function calcEluPercent(): number {
  const cur = performance.eventLoopUtilization();
  if (!lastEluSample) {
    lastEluSample = cur;
    return 0;
  }
  const diff = performance.eventLoopUtilization(cur, lastEluSample);
  lastEluSample = cur;
  return clampPercent(diff.utilization * 100);
}

function readEventLoopLagMs(): number {
  if (eventLoopDelayHistogram.count === 0) return 0;
  // mean — наносекунды; переводим в миллисекунды и сразу сбрасываем окно,
  // чтобы следующая выборка отражала свежий период.
  const meanMs = eventLoopDelayHistogram.mean / 1e6;
  eventLoopDelayHistogram.reset();
  return Number.isFinite(meanMs) ? Math.max(0, Math.round(meanMs * 100) / 100) : 0;
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 10) / 10;
}

function buildServiceState(
  row: Awaited<ReturnType<typeof getSigurRuntimeState>>,
): IServiceState {
  if (!row) {
    return { alive: false, heartbeatAt: null, leaseOwner: null, leaseExpiresAt: null };
  }
  const expiresMs = row.lease_expires_at ? Date.parse(row.lease_expires_at) : NaN;
  const alive = Number.isFinite(expiresMs) && expiresMs > Date.now();
  return {
    alive,
    heartbeatAt: row.heartbeat_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export async function getSystemResourcesSnapshot(): Promise<ISystemResourcesSnapshot> {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsage = process.memoryUsage();

  const [pollingRow, monitorRow, monitorStatus] = await Promise.all([
    getSigurRuntimeState(SIGUR_POLLING_STATE_KEY).catch(err => {
      console.error('[system-resources] polling state read failed:', (err as Error).message);
      return null;
    }),
    getSigurRuntimeState(SIGUR_MONITOR_STATE_KEY).catch(err => {
      console.error('[system-resources] monitor state read failed:', (err as Error).message);
      return null;
    }),
    getSigurMonitorStatus().catch(err => {
      console.error('[system-resources] monitor status failed:', (err as Error).message);
      return null;
    }),
  ]);

  const monitorBase = buildServiceState(monitorRow);

  return {
    process: {
      cpuPercent: calcProcessCpuPercent(),
      memory: {
        rss: memUsage.rss,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
      },
      uptimeSec: Math.round(process.uptime()),
      pid: process.pid,
      nodeVersion: process.version,
    },
    system: {
      cpuPercent: calcSystemCpuPercent(),
      memory: {
        total: totalMem,
        free: freeMem,
        usedPercent: clampPercent(((totalMem - freeMem) / totalMem) * 100),
      },
      uptimeSec: Math.round(os.uptime()),
      loadavg: os.loadavg() as [number, number, number],
      platform: `${os.platform()} ${os.release()}`,
      cpuModel: cpus[0]?.model?.trim() || 'unknown',
      cpuCount: cpus.length,
    },
    eventLoop: {
      utilizationPercent: calcEluPercent(),
      lagMs: readEventLoopLagMs(),
    },
    services: {
      sigurPolling: buildServiceState(pollingRow),
      sigurMonitor: {
        ...monitorBase,
        lastSignalAt: monitorStatus?.lastSignalAt ?? null,
        consecutiveFailures: monitorStatus?.consecutiveFailures ?? 0,
        hasActiveIncident: !!monitorStatus?.activeIncident,
        enabled: !!monitorStatus?.enabled,
      },
    },
    capturedAt: new Date().toISOString(),
  };
}

export const __testing = {
  resetCpuSamplers(): void {
    lastProcCpu = null;
    lastProcCpuAt = null;
    lastSysCpu = null;
    lastEluSample = null;
  },
};
