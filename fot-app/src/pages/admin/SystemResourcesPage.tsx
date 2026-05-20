import { useMemo, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Cpu, HardDrive, Server } from 'lucide-react';
import { apiClient } from '../../api/client';
import styles from './SystemResourcesPage.module.css';

interface IServiceState {
  alive: boolean;
  heartbeatAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

interface ISystemResourcesSnapshot {
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

interface IApiResponse {
  success: boolean;
  data: ISystemResourcesSnapshot;
}

const REFRESH_MS = 5_000;

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
};

const formatUptime = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0 || days > 0) parts.push(`${hours} ч`);
  parts.push(`${minutes} м`);
  return parts.join(' ');
};

const formatRelative = (iso: string | null): string => {
  if (!iso) return 'нет данных';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'нет данных';
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec} сек назад`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} мин назад`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} ч назад`;
  return `${Math.floor(diffSec / 86400)} д назад`;
};

const barClass = (percent: number): string => {
  if (percent >= 85) return styles.barFillCrit;
  if (percent >= 60) return styles.barFillWarn;
  return styles.barFillOk;
};

interface IBarProps {
  label: string;
  percent: number;
  caption?: string;
}

const Bar: FC<IBarProps> = ({ label, percent, caption }) => {
  const safe = Math.max(0, Math.min(100, percent));
  return (
    <div className={styles.metric}>
      <div className={styles.metricRow}>
        <span>{label}</span>
        <span className={styles.metricValue}>{safe.toFixed(1)}%</span>
      </div>
      <div className={styles.bar}>
        <div className={`${styles.barFill} ${barClass(safe)}`} style={{ width: `${safe}%` }} />
      </div>
      {caption && <div className={styles.cardCaption}>{caption}</div>}
    </div>
  );
};

interface IServiceProps {
  title: string;
  state: IServiceState;
  extra?: { label: string; value: string }[];
  disabled?: boolean;
}

const ServiceRow: FC<IServiceProps> = ({ title, state, extra, disabled }) => {
  let badgeClass = styles.statusMuted;
  let badgeText = 'нет данных';
  if (disabled) {
    badgeClass = styles.statusMuted;
    badgeText = 'отключён';
  } else if (state.heartbeatAt == null && state.leaseExpiresAt == null) {
    badgeClass = styles.statusMuted;
    badgeText = 'нет данных';
  } else if (state.alive) {
    badgeClass = styles.statusOk;
    badgeText = 'активен';
  } else {
    badgeClass = styles.statusCrit;
    badgeText = 'не отвечает';
  }

  return (
    <div className={styles.serviceRow}>
      <div className={styles.serviceHeader}>
        <span className={styles.serviceTitle}>{title}</span>
        <span className={`${styles.statusBadge} ${badgeClass}`}>
          <span className={styles.statusDot} />
          {badgeText}
        </span>
      </div>
      <div className={styles.serviceMeta}>
        Heartbeat: {formatRelative(state.heartbeatAt)}
        {state.leaseOwner ? ` · owner ${state.leaseOwner.split(':').slice(0, 2).join(':')}` : ''}
      </div>
      {extra && extra.length > 0 && (
        <div className={styles.serviceMeta}>
          {extra.map(e => `${e.label}: ${e.value}`).join(' · ')}
        </div>
      )}
    </div>
  );
};

export const SystemResourcesPage: FC = () => {
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ['admin-system-resources'],
    queryFn: () => apiClient.get<IApiResponse>('/admin/system-resources'),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  const snapshot = data?.data;
  const showLoadAvg = useMemo(() => {
    if (!snapshot) return false;
    return snapshot.system.loadavg.some(v => v > 0);
  }, [snapshot]);

  if (isLoading) {
    return <div className={styles.loading}>Загрузка метрик…</div>;
  }

  if (isError || !snapshot) {
    return (
      <div className={styles.error}>
        Не удалось загрузить метрики: {(error as Error)?.message || 'неизвестная ошибка'}
      </div>
    );
  }

  const memUsedPercent = snapshot.system.memory.usedPercent;
  const heapPercent = snapshot.process.memory.heapTotal > 0
    ? (snapshot.process.memory.heapUsed / snapshot.process.memory.heapTotal) * 100
    : 0;

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <span className={styles.refreshDot}>Авто-обновление каждые {REFRESH_MS / 1000} сек</span>
        <span>Снимок: {new Date(dataUpdatedAt || snapshot.capturedAt).toLocaleTimeString('ru-RU')}</span>
      </div>

      <div className={styles.grid}>
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>
              <Cpu size={16} /> CPU
            </h3>
            <span className={styles.cardCaption}>
              {snapshot.system.cpuCount} ядер
            </span>
          </div>
          <Bar label="Процесс Node" percent={snapshot.process.cpuPercent} caption="нормировано на все ядра" />
          <Bar label="Система" percent={snapshot.system.cpuPercent} />
          <div className={styles.cardCaption}>{snapshot.system.cpuModel}</div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>
              <HardDrive size={16} /> Память
            </h3>
            <span className={styles.cardCaption}>
              RSS {formatBytes(snapshot.process.memory.rss)}
            </span>
          </div>
          <Bar
            label="Системная RAM"
            percent={memUsedPercent}
            caption={`${formatBytes(snapshot.system.memory.total - snapshot.system.memory.free)} / ${formatBytes(snapshot.system.memory.total)}`}
          />
          <Bar
            label="Heap процесса"
            percent={heapPercent}
            caption={`${formatBytes(snapshot.process.memory.heapUsed)} / ${formatBytes(snapshot.process.memory.heapTotal)}`}
          />
          <div className={styles.cardCaption}>
            external {formatBytes(snapshot.process.memory.external)}
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>
              <Activity size={16} /> Event loop
            </h3>
            <span className={styles.cardCaption}>node {snapshot.process.nodeVersion}</span>
          </div>
          <Bar label="Утилизация" percent={snapshot.eventLoop.utilizationPercent} />
          <div className={styles.metricRow}>
            <span>Средняя задержка</span>
            <span className={styles.metricValue}>{snapshot.eventLoop.lagMs} мс</span>
          </div>
          <div className={styles.cardCaption}>
            высокая задержка (&gt;50 мс) = блокирующий код
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>
              <Server size={16} /> Аптайм
            </h3>
            <span className={styles.cardCaption}>PID {snapshot.process.pid}</span>
          </div>
          <div className={styles.kvList}>
            <span className={styles.kvKey}>Процесс</span>
            <span className={styles.kvVal}>{formatUptime(snapshot.process.uptimeSec)}</span>
            <span className={styles.kvKey}>Система</span>
            <span className={styles.kvVal}>{formatUptime(snapshot.system.uptimeSec)}</span>
            <span className={styles.kvKey}>Платформа</span>
            <span className={styles.kvVal}>{snapshot.system.platform}</span>
            {showLoadAvg && (
              <>
                <span className={styles.kvKey}>Load average</span>
                <span className={styles.kvVal}>
                  {snapshot.system.loadavg.map(v => v.toFixed(2)).join(' · ')}
                </span>
              </>
            )}
          </div>
        </section>

        <section className={`${styles.card} ${styles.cardWide}`}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>Фоновые сервисы</h3>
          </div>
          <ServiceRow
            title="Sigur — опрос событий (presence polling)"
            state={snapshot.services.sigurPolling}
          />
          <ServiceRow
            title="Sigur — монитор связи"
            state={snapshot.services.sigurMonitor}
            disabled={!snapshot.services.sigurMonitor.enabled}
            extra={[
              {
                label: 'последний сигнал',
                value: formatRelative(snapshot.services.sigurMonitor.lastSignalAt),
              },
              {
                label: 'подряд неудач',
                value: String(snapshot.services.sigurMonitor.consecutiveFailures),
              },
              {
                label: 'инцидент',
                value: snapshot.services.sigurMonitor.hasActiveIncident ? 'открыт' : 'нет',
              },
            ]}
          />
        </section>
      </div>
    </div>
  );
};
