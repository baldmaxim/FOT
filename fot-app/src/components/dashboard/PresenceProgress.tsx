import type { FC } from 'react';
import { Card, CardHeader, CardContent } from '../ui/Card';
import type { IEmployeePresence } from '../../types';
import styles from './PresenceProgress.module.css';

interface IPresenceProgressProps {
  employees: IEmployeePresence[];
  loading: boolean;
}

export const PresenceProgress: FC<IPresenceProgressProps> = ({ employees, loading }) => {
  const online = employees.filter(e => e.status === 'online').length;
  const offline = employees.filter(e => e.status === 'offline').length;
  const total = employees.length;
  const percent = total > 0 ? Math.round((online / total) * 100) : 0;

  return (
    <Card>
      <CardHeader title="Присутствие" />
      <CardContent>
        {loading || total === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyText}>{loading ? 'Загрузка...' : 'Нет данных'}</span>
          </div>
        ) : (
          <div className={styles.list}>
            <div className={styles.summary}>
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>На работе</span>
                <span className={styles.summaryValue}>{online} из {total}</span>
              </div>
              <div className={styles.progressBar}>
                <div className={styles.progressFill} style={{ width: `${percent}%` }} />
              </div>
            </div>
            <div className={styles.stats}>
              <div className={styles.stat}>
                <span className={styles.statDot} data-status="online" />
                <span>Онлайн: {online}</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statDot} data-status="offline" />
                <span>Оффлайн: {offline}</span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
