import type { FC } from 'react';

import type { IPremiumMonth, IPremiumScaleVersion } from '../../../api/objectKpi';
import {
  formatCoefficient,
  formatMoney,
  formatMoneyWhole,
  formatPercent2,
} from '../../../utils/formatMoney';
import { MonthPicker } from './MonthPicker';
import { PremiumFormulaNote } from './PremiumFormulaNote';
import { ScaleBar } from './ScaleBar';
import styles from './premium.module.css';

interface IPremiumHeroProps {
  month: IPremiumMonth | null;
  scale: IPremiumScaleVersion | null;
  /** Месяц ещё идёт: факт добирается подписанием актов задним числом (п. 3.1). */
  isCurrentMonth: boolean;
  pickerValue: string;
  pickerMax: string;
  onMonthChange: (month: string) => void;
}

/** Текст вместо суммы: пустая плашка не объясняет, почему премии нет. */
const STATUS_TEXT: Record<IPremiumMonth['status'], string> = {
  no_scale: 'Шкала премии на этот месяц не утверждена',
  not_assigned: 'В этом месяце за вами не было закреплённых объектов',
  no_plan: 'План месяца не определён — премия не рассчитывается (п. 4.5)',
  data_incomplete: 'По части объектов нет данных для плана — расчёт не выполняется',
  calculated: '',
};

export const PremiumHero: FC<IPremiumHeroProps> = ({
  month,
  scale,
  isCurrentMonth,
  pickerValue,
  pickerMax,
  onMonthChange,
}) => {
  const calculated = month?.status === 'calculated';
  const prorated = month != null && month.eligible_assignment_days < month.days_in_month;
  // Оклад не задан — плашка выглядит как раньше: пустые «Зарплата» и «Итого» = премии
  // только шумят.
  const hasSalary = month?.salary_amount != null;

  return (
    <section className={styles.hero}>
      <div className={styles.heroTop}>
        <span className={styles.heroLabel}>Премия KPI (предварительно)</span>
        <MonthPicker value={pickerValue} max={pickerMax} onChange={onMonthChange} />
      </div>

      {!month && <span className={styles.heroValueMuted}>Нет данных за выбранный месяц</span>}

      {/*
        Премия и зарплата живут по разным правилам: план месяца может быть не определён,
        и премия тогда не считается, а оклад начисляется всё равно. Поэтому суммы стоят
        рядом, а причина отсутствия премии уходит отдельной строкой под ними.
      */}
      {month && (
        <>
          <div className={styles.heroAmounts}>
            <div className={styles.heroAmount}>
              {!hasSalary && !calculated ? (
                <span className={styles.heroValueMuted}>{STATUS_TEXT[month.status]}</span>
              ) : (
                <>
                  {hasSalary && <span className={styles.heroAmountLabel}>Премия</span>}
                  <strong className={styles.heroValue}>
                    {calculated ? formatMoneyWhole(month.premium_amount) : '—'}
                  </strong>
                </>
              )}
            </div>

            {hasSalary && (
              <>
                <div className={styles.heroAmount}>
                  <span className={styles.heroAmountLabel}>Зарплата</span>
                  <strong className={styles.heroValueSecondary}>
                    {formatMoneyWhole(month.salary_amount)}
                  </strong>
                </div>
                <div className={styles.heroAmount}>
                  <span className={styles.heroAmountLabel}>Итого</span>
                  <strong className={styles.heroValueSecondary}>
                    {formatMoneyWhole(month.total_amount)}
                  </strong>
                </div>
              </>
            )}
          </div>

          {calculated ? (
            <span className={styles.heroSub}>
              база {formatMoney(month.base_prorated)} × K {formatCoefficient(month.coefficient)}
              {prorated && ` · закрепление ${month.eligible_assignment_days} из ${month.days_in_month} дн.`}
            </span>
          ) : hasSalary && (
            <span className={styles.heroSub}>{STATUS_TEXT[month.status]}</span>
          )}
        </>
      )}

      {month?.status === 'data_incomplete' && month.incomplete_objects.length > 0 && (
        <span className={styles.heroWarn}>
          Исключены: {month.incomplete_objects.map((item) => item.object_name).join(', ')}
        </span>
      )}

      {isCurrentMonth && (
        <span className={styles.heroWarn}>
          Месяц не закрыт — факт добирается по мере подписания актов заказчиком.
        </span>
      )}

      {month && (
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
      )}

      {month && scale && <ScaleBar points={scale.points} completionPct={month.completion_pct} />}

      {month && <PremiumFormulaNote month={month} />}
    </section>
  );
};
