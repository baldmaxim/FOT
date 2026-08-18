import type { FC } from 'react';

import type { IPremiumScaleVersion } from '../../../api/objectKpi';
import styles from './premium.module.css';

interface IScaleBarProps {
  /** Точки действующей версии шкалы. Зашивать 80–110 нельзя: шкалу меняет приказ (п. 8.3). */
  points: IPremiumScaleVersion['points'];
  completionPct: string | null;
}

/** Положение значения на отрезке [min точка; max точка] в процентах ширины. */
const position = (value: number, min: number, max: number): number => {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
};

export const ScaleBar: FC<IScaleBarProps> = ({ points, completionPct }) => {
  if (points.length === 0) return null;

  const pcts = points.map((point) => Number(point.completion_pct));
  const min = Math.min(...pcts);
  const max = Math.max(...pcts);
  const value = completionPct === null ? null : Number(completionPct);

  const zone = value === null
    ? 'Процент выполнения не определён'
    : value < min
      ? 'Ниже минимального порога шкалы — премия не начисляется'
      : value >= max
        ? 'Максимум шкалы — предельный коэффициент'
        : value >= 100
          ? 'План выполнен / перевыполнен — повышенный коэффициент'
          : 'План не выполнен — пониженный коэффициент';

  // Заливка идёт до результата, дальше полоса нейтральная: сплошной градиент на всю
  // ширину читался как «шкала целиком пройдена».
  const fillPct = value === null ? 0 : position(value, min, max);

  // Граница красной зоны берётся из самой шкалы, а не из числа 85: премия начинает
  // начисляться с первой точки с ненулевым коэффициентом, и зелёный обязан начинаться там же.
  const firstPaying = points.find((point) => Number(point.coefficient) > 0);
  const greenAt = firstPaying ? position(Number(firstPaying.completion_pct), min, max) : 0;
  const gradient = `linear-gradient(90deg, var(--error) 0%, var(--warning) ${greenAt / 2}%,`
    + ` var(--success) ${greenAt}%, var(--success) 100%)`;

  return (
    <div className={styles.scale}>
      <div className={styles.scaleTrack}>
        {fillPct > 0 && (
          <span
            className={styles.scaleFill}
            style={{
              width: `${fillPct}%`,
              backgroundImage: gradient,
              // Фон растягивается на ширину ВСЕГО трека, а заливка его обрезает: иначе
              // цвета сжимались бы вместе с полосой и «зелёный с 85 %» уезжал за маркер.
              backgroundSize: `${(100 / fillPct) * 100}% 100%`,
            }}
          />
        )}
        {value !== null && (
          <span className={styles.scaleMarker} style={{ left: `${fillPct}%` }} />
        )}
      </div>
      <div className={styles.scaleTicks}>
        {points.map((point) => (
          <span
            key={point.completion_pct}
            className={styles.scaleTick}
            style={{ left: `${position(Number(point.completion_pct), min, max)}%` }}
          >
            {Number(point.completion_pct)}
          </span>
        ))}
      </div>
      <span className={styles.scaleZone}>{zone}</span>
    </div>
  );
};
