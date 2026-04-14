import type { FC } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Clock, BarChart3, AlertTriangle } from 'lucide-react';
import type { IDashboardStats, DashboardPeriod } from '../../types';
import styles from './AnalyticsRow.module.css';

interface IAnalyticsRowProps {
  stats: IDashboardStats;
  period: DashboardPeriod;
}

const getPeriodLabel = (period: DashboardPeriod): string =>
  period === 'today' ? 'сегодня' : period === 'week' ? 'неделю' : 'месяц';

const getInitials = (name: string): string => {
  const parts = name.split(' ');
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

/** Ширина бара: 08:00=0%, 09:00=50%, 10:00=100% */
const timeToBarWidth = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  const minutes = h * 60 + m;
  const min = 8 * 60;   // 08:00
  const max = 10 * 60;  // 10:00
  return Math.max(10, Math.min(100, ((minutes - min) / (max - min)) * 100));
};

const getBarClass = (time: string): string => {
  if (time <= '09:00') return styles.early;
  if (time <= '09:05') return styles.ontime;
  return styles.late;
};

const CIRCUMFERENCE = 2 * Math.PI * 42; // r=42

export const PunctualityCard: FC<{ punctuality: IDashboardStats['punctuality']; period: DashboardPeriod }> = ({ punctuality, period }) => {
  const offset = CIRCUMFERENCE - (punctuality.onTime / 100) * CIRCUMFERENCE;

  return (
    <div className={styles.card}>
      <div className={styles.title}>
        <Clock size={16} />
        Пунктуальность за {getPeriodLabel(period)}
      </div>
      <div className={styles.punctChart}>
        <div className={styles.ring}>
          <svg width="100%" height="100%" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="42" fill="none" stroke="var(--bg-elevated)" strokeWidth="8" />
            <circle
              cx="50" cy="50" r="42" fill="none"
              stroke="var(--success)" strokeWidth="8" strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={offset}
            />
          </svg>
          <div className={styles.ringValue}>
            <span>{punctuality.onTime}%</span>
            <small>вовремя</small>
          </div>
        </div>
        <div className={styles.legend}>
          <div className={styles.legendItem}>
            <span className={styles.legendLabel}>
              <span className={`${styles.legendDot} ${styles.green}`} />
              Вовремя (до 09:00)
            </span>
            <span className={styles.legendVal}>{punctuality.onTime}%</span>
          </div>
          <div className={styles.legendItem}>
            <span className={styles.legendLabel}>
              <span className={`${styles.legendDot} ${styles.orange}`} />
              Опоздание (09:01–09:15)
            </span>
            <span className={styles.legendVal}>{punctuality.slightlyLate}%</span>
          </div>
          <div className={styles.legendItem}>
            <span className={styles.legendLabel}>
              <span className={`${styles.legendDot} ${styles.red}`} />
              Сильное (&gt;09:15)
            </span>
            <span className={styles.legendVal}>{punctuality.veryLate}%</span>
          </div>
          <div className={styles.legendItem}>
            <span className={styles.legendLabel}>
              <span className={`${styles.legendDot} ${styles.gray}`} />
              Отсутствовали
            </span>
            <span className={styles.legendVal}>{punctuality.absent}%</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export const AvgArrivalCard: FC<{ data: IDashboardStats['avgArrivalByDay']; period: DashboardPeriod }> = ({ data, period }) => (
  <div className={styles.card}>
    <div className={styles.title}>
      <BarChart3 size={16} />
      Среднее время прихода
    </div>
    <div className={styles.bars}>
      {data.map(item => (
        <div key={item.day} className={`${styles.barRow} ${period === 'today' && item.isToday ? styles.highlight : ''}`}>
          <span className={styles.barLabel}>{item.day}</span>
          <div className={styles.barTrack}>
            {item.avgTime ? (
              <div
                className={`${styles.barFill} ${getBarClass(item.avgTime)}`}
                style={{ width: `${timeToBarWidth(item.avgTime)}%` }}
              >
                <span className={styles.barText}>{item.avgTime}</span>
              </div>
            ) : (
              <span className={styles.barEmpty}>—</span>
            )}
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const RisksCard: FC<{ risks: IDashboardStats['risks']; period: DashboardPeriod }> = ({ risks, period }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const employeeCardBackState = {
    label: 'Обзор',
    from: `${location.pathname}${location.search}${location.hash}`,
  };

  return (
    <div className={styles.card}>
      <div className={styles.title}>
        <AlertTriangle size={16} />
        Требуют внимания
      </div>
      {risks.length === 0 ? (
        <div className={styles.empty}>Нет рисков за {getPeriodLabel(period)}</div>
      ) : (
        <div className={styles.risksList}>
          {risks.slice(0, 3).map(risk => (
            <div
              key={risk.employee_id}
              className={`${styles.riskItem} ${styles[risk.severity]} ${styles.clickable}`}
              onClick={() => navigate(`/employees/${risk.employee_id}`, { state: employeeCardBackState })}
            >
              <div className={styles.riskAvatar}>{getInitials(risk.full_name)}</div>
              <div className={styles.riskInfo}>
                <div className={styles.riskName}>{risk.full_name}</div>
                <div className={styles.riskReason}>{risk.reason}</div>
              </div>
              <span className={`${styles.riskBadge} ${styles[risk.severity]}`}>
                {risk.severity === 'high' ? 'Критично' : 'Внимание'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const AnalyticsRow: FC<IAnalyticsRowProps> = ({ stats, period }) => (
  <div className={styles.row}>
    <PunctualityCard punctuality={stats.punctuality} period={period} />
    <AvgArrivalCard data={stats.avgArrivalByDay} period={period} />
    <RisksCard risks={stats.risks} period={period} />
  </div>
);
