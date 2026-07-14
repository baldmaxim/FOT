import { useMemo, useState, type FC, type ReactElement } from 'react';
import { Phone, Wifi, MessageSquare, Users, ChevronLeft, ChevronRight } from 'lucide-react';
import { useDashboardMtsUsage } from '../../hooks/useDashboardMtsUsage';
import type { IMtsDeptEmployee, IMtsUsageGroup, MtsUsageGroupKey } from '../../services/dashboardMtsService';
import { fmtDur, fmtLast, MONTH_NAMES } from '../../pages/mts-business/mtsBusinessFormat';
import styles from './DashboardMtsTab.module.css';

// Вкладка «МТС» на «Обзоре»: использование связи сотрудниками отдела за месяц.
// Денег и номеров здесь нет by design — только сухая статистика и ФИО.

interface IDashboardMtsTabProps {
  departmentId: string;
  /** Окно месяцев по роли (из useTimesheetMonthAccess); null — без ограничения. */
  minMonth: string | null;
  maxMonth: string | null;
}

/** Метрика рейтинга — по чему ранжируем сотрудников. */
type TopMetric = 'time' | 'calls' | 'internet';

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

/**
 * Статус сотрудника за месяц. Категории НЕ пересекаются и в сумме дают весь отдел —
 * руководителю должно быть видно не только «кто больше всех говорит», но и кто молчит
 * и кому SIM вообще не выдана.
 */
type EmployeeState = 'talked' | 'noCalls' | 'silent' | 'noSim';

const STATE_LABELS: Record<EmployeeState, string> = {
  talked: 'разговаривали',
  noCalls: 'без звонков, есть трафик',
  silent: 'связью не пользуются',
  noSim: 'без SIM',
};

/**
 * Активность — это только то, что сотрудник делает сам: звонки, интернет, СМС.
 * Группа `other` (абонплата, разовые списания) есть почти у каждого номера, и
 * если считать её активностью, «молчуны» исчезнут — окажется, что все «что-то делали».
 */
const USAGE_GROUPS: MtsUsageGroupKey[] = ['calls', 'internet', 'sms'];

const stateOf = (employee: IMtsDeptEmployee): EmployeeState => {
  if (!employee.hasSim) return 'noSim';
  if (!USAGE_GROUPS.some(k => groupOf(employee.groups, k).count > 0)) return 'silent';
  return groupOf(employee.groups, 'calls').count === 0 ? 'noCalls' : 'talked';
};

/** Порядок бейджей/разбивки — от «работает» к «ничего нет». */
const STATE_ORDER: EmployeeState[] = ['talked', 'noCalls', 'silent', 'noSim'];

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

