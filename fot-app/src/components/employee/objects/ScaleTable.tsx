import type { FC } from 'react';

import type { IPremiumMonth, IPremiumScaleVersion } from '../../../api/objectKpi';
import {
  formatCoefficient,
  formatMoney,
  formatMoneyWhole,
  formatPercent2,
} from '../../../utils/formatMoney';
import styles from './premium.module.css';

interface IScaleTableProps {
  /** Шкала ВЫБРАННОГО месяца: окно может пересечь две версии с разными базами. */
  scale: IPremiumScaleVersion | null;
  interpolation: IPremiumMonth['interpolation'];
  completionPct: string | null;
}

/**
 * Шкала приказа с подсветкой того места, куда попал результат месяца.
 *
 * Разбираются четыре случая: точное попадание в точку, интерполяция между двумя,
 * результат ниже минимума и выше максимума. Иначе при ровно 105 % подпись сказала бы
 * «между 105 % и 110 %», а при 120 % подсветилась бы несуществующая верхняя граница.
 */
export const ScaleTable: FC<IScaleTableProps> = ({ scale, interpolation, completionPct }) => {
  if (!scale) return null;

  const lower = interpolation?.lower_pct ?? null;
  const upper = interpolation?.upper_pct ?? null;
  const exact = lower !== null && completionPct !== null && Number(lower) === Number(completionPct);

  const highlighted = new Set<string>();
  if (interpolation) {
    if (exact) highlighted.add(String(Number(lower)));
    else {
      if (lower !== null) highlighted.add(String(Number(lower)));
      if (upper !== null) highlighted.add(String(Number(upper)));
      // Ниже минимума / выше максимума: подсвечиваем крайнюю точку шкалы.
      if (lower === null && scale.points.length > 0) {
        highlighted.add(String(Number(scale.points[0].completion_pct)));
      }
      if (upper === null && scale.points.length > 0) {
        highlighted.add(String(Number(scale.points[scale.points.length - 1].completion_pct)));
      }
    }
  }

  const hint = (): string | null => {
    if (!interpolation || completionPct === null) return null;
    if (exact) return `Ваш результат — ровно ${formatPercent2(completionPct)}`;
    if (lower === null) {
      return `Ваш результат ${formatPercent2(completionPct)} — ниже ${Number(scale.points[0]?.completion_pct)} %, премия не начисляется`;
    }
    if (upper === null) {
      return `Ваш результат ${formatPercent2(completionPct)} — ${Number(lower)} % и более, предельный коэффициент`;
    }
    return `Ваш результат ${formatPercent2(completionPct)} — между ${Number(lower)} % и ${Number(upper)} %`;
  };

  const hintText = hint();

  return (
    <section className={styles.scaleTable}>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Выполнение</th>
              <th className={styles.num}>K</th>
              <th className={styles.num}>Премия*</th>
            </tr>
          </thead>
          <tbody>
            {scale.points.map((point, index) => {
              const pct = Number(point.completion_pct);
              const isFirst = index === 0;
              const isLast = index === scale.points.length - 1;
              return (
                <tr
                  key={point.completion_pct}
                  className={highlighted.has(String(pct)) ? styles.scaleRowActive : undefined}
                >
                  <td>
                    {isFirst ? `${pct} % и менее` : isLast ? `${pct} % и более` : `${pct} %`}
                  </td>
                  <td className={styles.num}>{formatCoefficient(point.coefficient)}</td>
                  <td className={styles.num}>{formatMoneyWhole(point.premium_amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hintText && <p className={styles.scaleHint}>{hintText}</p>}

      <p className={styles.scaleMeta}>
        * при базе {formatMoney(scale.base_amount)}. Между контрольными точками — линейная
        интерполяция, K округляется до 2 знаков.
        {scale.order_reference && ` Основание: ${scale.order_reference}.`}
        {scale.order_url && (
          <>
            {' '}
            <a href={scale.order_url} target="_blank" rel="noreferrer">Документ</a>
          </>
        )}
      </p>
    </section>
  );
};
