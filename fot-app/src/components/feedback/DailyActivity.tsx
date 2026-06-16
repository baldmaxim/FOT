import { type FC, useMemo } from 'react';
import type { IDailyCount } from '../../services/feedbackService';
import styles from './DailyActivity.module.css';

interface IDailyActivityProps {
  daily: IDailyCount[];
  from: string;
  to: string;
}

const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const parseIso = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const isoOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fmtRu = (d: Date): string =>
  `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;

interface IDay {
  iso: string;
  date: Date;
  weekend: boolean;
  count: number;
}

export const DailyActivity: FC<IDailyActivityProps> = ({ daily, from, to }) => {
  const days = useMemo<IDay[]>(() => {
    if (!from || !to) return [];
    const map = new Map(daily.map(d => [d.date, d.count]));
    const out: IDay[] = [];
    const end = parseIso(to);
    for (const d = parseIso(from); d <= end; d.setDate(d.getDate() + 1)) {
      const iso = isoOf(d);
      const dow = d.getDay();
      out.push({ iso, date: new Date(d), weekend: dow === 0 || dow === 6, count: map.get(iso) ?? 0 });
      if (out.length > 366) break;
    }
    return out;
  }, [daily, from, to]);

  const max = Math.max(1, ...days.map(d => d.count));
  const total = days.reduce((s, d) => s + d.count, 0);
  const showLabels = days.length <= 7;

  return (
    <div className={styles.activity}>
      <div className={styles.head}>
        <span className={styles.title}>Заполнений по дням</span>
        <span className={styles.total}><b>{total}</b> за период</span>
      </div>
      <div className={styles.spark}>
        {days.map(d => (
          <div
            key={d.iso}
            className={`${styles.bar} ${d.weekend ? styles.barWeekend : ''}`}
            style={{ height: `${d.weekend && d.count === 0 ? 6 : Math.round((d.count / max) * 100)}%` }}
            title={d.weekend ? `${fmtRu(d.date)} — выходной` : `${fmtRu(d.date)} — ${d.count} заполн.`}
          />
        ))}
      </div>
      {showLabels && (
        <div className={styles.labels}>
          {days.map(d => <span key={d.iso}>{WD[d.date.getDay()]}</span>)}
        </div>
      )}
    </div>
  );
};
