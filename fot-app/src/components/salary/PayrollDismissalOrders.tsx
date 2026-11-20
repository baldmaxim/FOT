import type { FC } from 'react';

import type { IPayrollDismissalOrder } from '../../services/payrollService';
import { formatDate } from '../../utils/formatMoney';
import { formatPaidAmount } from '../../utils/payrollPaid';
import styles from './PayrollDismissalOrders.module.css';

interface IPayrollDismissalOrdersProps {
  orders: readonly IPayrollDismissalOrder[];
}

/** Расхождение приказа 1С с карточкой ФОТ: не уволен или другая дата. */
const fotMismatch = (order: IPayrollDismissalOrder): string | null => {
  if (!order.fot_dismissal_date) return 'в ФОТ не уволен';
  if (order.dismissal_date && order.fot_dismissal_date !== order.dismissal_date) return `в ФОТ — ${formatDate(order.fot_dismissal_date)}`;
  return null;
};

/**
 * Приказы об увольнении из 1С (API) за месяцы «Оплачено»: номер, дата, дата увольнения, основание и начисления.
 * Само увольнение в ФОТ ведут кадры — расхождение только подсвечивается.
 */
export const PayrollDismissalOrders: FC<IPayrollDismissalOrdersProps> = ({ orders }) => {
  if (orders.length === 0) return null;
  return (
    <ul className={styles.list} aria-label="Приказы об увольнении из 1С">
      {orders.map(order => {
        const mismatch = fotMismatch(order);
        const amounts = [
          Number(order.vacation_compensation) > 0 ? `компенсация отпуска ${formatPaidAmount(Number(order.vacation_compensation))}` : null,
          Number(order.severance) > 0 ? `выходное пособие ${formatPaidAmount(Number(order.severance))}` : null,
        ].filter(Boolean).join(' · ');
        return (
          <li key={order.guid} className={styles.item}>
            <span className={styles.title}>Увольнение:</span>{' '}
            приказ № {order.doc_number} от {formatDate(order.doc_date)}
            {order.dismissal_date && <> · уволен {formatDate(order.dismissal_date)}</>}
            {order.basis && <> · {order.basis}</>}
            {amounts && <> · {amounts}</>}
            {mismatch && <span className={styles.mismatch}> · {mismatch}</span>}
          </li>
        );
      })}
    </ul>
  );
};
