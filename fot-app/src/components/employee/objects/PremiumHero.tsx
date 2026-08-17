import type { FC } from 'react';

import type { IPremiumMonth, IPremiumScaleVersion } from '../../../api/objectKpi';
import {
  formatCoefficient,
  formatMoney,
  formatMoneyWhole,
  formatMonthLabel,
  formatPercent2,
} from '../../../utils/formatMoney';
import { PremiumFormulaNote } from './PremiumFormulaNote';
import { ScaleBar } from './ScaleBar';
import styles from './premium.module.css';

interface IPremiumHeroProps {
  month: IPremiumMonth | null;
  scale: IPremiumScaleVersion | null;
  /** Месяц ещё идёт: факт добирается подписанием актов задним числом (п. 3.1). */
  isCurrentMonth: boolean;
}

/** Текст вместо суммы: пустая плашка не объясняет, почему премии нет. */
const STATUS_TEXT: Record<IPremiumMonth['status'], string> = {
  no_scale: 'Шкала премии на этот месяц не утверждена',
  not_assigned: 'В этом месяце за вами не было закреплённых объектов',
  no_plan: 'План месяца не определён — премия не рассчитывается (п. 4.5)',
  data_incomplete: 'По части объектов нет данных для плана — расчёт не выполняется',
  calculated: '',
};

export const PremiumHero: FC<IPremiumHeroProps> = ({ month, scale, isCurrentMonth }) => {
  if (!month) {
    return (
      <section className={styles.hero}>
        <span className={styles.heroLabel}>Премия KPI (предварительно)</span>
        <span className={styles.heroValueMuted}>Нет данных за выбранный период</span>
      </section>
    );
  }

  const calculated = month.status === 'calculated';

  return (
    <section className={styles.hero}>
      <div className={styles.heroTop}>
        <span className={styles.heroLabel}>Премия KPI (предварительно)</span>
        <span className={styles.heroMonth}>{formatMonthLabel(month.period_month)}</span>
      </div>

      {calculated ? (
        <>
          <strong className={styles.heroValue}>{formatMoneyWhole(month.premium_amount)}</strong>
          <span className={styles.heroSub}>
            база {formatMoney(month.base_prorated)} × K {formatCoefficient(month.coefficient)}
            {month.eligible_assignment_days < month.days_in_month
              && ` · закрепление ${month.eligible_assignment_days} из ${month.days_in_month} дн.`}
          </span>
        </>
      ) : (
        <span className={styles.heroValueMuted}>{STATUS_TEXT[month.status]}</span>
      )}

      {month.status === 'data_incomplete' && month.incomplete_objects.length > 0 && (
        <span className={styles.heroWarn}>
          Исключены: {month.incomplete_objects.map((item) => item.object_name).join(', ')}
        </span>
      )}

      {isCurrentMonth && (
        <span className={styles.heroWarn}>
          Месяц не закрыт — факт добирается по мере подписания актов заказчиком.
        </span>
      )}

      {scale && <ScaleBar points={scale.points} completionPct={month.completion_pct} />}

      <div className={styles.tiles}>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>План КС-2</span>
          <span className={styles.tileValue}>{formatMoney(month.total_plan)}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Факт КС-2</span>
          <span className={styles.tileValue}>{formatMoney(month.total_fact)}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Выполнение</span>
          <span className={styles.tileValue}>{formatPercent2(month.completion_pct)}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>Коэффициент К</span>
          <span className={styles.tileValue}>{formatCoefficient(month.coefficient)}</span>
        </div>
      </div>

      <PremiumFormulaNote month={month} />
    </section>
  );
};
