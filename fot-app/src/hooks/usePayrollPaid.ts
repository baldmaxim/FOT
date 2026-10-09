import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService } from '../services/payrollService';
import { paidTotals, toPaidAmounts, visiblePaidGroups, type IPayrollPaidGroup } from '../utils/payrollPaid';

export type PayrollPaidStatus = 'loading' | 'error' | 'ready';

/**
 * «Оплачено» в карточке сотрудника: суммы за выбранные месяцы (по возрастанию, могут идти
 * вразброс), итоги и статьи с суммами для раскрытых таблиц — у каждого месяца своя таблица.
 * Только чтение — суммы приходят из 1С. Таблицы по умолчанию свёрнуты до итогов.
 */
export const usePayrollPaid = (employeeId: number, months: string[]) => {
  const from = months[0] ?? '';
  const to = months[months.length - 1] ?? '';
  // Месяцы вразброс — грузим окно от первого до последнего, лишние месяцы не показываются.
  // Префикс 'payroll-terms': сохранение карточки перечитывает и суммы.
  const query = useQuery({
    queryKey: ['payroll-terms', 'paid', employeeId, from, to],
    queryFn: ({ signal }) => payrollService.getPaid(employeeId, from, to, signal),
    enabled: months.length > 0,
  });
  const [expanded, setExpanded] = useState(false);

  const amounts = useMemo(() => toPaidAmounts(query.data ?? []), [query.data]);
  const totals = useMemo(() => paidTotals(months, amounts), [months, amounts]);
  // В таблице месяца — только статьи с суммой за этот месяц.
  const groupsByMonth = useMemo(() => {
    const byMonth: Record<string, IPayrollPaidGroup[]> = {};
    for (const month of months) byMonth[month] = visiblePaidGroups([month], amounts);
    return byMonth;
  }, [months, amounts]);
  const status: PayrollPaidStatus = query.data ? 'ready' : query.isError ? 'error' : 'loading';

  return {
    months,
    status,
    amounts,
    totals,
    groupsByMonth,
    expanded,
    toggleExpanded: () => setExpanded(prev => !prev),
  };
};

export type PayrollPaidApi = ReturnType<typeof usePayrollPaid>;
