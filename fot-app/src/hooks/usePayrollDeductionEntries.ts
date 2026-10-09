import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService, type IPayrollDeductionEntryPayload } from '../services/payrollService';
import {
  firstInvalidDeductionField,
  isDeductionEntriesChanged,
  toDeductionDrafts,
  validateDeductionEntries,
  type DeductionEntriesErrors,
  type DeductionEntryField,
  type IDeductionEntryDraft,
} from '../utils/payrollDeductionEntries';

/** Ключ удержаний сотрудника. Префикс 'payroll-terms': сохранение карточки перечитывает и их. */
export const payrollDeductionEntriesKey = (employeeId: number) => (
  ['payroll-terms', 'deduction-entries', 'employee', employeeId] as const
);

/**
 * Удержания сотрудника по месяцам в карточке: сохранённые и правка. Правка хранится, только если её делали:
 * поздний ответ сервера не затирает введённое. Сохраняется вместе с карточкой («Сохранить»).
 * Ошибки — по строкам, снимаются при правке своего поля.
 */
export const usePayrollDeductionEntries = (employeeId: number) => {
  const query = useQuery({
    queryKey: payrollDeductionEntriesKey(employeeId),
    queryFn: ({ signal }) => payrollService.getDeductionEntries(employeeId, signal),
  });
  const saved = useMemo(() => (query.data ? toDeductionDrafts(query.data) : null), [query.data]);
  const [edited, setEdited] = useState<IDeductionEntryDraft[] | null>(null);
  const [errors, setErrors] = useState<DeductionEntriesErrors>({});
  const nextKey = useRef(0);
  const drafts = edited ?? saved ?? [];

  /** Правка — от последнего набора, а не от отрисованного: две правки подряд не теряются. */
  const update = (change: (list: IDeductionEntryDraft[]) => IDeductionEntryDraft[]) => {
    setEdited(prev => change(prev ?? saved ?? []));
  };

  /** Снять ошибку поля строки; без field — все ошибки строки. */
  const clearError = (key: string, field?: DeductionEntryField) => {
    setErrors(prev => {
      const rowErrors = prev[key];
      if (!rowErrors || (field && !rowErrors[field])) return prev;
      const next = { ...prev };
      const rest = { ...rowErrors };
      if (field) delete rest[field];
      if (!field || Object.keys(rest).length === 0) delete next[key];
      else next[key] = rest;
      return next;
    });
  };

  /** Новая пустая строка за месяц month; возвращает её ключ (фокус на «Вид»). */
  const add = (month: string): string => {
    nextKey.current += 1;
    const key = `new-${nextKey.current}`;
    update(list => [...list, { key, month, kindId: null, amount: '' }]);
    return key;
  };

  const remove = (key: string) => {
    update(list => list.filter(draft => draft.key !== key));
    clearError(key);
  };

  /** Месяц и вид проверяются вместе (повтор вида за месяц) — правка любого снимает ошибку вида. */
  const change = (key: string, patch: Partial<Pick<IDeductionEntryDraft, 'month' | 'kindId' | 'amount'>>) => {
    update(list => list.map(draft => (draft.key === key ? { ...draft, ...patch } : draft)));
    if (patch.amount !== undefined) clearError(key, 'amount');
    if (patch.month !== undefined || patch.kindId !== undefined) clearError(key, 'kind');
  };

  const isChanged = (): boolean => edited !== null && saved !== null && isDeductionEntriesChanged(edited, saved);

  /** Проверяет строки: запрос сохранения или первое поле с ошибкой (для фокуса). */
  const buildPayload = (): {
    payload: IPayrollDeductionEntryPayload[] | null;
    firstInvalid: { key: string; field: DeductionEntryField } | null;
  } => {
    const result = validateDeductionEntries(drafts);
    setErrors(result.errors ?? {});
    return result.errors
      ? { payload: null, firstInvalid: firstInvalidDeductionField(drafts, result.errors) }
      : { payload: result.payload, firstInvalid: null };
  };

  return {
    drafts,
    errors,
    /** Пока удержания не загружены, править нечего: добавление недоступно. */
    ready: saved !== null,
    isError: query.isError,
    add,
    remove,
    change,
    isChanged,
    buildPayload,
  };
};

export type PayrollDeductionEntriesApi = ReturnType<typeof usePayrollDeductionEntries>;
