import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService, type IPayrollDeductionKind } from '../services/payrollService';
import { sameDeductionKinds, toggleDeductionKind } from '../utils/payrollDeductions';

/** Ключ видов сотрудника. Префикс 'payroll-terms': сохранение карточки перечитывает и их. */
export const payrollEmployeeDeductionsKey = (employeeId: number) => ['payroll-terms', 'deductions', 'employee', employeeId] as const;

/**
 * Виды удержаний сотрудника в окне карточки на «Расчётах»: сохранённые и правка. Правка хранится,
 * только если её делали: поздний ответ сервера не затирает отмеченное. Сохраняется вместе
 * с карточкой («Сохранить»), а не по каждой галочке. enabled = false («Подробно», где удержания
 * не вносят) — не грузятся и не меняются.
 */
export const usePayrollEmployeeDeductions = (employeeId: number, enabled = true) => {
  const query = useQuery({
    queryKey: payrollEmployeeDeductionsKey(employeeId),
    queryFn: ({ signal }) => payrollService.getEmployeeDeductions(employeeId, signal),
    enabled,
  });
  const [edited, setEdited] = useState<number[] | null>(null);
  const saved = query.data ?? null;
  const selected = edited ?? saved ?? [];

  /** Галочка в меню: от последнего набора, а не от отрисованного (две галочки подряд не теряются). */
  const toggle = (kindId: number, checked: boolean, kinds: readonly IPayrollDeductionKind[]) => {
    setEdited(prev => toggleDeductionKind(prev ?? saved ?? [], kindId, checked, kinds));
  };

  /** Изменённый набор для сохранения; не меняли (или вернули как было) — null. */
  const changedKindIds = (): number[] | null => (
    edited !== null && saved !== null && !sameDeductionKinds(edited, saved) ? edited : null
  );

  return {
    selected,
    /** Пока виды не загружены, править нечего: поле недоступно. */
    ready: saved !== null,
    isError: query.isError,
    toggle,
    changedKindIds,
  };
};

export type PayrollEmployeeDeductionsApi = ReturnType<typeof usePayrollEmployeeDeductions>;
