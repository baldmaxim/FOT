import { useMemo, useState, type FC, type ReactElement } from 'react';
import { Phone, Wifi, MessageSquare, Users } from 'lucide-react';
import { useDashboardMtsUsage } from '../../hooks/useDashboardMtsUsage';
import type { IMtsDeptEmployee, IMtsUsageGroup, MtsUsageGroupKey } from '../../services/dashboardMtsService';
import { fmtDur, fmtLast, lastMonths } from '../../pages/mts-business/mtsBusinessFormat';
import styles from './DashboardMtsTab.module.css';

// Вкладка «МТС» на «Обзоре»: использование связи сотрудниками отдела за месяц.
// Денег и номеров здесь нет by design — только сухая статистика и ФИО.

interface IDashboardMtsTabProps {
  departmentId: string;
  /** Окно месяцев по роли (из useTimesheetMonthAccess); null — без ограничения. */
  minMonth: string | null;
  maxMonth: string | null;
}

/** Метрика «Топа» — по чему ранжируем сотрудников. */
type TopMetric = 'time' | 'calls' | 'internet';

const TOP_N = 10;

const METRICS: { key: TopMetric; label: string }[] = [
  { key: 'time', label: 'Время' },
  { key: 'calls', label: 'Звонки' },
  { key: 'internet', label: 'Интернет' },
];

const EMPTY_GROUP: IMtsUsageGroup = {
  key: 'other', count: 0, seconds: 0, bytes: 0, inCount: 0, inSeconds: 0, outCount: 0, outSeconds: 0,
};

const groupOf = (groups: IMtsUsageGroup[], key: MtsUsageGroupKey): IMtsUsageGroup =>
  groups.find(g => g.key === key) ?? { ...EMPTY_GROUP, key };

const fmtNum = (n: number): string => n.toLocaleString('ru-RU');

/** Байты → ГБ в десятичных единицах (как считает МТС в выписке). */
const fmtGb = (bytes: number): string => `${(bytes / 1e9).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ`;

const currentMonth = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const clampMonth = (month: string, min: string | null, max: string | null): string => {
  if (min && month < min) return min;
  if (max && month > max) return max;
  return month;
};

