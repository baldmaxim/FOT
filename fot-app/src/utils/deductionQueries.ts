import type { QueryClient } from '@tanstack/react-query';

import { PAYROLL_DEDUCTION_KINDS_KEY } from '../hooks/usePayrollDeductionKinds';
import { PAYROLL_REGISTRY_KEYS } from '../services/payrollRegistryService';
import { PAYROLL_SUMMARY_KEYS } from '../services/payrollSummaryService';
import {
  STAFF_DEDUCTION_KINDS_KEY,
  STAFF_DEDUCTIONS_KEY,
  type IDeductionSubkind,
  type IStaffDeductionKind,
} from '../services/staffDeductionService';

/** «Табель → Зарплата» (useTimesheetSalary): «Удержано» и «К выплате» по людям. */
export const TIMESHEET_SALARY_KEY_PREFIX = ['timesheet-salary'] as const;

/**
 * Ключи, которые сбрасывает правка удержаний: справочники кадров и «Зарплаты», вкладку кадров «Удержания»
 * (помесячные и плановые — под STAFF_DEDUCTIONS_KEY), таблицы «Удержания» «Справочника» (под 'payroll-terms', с
 * плановыми — миграция 357), список и историю в окне сотрудника, столбцы ФОТ «Расчётов» (под 'payroll-terms'),
 * «Свод» и «Табель → Зарплата»: удержания входят в «К выплате» везде.
 */
export const DEDUCTION_QUERY_KEYS: ReadonlyArray<readonly unknown[]> = [
  STAFF_DEDUCTION_KINDS_KEY,
  PAYROLL_DEDUCTION_KINDS_KEY,
  STAFF_DEDUCTIONS_KEY,
  PAYROLL_REGISTRY_KEYS.deductions,
  PAYROLL_REGISTRY_KEYS.plannedDeductions,
  ['payroll-terms'],
  [PAYROLL_SUMMARY_KEYS.months[0]],
  TIMESHEET_SALARY_KEY_PREFIX,
];

/** Перечитать всё, где видны виды, подвиды и удержания: записи одни на оба раздела и на все расчёты. */
export const invalidateDeductionQueries = (queryClient: QueryClient): Promise<unknown> => Promise.all(
  DEDUCTION_QUERY_KEYS.map(queryKey => queryClient.invalidateQueries({ queryKey })),
);

/** Справочник после правки подвидов одного вида: остальные виды — те же объекты. */
export const withSubkinds = (
  kinds: readonly IStaffDeductionKind[],
  kindId: number,
  change: (subkinds: IDeductionSubkind[]) => IDeductionSubkind[],
): IStaffDeductionKind[] => kinds.map(kind => (kind.id === kindId ? { ...kind, subkinds: change(kind.subkinds) } : kind));

/** Есть ли что показать под видом по «+»: подвиды или (с правом правки) поле нового подвида. */
export const hasSubkindsSection = (kind: IStaffDeductionKind, canEdit: boolean): boolean => (
  canEdit || kind.subkinds.length > 0
);
