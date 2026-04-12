import type { FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, TrendingDown } from 'lucide-react';
import type { IDashboardStats, DashboardPeriod } from '../../types';
import styles from './DashboardSidebar.module.css';

interface IDashboardSidebarProps {
  stats: IDashboardStats;
  period: DashboardPeriod;
}

const getInitials = (name: string): string => {
  const parts = name.split(' ');
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

const getPeriodLabel = (period: DashboardPeriod): string =>
  period === 'today' ? 'сегодня' : period === 'week' ? 'неделю' : 'месяц';

export const HourlyActivityCard: FC<{ data: IDashboardStats['hourlyActivity']; period: DashboardPeriod }> = ({ data, period }) => {
  const maxCount = Math.max(...data.map(d => d.count), 1);

  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>
        Активность по часам
        {period !== 'today' && <span className={styles.cardSubtitle}>(ср. за день)</span>}
      </div>
      <div className={styles.hourlyBars}>
        {data.map(item => (
          <div
            key={item.hour}
            className={`${styles.hourlyBar} ${item.count === maxCount && item.count > 0 ? styles.peak : ''}`}
            style={{ height: `${Math.max(4, (item.count / maxCount) * 100)}%` }}
            title={`${item.hour}:00 — ${item.count} чел.`}
          />
        ))}
      </div>
      <div className={styles.hourlyLabels}>
        {data.map(item => (
          <span key={item.hour} className={styles.hourlyLabel}>
            {item.hour}
          </span>
        ))}
      </div>
    </div>
  );
};

interface IComparisonItem {
  label: string;
  current: string;
  delta: number;
  suffix?: string;
  invertColors?: boolean;
  formatDelta?: boolean;
}

export const ComparisonCard: FC<{ comparison: IDashboardStats['weekComparison']; period: DashboardPeriod }> = ({ comparison, period }) => {
  if (!comparison) return null;

  const { thisWeek, lastWeek } = comparison;
  const compTitle = period === 'today' ? 'Сравнение со вчера' : period === 'week' ? 'Сравнение с прошлой неделей' : 'Сравнение с прошлым месяцем';

  const items: IComparisonItem[] = [
    {
      label: 'Присутствие',
      current: `${thisWeek.attendanceRate}%`,
      delta: thisWeek.attendanceRate - lastWeek.attendanceRate,
      suffix: '%',
    },
    {
      label: 'Ср. приход',
      current: thisWeek.avgArrival,
      delta: compareTimes(lastWeek.avgArrival, thisWeek.avgArrival),
      formatDelta: true,
    },
    {
      label: 'Ср. часов',
      current: `${thisWeek.avgHours}ч`,
      delta: Math.round((thisWeek.avgHours - lastWeek.avgHours) * 10) / 10,
      suffix: 'ч',
    },
    {
      label: 'Опоздания',
      current: String(thisWeek.lateCount),
      delta: thisWeek.lateCount - lastWeek.lateCount,
      invertColors: true,
    },
  ];

  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>{compTitle}</div>
      {items.map(item => {
        const isUp = item.delta > 0;
        const isNeutral = item.delta === 0;
        let colorClass = isNeutral ? styles.neutral : isUp ? styles.up : styles.down;
        if (item.invertColors && !isNeutral) {
          colorClass = isUp ? styles.down : styles.up;
        }

        return (
          <div key={item.label} className={styles.compItem}>
            <span className={styles.compLabel}>{item.label}</span>
            <div className={styles.compValues}>
              <span className={styles.compCurrent}>{item.current}</span>
              <span className={`${styles.compChange} ${colorClass}`}>
                {!isNeutral && (isUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />)}
                {isNeutral ? '—' : item.formatDelta ? formatMinutesDelta(item.delta) : `${isUp ? '+' : ''}${item.delta}${item.suffix || ''}`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export const TopLateCard: FC<{ data: IDashboardStats['topLate']; period: DashboardPeriod }> = ({ data, period }) => {
  const navigate = useNavigate();

  return (
    <div className={styles.card}>
      <div className={styles.cardTitle}>Топ опаздывающих</div>
      {data.length === 0 ? (
        <div className={styles.empty}>Нет опозданий за {getPeriodLabel(period)}</div>
      ) : (
        data.map((item, i) => (
          <div
            key={item.employee_id}
            className={`${styles.lateItem} ${styles.clickable}`}
            onClick={() => navigate(`/employees/${item.employee_id}`, { state: { from: '/dashboard', label: 'Обзор' } })}
          >
            <span className={styles.lateRank}>{i + 1}</span>
            <div className={styles.lateAvatar}>{getInitials(item.full_name)}</div>
            <div className={styles.lateInfo}>
              <div className={styles.lateName}>{item.full_name}</div>
              <div className={styles.lateArrival}>~{item.avgArrival}</div>
            </div>
            <span className={styles.lateCount}>{item.lateCount}×</span>
          </div>
        ))
      )}
    </div>
  );
};

/** Сравнение двух времён в минутах (положительное = раньше = лучше) */
function compareTimes(a: string, b: string): number {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const aMin = toMin(a);
  const bMin = toMin(b);
  // Если одно из значений отсутствует (00:00) — нет сравнения
  if (aMin === 0 || bMin === 0) return 0;
  return aMin - bMin;
}

/** Форматирование дельты минут в человекочитаемый вид */
function formatMinutesDelta(minutes: number): string {
  const abs = Math.abs(minutes);
  if (abs < 60) return `${minutes > 0 ? '+' : ''}${minutes}м`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const sign = minutes > 0 ? '+' : '−';
  return m > 0 ? `${sign}${h}ч ${m}м` : `${sign}${h}ч`;
}

export const DashboardSidebar: FC<IDashboardSidebarProps> = ({ stats, period }) => (
  <div className={styles.sidebar}>
    <HourlyActivityCard data={stats.hourlyActivity} period={period} />
    <ComparisonCard comparison={stats.weekComparison} period={period} />
    <TopLateCard data={stats.topLate} period={period} />
  </div>
);
