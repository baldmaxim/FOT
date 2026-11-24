import type { QueryClient } from '@tanstack/react-query';

/** Ключ списка вкладки «Бригады». */
export const BRIGADE_OUTPUTS_QUERY_KEY = 'timesheet-salary-brigades';

/**
 * Что перечитать после правки КТУ, «Доли» или выработки бригады: доли из них видны во многих местах, и после смены КТУ
 * 1,0 → 1,4 нигде не должно остаться прежнего расчёта. Префиксы ключей:
 *  - расчёты бригад «Табеля» — «Зарплата по объектам», стрелка «Бригад», сводка «Объекты» (useTimesheetSalary,
 *    useBrigadeObjectOutputs, useBrigadeObjectsSummary);
 *  - список «Бригады»;
 *  - «Расчёты» раздела «Зарплата» (calcColumnsQueryKey) и «Свод» (PAYROLL_SUMMARY_KEYS.data).
 * Неоткрытые экраны только помечаются устаревшими и перечитываются при открытии — лишних расчётов нет.
 */
export const BRIGADE_SALARY_DEPENDENT_KEYS: ReadonlyArray<readonly string[]> = [
  ['timesheet-salary'],
  [BRIGADE_OUTPUTS_QUERY_KEY],
  ['payroll-terms', 'calc-columns'],
  ['payroll-summary', 'data'],
];

export const invalidateBrigadeOutputs = (queryClient: QueryClient): Promise<unknown> => Promise.all(
  BRIGADE_SALARY_DEPENDENT_KEYS.map(queryKey => queryClient.invalidateQueries({ queryKey: [...queryKey] })),
);
