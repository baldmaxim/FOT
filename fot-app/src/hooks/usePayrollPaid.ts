import { useMemo, useState } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { payroll1cPayoutsService } from '../services/payroll1cPayoutsService';
import { payrollService } from '../services/payrollService';
import { PAYROLL_PAID_ALL_FROM, paidTotals, toPaidAmounts, visiblePaidGroups } from '../utils/payrollPaid';

export type PayrollPaidStatus = 'loading' | 'error' | 'ready';

/**
 * «История выплат» карточки: все суммы «Оплачено» по toMonth. Один запрос на вкладку и «Экспорт» —
 * toMonth берётся у карточки, чтобы ключ совпадал и открытая история не грузилась повторно.
 * Префикс 'payroll-terms': сохранение карточки перечитывает и суммы.
 */
export const paidHistoryQueryOptions = (employeeId: number, toMonth: string) => queryOptions({
  queryKey: ['payroll-terms', 'paid-history', employeeId, toMonth],
  queryFn: ({ signal }) => payrollService.getPaid(employeeId, PAYROLL_PAID_ALL_FROM, toMonth, signal),
  staleTime: 30_000,
});

/**
 * «Перечислено (1С)» для «Истории выплат» и «Экспорта»: ведомости выплаты по месяцам начисления до toMonth.
 * Тот же префикс 'payroll-terms': загрузка ведомости сбрасывает его, открытая карточка перечитывает.
 */
export const payouts1cHistoryQueryOptions = (employeeId: number, toMonth: string) => queryOptions({
  queryKey: ['payroll-terms', 'payouts-1c-history', employeeId, toMonth],
  queryFn: ({ signal }) => payroll1cPayoutsService.getByEmployee(employeeId, PAYROLL_PAID_ALL_FROM, toMonth, signal),
  staleTime: 30_000,
});

/**
 * «Оплачено» в карточке сотрудника: суммы за выбранные месяцы (по возрастанию, могут идти
 * вразброс), итоги и статьи с суммами для раскрытой таблицы — месяцы в ней столбцами.
 * Только чтение — суммы приходят из 1С. По умолчанию свёрнуто до итогов.
 * enabled = false — «Оплачено» на экране нет (окно «Расчётов»): суммы не запрашиваются.
 */
export const usePayrollPaid = (employeeId: number, months: string[], enabled = true) => {
  const from = months[0] ?? '';
  const to = months[months.length - 1] ?? '';
  // Месяцы вразброс — грузим окно от первого до последнего, лишние месяцы не показываются.
  // Префикс 'payroll-terms': сохранение карточки перечитывает и суммы.
  const query = useQuery({
    queryKey: ['payroll-terms', 'paid', employeeId, from, to],
    queryFn: ({ signal }) => payrollService.getPaid(employeeId, from, to, signal),
    enabled: enabled && months.length > 0,
  });
  const [expanded, setExpanded] = useState(false);

  const amounts = useMemo(() => toPaidAmounts(query.data ?? []), [query.data]);
  const totals = useMemo(() => paidTotals(months, amounts), [months, amounts]);
  // Статьи с суммой хотя бы за один из выбранных месяцев.
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