/** 'YYYY-MM' ± n месяцев. */
const addMonths = (month: string, delta: number): string => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const monthLabelOf = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1] ?? month} ${y}`;
};

export const DashboardMtsTab: FC<IDashboardMtsTabProps> = ({ departmentId, minMonth, maxMonth }) => {
  const [month, setMonth] = useState(() => clampMonth(currentMonth(), minMonth, maxMonth));
  const [metric, setMetric] = useState<TopMetric>('time');

  const { data, isLoading, isError, error } = useDashboardMtsUsage(departmentId, month);

  // Границы листания = окно месяцев роли. Вперёд дальше текущего месяца не пускаем:
  // будущей выписки не существует, а пустой экран читался бы как «данные пропали».
  const upperMonth = useMemo(() => {
    const now = currentMonth();
    return maxMonth && maxMonth < now ? maxMonth : now;
  }, [maxMonth]);

  const prevMonth = !minMonth || addMonths(month, -1) >= minMonth ? addMonths(month, -1) : null;
  const nextMonth = addMonths(month, 1) <= upperMonth ? addMonths(month, 1) : null;

  const shiftMonth = (delta: number): void => {
    const target = delta < 0 ? prevMonth : nextMonth;
    if (target) setMonth(target);
  };

  const monthLabel = monthLabelOf(month);

  const metricValue = useMemo(() => (employee: IMtsDeptEmployee): number => {
    if (metric === 'internet') return groupOf(employee.groups, 'internet').bytes;
    const calls = groupOf(employee.groups, 'calls');
    return metric === 'time' ? calls.seconds : calls.count;
  }, [metric]);

  const fmtMetric = (value: number): string => {
    if (metric === 'internet') return fmtGb(value);
    return metric === 'time' ? fmtDur(value) : `${fmtNum(value)} зв.`;
  };

  // Показываем ВЕСЬ отдел, без отсечки топ-N: сначала «говорящие» по убыванию метрики,
  // затем те, кто не звонит, потом молчащие и в самом низу — кому SIM не выдана
  // (внутри группы порядок ростера — по ФИО).
  const ranked = useMemo(() => {
    const rows = [...(data?.employees ?? [])];
    return rows.sort((a, b) => {
      const byState = STATE_ORDER.indexOf(stateOf(a)) - STATE_ORDER.indexOf(stateOf(b));
      if (byState !== 0) return byState;
      return metricValue(b) - metricValue(a);
    });
  }, [data?.employees, metricValue]);

  // Разбивка отдела по статусам — складывается в общее число сотрудников.
  const breakdown = useMemo(() => {
    const counts = new Map<EmployeeState, number>(STATE_ORDER.map(s => [s, 0]));
    for (const employee of data?.employees ?? []) {
      const state = stateOf(employee);
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    return STATE_ORDER.map(state => ({ state, count: counts.get(state) ?? 0 }));
  }, [data?.employees]);

  const topMax = Math.max(1, ...ranked.map(metricValue));

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
  const activeCount = ranked.filter(e => metricValue(e) > 0).length;

  const renderRow = (employee: IMtsDeptEmployee, index: number): ReactElement => {
    const value = metricValue(employee);
    const state = stateOf(employee);
    const employeeCalls = groupOf(employee.groups, 'calls');
    const sub = [
      employee.tabNumber ? `таб. ${employee.tabNumber}` : null,
      // Для «Времени» дублируем счётчик звонков, для остальных метрик — длительность.
      metric === 'time'
        ? (employeeCalls.count > 0 ? `${fmtNum(employeeCalls.count)} зв.` : null)
        : (employeeCalls.seconds > 0 ? fmtDur(employeeCalls.seconds) : null),
    ].filter(Boolean).join(' · ');

    return (
      <div key={employee.employeeId} className={`${styles.barRow} ${state === 'talked' ? '' : styles.barRowMuted}`}>
        <span className={styles.barIndex}>{index + 1}</span>
        <div className={styles.barMain}>
          <div className={styles.barLabel}>
            {employee.fullName}
            {sub && <span className={styles.barSub}> · {sub}</span>}
            {/* Каждому не-«говорящему» — явный ярлык, чтобы ноль не читался как сбой данных. */}
            {state !== 'talked' && <span className={styles.barBadge}>{STATE_LABELS[state]}</span>}
          </div>
          <div className={styles.barTrack}>
            <div className={styles.barFill} style={{ width: `${Math.round((value / topMax) * 100)}%` }} />
          </div>
        </div>
        <div className={styles.barValue}>{employee.hasSim ? fmtMetric(value) : '—'}</div>
      </div>
    );
  };

  return (
    <div className={styles.wrap}>
      {/* Месяц — по центру, листаем стрелками. Границы = окно месяцев роли. */}
      <div className={styles.toolbar}>
        <div className={styles.monthPager}>
          <button
            type="button"
            className={styles.monthNav}
            onClick={() => shiftMonth(-1)}
            disabled={!prevMonth}
            title={prevMonth ? 'Предыдущий месяц' : 'Дальше назад роль не пускает'}
            aria-label="Предыдущий месяц"
          >
            <ChevronLeft size={16} />
          </button>
          <span className={styles.monthLabel}>{monthLabel}</span>
          <button
            type="button"
            className={styles.monthNav}
            onClick={() => shiftMonth(1)}
            disabled={!nextMonth}
            title={nextMonth ? 'Следующий месяц' : 'Дальше вперёд роль не пускает'}
            aria-label="Следующий месяц"
          >
            <ChevronRight size={16} />
          </button>
        </div>
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
          <div className={styles.kpiSubMuted}>{fmtNum(activeCount)} с активностью</div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>
            Сотрудники отдела
            <span className={styles.cardTitleExtra}> · {fmtNum(ranked.length)}</span>
          </span>
          <div className={styles.segment}>
            {METRICS.map(m => (
              <button
                key={m.key}
                type="button"
                className={`${styles.segBtn} ${metric === m.key ? styles.segBtnActive : ''}`}
                onClick={() => setMetric(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Разбивка по статусам: категории не пересекаются и в сумме дают весь отдел. */}
        {ranked.length > 0 && (
          <div className={styles.breakdown}>
            {breakdown.filter(b => b.count > 0).map(b => (
              <span key={b.state} className={styles.breakdownItem}>
                <b>{fmtNum(b.count)}</b> {STATE_LABELS[b.state]}
              </span>
            ))}
          </div>
        )}

        {ranked.length === 0 ? (
          <div className={styles.empty}>В отделе нет активных сотрудников.</div>
        ) : (
          <>
            {activeCount === 0 && (
              <div className={styles.empty}>
                За {monthLabel} активности по выбранной метрике нет.
                {data?.employeesWithSim === 0 && ' Ни один номер МТС не привязан к сотрудникам отдела.'}
              </div>
            )}
            {ranked.map(renderRow)}
          </>
        )}
      </div>
    </div>
  );
};
