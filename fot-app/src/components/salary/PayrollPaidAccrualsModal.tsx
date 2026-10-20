import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService, type IPayrollTermsRow, type PayrollPaidMonths } from '../../services/payrollService';
import { moscowCurrentMonth } from '../../utils/moscowDate';
import { paidMonthsRange, pickPaidRows } from '../../utils/payrollPaid';
import { PayrollPaidItemsModal } from './PayrollPaidItemsModal';

interface IPayrollPaidAccrualsModalProps {
  row: IPayrollTermsRow;
  /** Месяцы сумм строки — те, за которые пришло «Начислено». */
  months: PayrollPaidMonths;
  period: string;
  onClose: () => void;
}

/**
 * «Расчёты» → клик по сумме «Начислено»: статьи начислений по месяцам. В строке списка их нет — грузятся
 * по клику тем же запросом, что «Оплачено» в «Подробно»: окно от первого месяца до последнего, лишние
 * месяцы отсекаются.
 */
export const PayrollPaidAccrualsModal: FC<IPayrollPaidAccrualsModalProps> = ({ row, months, period, onClose }) => {
  // «Весь период» — по текущий месяц на момент открытия окна.
  const [currentMonth] = useState(moscowCurrentMonth);
  const { from, to } = paidMonthsRange(months, currentMonth);
  // Префикс 'payroll-terms' и ключ — как у usePayrollPaid: те же суммы, общий кеш.
  const query = useQuery({
    queryKey: ['payroll-terms', 'paid', row.employee_id, from, to],
    queryFn: ({ signal }) => payrollService.getPaid(row.employee_id, from, to, signal),
  });
  const amounts = useMemo(() => (query.data ? pickPaidRows(query.data, months) : null), [query.data, months]);

  return (
    <PayrollPaidItemsModal
      kind="accrued"
      row={row}
      period={period}
      amounts={amounts}
      error={query.isError}
      onRetry={() => { void query.refetch(); }}
      onClose={onClose}
    />
  );
};
