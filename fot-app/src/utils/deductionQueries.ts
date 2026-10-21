import type { QueryClient } from '@tanstack/react-query';

import { PAYROLL_DEDUCTION_KINDS_KEY } from '../hooks/usePayrollDeductionKinds';
import { PAYROLL_REGISTRY_KEYS } from '../services/payrollRegistryService';
import {
  STAFF_DEDUCTION_KINDS_KEY,
  STAFF_DEDUCTIONS_KEY,
  type IDeductionSubkind,
  type IStaffDeductionKind,
} from '../services/staffDeductionService';

/**
 * Перечитать всё, где видны виды, подвиды и удержания (миграция 321): справочники кадров и «Зарплаты», вкладку
 * кадров «Удержания», таблицу «Удержания» «Справочника» и список в окне сотрудника (ключ под STAFF_DEDUCTIONS_KEY).
 * Записи одни на оба раздела — правка в одном месте должна быть видна в другом.
 */
export const invalidateDeductionQueries = (queryClient: QueryClient): Promise<unknown> => Promise.all([
  queryClient.invalidateQueries({ queryKey: STAFF_DEDUCTION_KINDS_KEY }),
  queryClient.invalidateQueries({ queryKey: PAYROLL_DEDUCTION_KINDS_KEY }),
  queryClient.invalidateQueries({ queryKey: STAFF_DEDUCTIONS_KEY }),
  queryClient.invalidateQueries({ queryKey: PAYROLL_REGISTRY_KEYS.deductions }),
]);

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