export const DashboardMtsTab: FC<IDashboardMtsTabProps> = ({ departmentId, minMonth, maxMonth }) => {
  const [month, setMonth] = useState(() => clampMonth(currentMonth(), minMonth, maxMonth));
  const [metric, setMetric] = useState<TopMetric>('time');
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading, isError, error } = useDashboardMtsUsage(departmentId, month);

  const monthOptions = useMemo(
    () => lastMonths(12).filter(m => (!minMonth || m.value >= minMonth) && (!maxMonth || m.value <= maxMonth)),
    [minMonth, maxMonth],
  );

  const monthLabel = monthOptions.find(m => m.value === month)?.label ?? month;

  const metricValue = useMemo(() => (employee: IMtsDeptEmployee): number => {
    if (metric === 'internet') return groupOf(employee.groups, 'internet').bytes;
    const calls = groupOf(employee.groups, 'calls');
    return metric === 'time' ? calls.seconds : calls.count;
  }, [metric]);

  const fmtMetric = (value: number): string => {
    if (metric === 'internet') return fmtGb(value);
    return metric === 'time' ? fmtDur(value) : `${fmtNum(value)} зв.`;
  };

  const ranked = useMemo(() => {
    const rows = (data?.employees ?? []).filter(e => metricValue(e) > 0);
    return rows.sort((a, b) => metricValue(b) - metricValue(a));
  }, [data?.employees, metricValue]);

  const topMax = Math.max(1, ...ranked.map(metricValue));
  const visible = expanded ? ranked : ranked.slice(0, TOP_N);
  const restCount = ranked.length - visible.length;

  if (isLoading) {
    return (
      <div className={styles.state}>
        <div className="loading-spinner" />
        <p>Загрузка статистики МТС...</p>
      </div>
    );
  }

  if (isError) {
    const message = error instanceof Error ? error.message : 'Не удалось загрузить статистику МТС';
    return <div className={styles.state}>{message}</div>;
  }

  const calls = groupOf(data?.totals ?? [], 'calls');
  const internet = groupOf(data?.totals ?? [], 'internet');
  const sms = groupOf(data?.totals ?? [], 'sms');
  const hasData = ranked.length > 0 || calls.count > 0 || internet.count > 0 || sms.count > 0;

  const renderRow = (employee: IMtsDeptEmployee, index: number): ReactElement => {
    const value = metricValue(employee);
    const employeeCalls = groupOf(employee.groups, 'calls');
    const sub = [
      employee.tabNumber ? `таб. ${employee.tabNumber}` : null,
      // Для «Времени» дублируем счётчик звонков, для остальных метрик — длительность.
      metric === 'time'
        ? (employeeCalls.count > 0 ? `${fmtNum(employeeCalls.count)} зв.` : null)
        : (employeeCalls.seconds > 0 ? fmtDur(employeeCalls.seconds) : null),
    ].filter(Boolean).join(' · ');

    return (
      <div key={employee.employeeId} className={styles.barRow}>
        <span className={styles.barIndex}>{index + 1}</span>
        <div className={styles.barMain}>
          <div className={styles.barLabel}>
            {employee.fullName}
            {sub && <span className={styles.barSub}> · {sub}</span>}
          </div>
          <div className={styles.barTrack}>
            <div className={styles.barFill} style={{ width: `${Math.round((value / topMax) * 100)}%` }} />
          </div>
        </div>
        <div className={styles.barValue}>{fmtMetric(value)}</div>
      </div>
    );
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <select
          className={styles.select}
          value={month}
          onChange={e => setMonth(e.target.value)}
          aria-label="Месяц"
        >
          {monthOptions.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        {data?.syncedAt && (
          <span className={styles.synced}>данные на {fmtLast(data.syncedAt)}</span>
        )}
      </div>

      <div className={styles.kpiGrid}>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}><Phone size={13} /> Звонки</div>
          <div className={styles.kpiValue}>{fmtNum(calls.count)}</div>
          <div className={styles.kpiSub}>{fmtDur(calls.seconds)}</div>
          <div className={styles.kpiSubMuted}>
            вх. {fmtNum(calls.inCount)} · исх. {fmtNum(calls.outCount)}
          </div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}><Wifi size={13} /> Интернет</div>
          <div className={styles.kpiValue}>{fmtGb(internet.bytes)}</div>
          <div className={styles.kpiSubMuted}>{fmtNum(internet.count)} сессий</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}><MessageSquare size={13} /> СМС</div>
          <div className={styles.kpiValue}>{fmtNum(sms.count)}</div>
          <div className={styles.kpiSubMuted}>
            вх. {fmtNum(sms.inCount)} · исх. {fmtNum(sms.outCount)}
          </div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}><Users size={13} /> Сотрудники с SIM</div>
          <div className={styles.kpiValue}>{fmtNum(data?.employeesWithSim ?? 0)}</div>
          <div className={styles.kpiSubMuted}>{fmtNum(ranked.length)} с активностью</div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>Топ сотрудников</span>
          <div className={styles.segment}>
            {METRICS.map(m => (
              <button
                key={m.key}
                type="button"
                className={`${styles.segBtn} ${metric === m.key ? styles.segBtnActive : ''}`}
                onClick={() => { setMetric(m.key); setExpanded(false); }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {!hasData ? (
          <div className={styles.empty}>
            За {monthLabel} нет данных МТС по сотрудникам отдела.
            {data?.employeesWithSim === 0 && ' Ни один номер не привязан к сотрудникам отдела.'}
          </div>
        ) : ranked.length === 0 ? (
          <div className={styles.empty}>Нет активности по выбранной метрике за {monthLabel}.</div>
        ) : (
          <>
            {visible.map(renderRow)}
            {restCount > 0 && (
              <button type="button" className={styles.moreBtn} onClick={() => setExpanded(true)}>
                Остальные · {restCount}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
