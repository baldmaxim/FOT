import type { FC } from 'react';
import { Users } from 'lucide-react';
import styles from './DashboardStats.module.css';

interface IPresenceTodayCardProps {
  online: number;
  total: number;
  absent: number;
  target: number;
  current: number;
}

export const PresenceTodayCard: FC<IPresenceTodayCardProps> = ({ online, total, absent, target, current }) => {
  const goalColor = current >= target ? styles.good : current >= target - 15 ? styles.warn : styles.bad;

  return (
    <div className={styles.card}>
      <div className={styles.title}>
        <div className={`${styles.titleIcon} ${styles.green}`}>
          <Users />
        </div>
        Присутствие сегодня
      </div>
      <div className={styles.mainValue}>
        На месте: <span className={styles.highlight}>{online}</span>
        <span className={styles.total}> / {total}</span>
      </div>
      <div className={styles.sub}>
        Отсутствуют: {absent}
      </div>
      <div className={styles.goalBar}>
        <div className={styles.goalBarInfo}>
          <span className={styles.goalBarLabel}>Цель: {target}%</span>
          <span className={`${styles.goalBarValue} ${goalColor}`}>{current}%</span>
        </div>
        <div className={styles.goalBarTrack}>
          <div
            className={`${styles.goalBarFill} ${goalColor}`}
            style={{ width: `${Math.min(current, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
};
