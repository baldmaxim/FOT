import { Fragment, type FC, type ReactNode } from 'react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { accrualLines, accrualsByMonthParts, type IAccrualMonthPart } from '../../utils/payrollAccruals';
import styles from './PayrollTermsTable.module.css';

const renderAccrualLine = (line: IAccrualMonthPart[]): ReactNode => line.map(({ month, name, amount, pending }, index) => (
  <Fragment key={month}>
    {index > 0 && <span className={styles.accrualSep}>; </span>}
    <span className={styles.accrualMonth}>{name}</span>
    {amount === null
      ? (pending ? ' …' : ' —')
      : <>:{' '}<span className={styles.accrualAmount}>{amount}</span></>}
  </Fragment>
));

interface IPayrollAccrualsTextProps {
  /** Месяцы столбца (YYYY-MM) по порядку. */
  months: string[];
  row: IPayrollTermsRow;
}

/**
 * «Выплачено» таблицы «Условий оплаты»: месяцы курсивом, суммы крупнее; две строки поровну (3 + 3), между месяцем и
 * суммой NBSP. Ширину содержимого считает usePayrollAccrualsColumnWidth — разметку менять вместе с accrualsCellWidth
 * («…» там меряется как «—», ширина почти та же). Пока расчёт ФОТ порции идёт — суммы 1С списка, месяц без суммы — «…».
 */
export const PayrollAccrualsText: FC<IPayrollAccrualsTextProps> = ({ months, row }) => {
  const pending = row.payouts_status === 'pending';
  const parts = accrualsByMonthParts(months, row.payouts, pending);
  if (parts === null) return pending ? '…' : '—';
  const [first, second] = accrualLines(parts);
  return (
    <span className={styles.accruals}>
      {renderAccrualLine(first)}
      {second.length > 0 && <>;<br />{renderAccrualLine(second)}</>}
    </span>
  );
};
