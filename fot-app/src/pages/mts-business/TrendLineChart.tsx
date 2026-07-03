import { type FC, useMemo } from 'react';
import styles from './TrendLineChart.module.css';

// Минимальный самодельный SVG line-chart (без зависимостей — recharts/chart.js
// в проекте не установлены). Показывает тренд одной метрики по дням.

export interface ITrendPoint {
  date: string; // YYYY-MM-DD
  amount: number;
}

const fmtDate = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
};

export const TrendLineChart: FC<{
  points: ITrendPoint[];
  formatValue?: (v: number) => string;
  height?: number;
}> = ({ points, formatValue = (v) => v.toLocaleString('ru-RU'), height = 140 }) => {
  const width = 600;
  const padX = 8;
  const padY = 16;

  const { path, area, min, max, first, last } = useMemo(() => {
    if (points.length === 0) {
      return { path: '', area: '', min: 0, max: 0, first: null as ITrendPoint | null, last: null as ITrendPoint | null };
    }
    const values = points.map(p => p.amount);
    const minV = Math.min(...values, 0);
    const maxV = Math.max(...values, 0);
    const span = maxV - minV || 1;
    const innerW = width - padX * 2;
    const innerH = height - padY * 2;
    const xy = points.map((p, i) => {
      const x = points.length > 1 ? padX + (innerW * i) / (points.length - 1) : padX + innerW / 2;
      const y = padY + innerH - ((p.amount - minV) / span) * innerH;
      return [x, y] as const;
    });
    const linePath = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const baseY = padY + innerH - ((0 - minV) / span) * innerH;
    const areaPath = `${linePath} L${xy[xy.length - 1][0].toFixed(1)},${baseY.toFixed(1)} L${xy[0][0].toFixed(1)},${baseY.toFixed(1)} Z`;
    return { path: linePath, area: areaPath, min: minV, max: maxV, first: points[0], last: points[points.length - 1] };
  }, [points, height]);

  if (points.length === 0) {
    return <p className={styles.empty}>Нет данных за период.</p>;
  }

  return (
    <div className={styles.wrap}>
      <svg viewBox={`0 0 ${width} ${height}`} className={styles.svg} preserveAspectRatio="none" role="img" aria-label="Тренд">
        <defs>
          <linearGradient id="mtsTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary, #2563eb)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-primary, #2563eb)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#mtsTrendFill)" stroke="none" />
        <path d={path} fill="none" stroke="var(--color-primary, #2563eb)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className={styles.axis}>
        <span>{first ? fmtDate(first.date) : ''}</span>
        <span className={styles.axisRange}>{formatValue(min)} … {formatValue(max)}</span>
        <span>{last ? fmtDate(last.date) : ''}</span>
      </div>
    </div>
  );
};
