import type { FC } from 'react';

import type { IPlannedDeductionChange } from '../../services/payrollService';
import { formatDate } from '../../utils/formatMoney';
import { shiftMonth, toMoscowDateIso } from '../../utils/moscowDate';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import { monthNumeric, plannedDeductionPeriodLabel } from '../../utils/plannedDeductionTable';
import styles from './PayrollDisclosure.module.css';

interface IPlannedDeductionChangeItemProps {
  change: IPlannedDeductionChange;
}

const kindLabel = (kind: string | null, subkind: string | null): string => (
  kind === null ? '—' : subkind ? `${kind} — ${subkind}` : kind
);

const perMonth = (amount: string | null): string => {
  const money = formatPayrollMoney(amount);
  return money === null ? '—' : `${money} ₽/мес`;
};

/** Сумма ₽/мес и, если задана, сумма последнего месяца (миграция 362): «30 000,00 ₽/мес, в последнем месяце 10 000,00 ₽». */
const amounts = (amount: string | null, lastMonthAmount: string | null): string => {
  const lastMonth = formatPayrollMoney(lastMonthAmount);
  return lastMonth === null ? perMonth(amount) : `${perMonth(amount)}, в последнем месяце ${lastMonth} ₽`;
};

const period = (from: string | null, to: string | null): string => (
  from === null ? '—' : plannedDeductionPeriodLabel({ month_from: from, month_to: to })
);

/** «Изменил: ФИО · дата» — дата изменения по Москве. */
const author = (change: IPlannedDeductionChange): string => {
  const changedOn = formatDate(toMoscowDateIso(new Date(change.changed_at)));
  return change.changed_by_name ? `Изменил: ${change.changed_by_name} · ${changedOn}` : changedOn;
};

/**
 * Запись «Истории изменений» карточки о плановом удержании (миграция 357): назначено, изменено («было → стало»: сумма
 * и сумма последнего месяца, а вид и период — если менялись), убрано с месяца (период закрыт, прошлые месяцы
 * удержаны), удалено.
 */
export const PlannedDeductionChangeItem: FC<IPlannedDeductionChangeItemProps> = ({ change }) => {
  const removed = change.action === 'removed';
  const kind = removed
    ? kindLabel(change.prev_kind_name, change.prev_subkind_name)
    : kindLabel(change.kind_name, change.subkind_name);
  const headPeriod = removed ? period(change.prev_month_from, change.prev_month_to) : period(change.month_from, change.month_to);
  const prevPeriod = period(change.prev_month_from, change.prev_month_to);
  const kindChanged = change.prev_kind_name !== change.kind_name || change.prev_subkind_name !== change.subkind_name;
  const periodChanged = change.prev_month_from !== change.month_from || change.prev_month_to !== change.month_to;
  const before = [
    `было ${amounts(change.prev_amount, change.prev_last_month_amount)}`,
    kindChanged ? `«${kindLabel(change.prev_kind_name, change.prev_subkind_name)}»` : null,
    periodChanged ? prevPeriod : null,
  ].filter(Boolean).join(', ');

  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.itemSecondary}>Плановое удержание «{kind}» {headPeriod}</span>
      </div>
      <div className={styles.amounts}>
        {change.action === 'assigned' && (
          <span className={styles.amount}>назначено {amounts(change.amount, change.last_month_amount)}</span>
        )}
        {change.action === 'changed' && (
          <>
            <span className={styles.prevAmount}>{before}</span>
            <span className={styles.prevAmount} aria-hidden="true">→</span>
            <span className={styles.amount}>стало {amounts(change.amount, change.last_month_amount)}</span>
          </>
        )}
        {change.action === 'closed' && change.month_to !== null && (
          <>
            <span className={styles.amount}>убрано с {monthNumeric(shiftMonth(change.month_to, 1))}</span>
            <span className={styles.prevAmount}>
              было {amounts(change.prev_amount, change.prev_last_month_amount)}, {prevPeriod}
            </span>
          </>
        )}
        {removed && (
          <>
            <span className={styles.amount}>удалено</span>
            <span className={styles.prevAmount}>было {amounts(change.prev_amount, change.prev_last_month_amount)}</span>
          </>
        )}
      </div>
      <div className={styles.itemMeta}>{author(change)}</div>
    </li>
  );
};
