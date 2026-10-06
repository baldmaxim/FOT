import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService, type IPayrollPaidChange } from '../services/payrollService';
import { buildPaidChanges, formatPaidAmount, paidTotals, parsePaidAmount, toPaidValues } from '../utils/payrollPaid';

export type PayrollPaidStatus = 'loading' | 'error' | 'ready';

/** Месяц ключа ячейки «YYYY-MM:статья». */
const keyMonth = (key: string): string => key.slice(0, 7);

/**
 * «Оплачено» в карточке сотрудника: сохранённые суммы за месяцы (в карточке — один выбранный) и правки ячеек.
 * Хранятся только тронутые ячейки (значение = правка ?? сохранённое): поздний ответ
 * сервера не затирает введённое. Пока суммы не загружены, править нечего — ввод недоступен.
 * Окно сдвинули (выбрали другой месяц) — правки месяцев, ушедших из окна, сбрасываются:
 * сохраняется только то, что видно. Таблица по умолчанию свёрнута до итогов.
 */
export const usePayrollPaid = (employeeId: number, months: string[]) => {
  const from = months[0] ?? '';
  const to = months[months.length - 1] ?? '';
  // Префикс 'payroll-terms': сохранение карточки сбрасывает и суммы.
  const query = useQuery({
    queryKey: ['payroll-terms', 'paid', employeeId, from, to],
    queryFn: ({ signal }) => payrollService.getPaid(employeeId, from, to, signal),
    enabled: months.length > 0,
  });
  const saved = useMemo(() => toPaidValues(query.data ?? []), [query.data]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [invalidKeys, setInvalidKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);

  // Состояние из прошлого рендера: окно сменилось — в тот же рендер убираем правки вне окна.
  const windowKey = `${from}:${to}`;
  const [editsWindow, setEditsWindow] = useState(windowKey);
  if (editsWindow !== windowKey) {
    setEditsWindow(windowKey);
    const inWindow = new Set(months);
    setEdits(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => inWindow.has(keyMonth(key)))));
    setInvalidKeys(prev => new Set([...prev].filter(key => inWindow.has(keyMonth(key)))));
  }

  const status: PayrollPaidStatus = query.data ? 'ready' : query.isError ? 'error' : 'loading';

  const cellValue = (key: string): string => edits[key] ?? saved[key] ?? '';
  const savedValue = (key: string): string | null => saved[key] ?? null;

  const changeCell = (key: string, value: string) => {
    setEdits(prev => ({ ...prev, [key]: value }));
    setInvalidKeys(prev => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  /** Уход из ячейки: верное число — в виде сохранённых («175000» → «175 000»), ошибка остаётся как введена. */
  const normalizeCell = (key: string, allowNegative = false) => {
    const raw = edits[key];
    if (raw === undefined) return;
    const value = parsePaidAmount(raw, allowNegative);
    if (typeof value === 'number') setEdits(prev => ({ ...prev, [key]: formatPaidAmount(value) }));
  };

  /** Изменённые ячейки или первая ячейка с ошибкой (для фокуса). Ошибки подсвечиваются. */
  const buildChanges = (): { changes: IPayrollPaidChange[]; firstInvalid: string | null } => {
    if (status !== 'ready') return { changes: [], firstInvalid: null };
    const result = buildPaidChanges(months, saved, edits);
    setInvalidKeys(new Set(result.invalidKeys));
    return { changes: result.changes, firstInvalid: result.invalidKeys[0] ?? null };
  };

  // 16 статей × месяц — пересчёт на каждый рендер дешевле мемоизации по правкам.
  const totals = paidTotals(months, cellValue);
  const expand = () => setExpanded(true);
  const toggleExpanded = () => setExpanded(prev => !prev);

  return {
    months,
    status,
    invalidKeys,
    totals,
    expanded,
    expand,
    toggleExpanded,
    cellValue,
    savedValue,
    changeCell,
    normalizeCell,
    buildChanges,
  };
};

export type PayrollPaidApi = ReturnType<typeof usePayrollPaid>;
