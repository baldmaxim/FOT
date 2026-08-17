import type { FC } from 'react';

import type { IPremiumScaleVersion } from '../../../api/objectKpi';
import { formatCoefficient, formatDate, formatMoney } from '../../../utils/formatMoney';
import styles from './premium.module.css';

/** Справка по применённой версии шкалы: откуда взялся коэффициент и какая база. */
export const ScaleDetails: FC<{ scales: IPremiumScaleVersion[] }> = ({ scales }) => {
  if (scales.length === 0) return null;

  return (
    <>
      {scales.map((scale) => (
        <details key={scale.id} className={styles.scaleDetails}>
          <summary className={styles.scaleSummary}>
            Шкала премии · база {formatMoney(scale.base_amount)} · действует с{' '}
            {formatDate(scale.valid_from)}
          </summary>

          <div className={styles.scaleGrid}>
            {scale.points.map((point) => (
              <div key={point.completion_pct} className={styles.scalePoint}>
                <span>{Number(point.completion_pct)} %</span>
                <b>{formatCoefficient(point.coefficient)}</b>
              </div>
            ))}
          </div>

          <p className={styles.scaleMeta}>
            Между точками — линейная интерполяция. Максимум по шкале:{' '}
            {formatMoney(scale.max_premium)}.
            {scale.order_reference && ` Основание: ${scale.order_reference}.`}
            {scale.order_url && (
              <>
                {' '}
                <a href={scale.order_url} target="_blank" rel="noreferrer">Документ</a>
              </>
            )}
          </p>
        </details>
      ))}
    </>
  );
};
