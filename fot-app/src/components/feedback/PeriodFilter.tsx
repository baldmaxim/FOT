import { type FC, type ReactNode } from 'react';
import { type PresetKey, presetRange } from './deptStats';
import styles from './PeriodFilter.module.css';

interface IPeriodFilterProps {
  from: string;
  to: string;
  today: string;
  onChange: (from: string, to: string) => void;
  /** Доп. контролы справа от дат — напр. селектор отдела. */
  children?: ReactNode;
}

const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: 'week', label: '7 дней' },
  { key: 'month', label: 'Текущий месяц' },
  { key: 'prevmonth', label: 'Прошлый месяц' },
];

export const PeriodFilter: FC<IPeriodFilterProps> = ({ from, to, today, onChange, children }) => {
  const activeKey = PRESETS.find(p => {
    const r = presetRange(p.key, today);
    return r.from === from && r.to === to;
  })?.key;

  return (
    <div className={styles.dateFilter}>
      <span className={styles.lbl}>Период:</span>
      <input
        type="date"
        className={styles.dateInput}
        value={from}
        max={to || undefined}
        onChange={e => onChange(e.target.value, to)}
      />
      <span className={styles.lbl}>—</span>
      <input
        type="date"
        className={styles.dateInput}
        value={to}
        min={from || undefined}
        onChange={e => onChange(from, e.target.value)}
      />
      <div className={styles.presets}>
        {PRESETS.map(p => (
          <button
            key={p.key}
            type="button"
            className={`${styles.preset} ${activeKey === p.key ? styles.presetActive : ''}`}
            aria-pressed={activeKey === p.key}
            onClick={() => {
              const r = presetRange(p.key, today);
              onChange(r.from, r.to);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      {children && <div className={styles.deptSelect}>{children}</div>}
    </div>
  );
};
