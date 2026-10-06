import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService } from '../services/payrollService';
import { paidTotals, toPaidAmounts, visiblePaidGroups } from '../utils/payrollPaid';

export type PayrollPaidStatus = 'loading' | 'error' | 'ready';

/**
 * «Оплачено» в карточке сотрудника: суммы за месяцы окна (в карточке — один выбранный), итоги
 * и статьи с суммами для раскрытой таблицы. Только чтение — суммы приходят из 1С.
 * Таблица по умолчанию свёрнута до итогов.
 */
export const usePayrollPaid = (employeeId: number, months: string[]) => {
  const from = months[0] ?? '';
  const to = months[months.length - 1] ?? '';
  // Префикс 'payroll-terms': сохранение карточки перечитывает и суммы.
  const query = useQuery({
    queryKey: ['payroll-terms', 'paid', employeeId, from, to],
    queryFn: ({ signal }) => payrollService.getPaid(employeeId, from, to, signal),
    enabled: months.length > 0,
  });
  const [expanded, setExpanded] = useState(false);

  const amounts = useMemo(() => toPaidAmounts(query.data ?? []), [query.data]);
  const totals = useMemo(() => paidTotals(months, amounts), [months, amounts]);
  const groups = useMemo(() => visiblePaidGroups(months, amounts), [months, amounts]);
  const status: PayrollPaidStatus = query.data ? 'ready' : query.isError ? 'error' : 'loading';

  return {
    months,
    status,
    amounts,
    totals,
    groups,
    expanded,
    toggleExpanded: () => setExpanded(prev => !prev),
  };
};

export type PayrollPaidApi = ReturnType<typeof usePayrollPaid>;
