import { useMemo, useState, type FC } from 'react';
import { X } from 'lucide-react';

import { usePayrollDeductionKinds } from '../../hooks/usePayrollDeductionKinds';
import type { PayrollDeductionEntriesApi } from '../../hooks/usePayrollDeductionEntries';
import { moscowCurrentMonth } from '../../utils/moscowDate';
import { formatAccrualMonthLabel, payrollMonthOptions } from '../../utils/payrollAccruals';
import { deductionFieldId, deductionMonthOptions } from '../../utils/payrollDeductionEntries';
import fields from './PayrollTermsFields.module.css';
import styles from './PayrollDeductionEntries.module.css';

interface IPayrollDeductionEntriesProps {
  entries: PayrollDeductionEntriesApi;
  idPrefix: string;
  readOnly?: boolean;
  /** Месяц новой строки (YYYY-MM). */
  defaultMonth: string;
}

/**
 * «Удержание» карточки: строки «Месяц · Вид · Сумма» — один вид за месяц одной строкой.
 * Подписи — у первой строки, у остальных те же поля под ней. Сохраняется с карточкой.
 */
export const PayrollDeductionEntries: FC<IPayrollDeductionEntriesProps> = ({
  entries,
  idPrefix,
  readOnly = false,
  defaultMonth,
}) => {
  const kinds = usePayrollDeductionKinds();
  const kindList = kinds.data ?? [];
  // «Сегодня» — на момент открытия карточки: месяцы выбора не сдвигаются, пока она открыта.
  const [currentMonth] = useState(moscowCurrentMonth);
  const baseMonths = useMemo(() => payrollMonthOptions(currentMonth), [currentMonth]);
  const months = deductionMonthOptions(baseMonths, entries.drafts);
  // Месяцы в разных годах — у каждого подписи нужен год.
  const withYear = new Set(months.map(month => month.slice(0, 4))).size > 1;
  const kindName = (kindId: number | null) => kindList.find(kind => kind.id === kindId)?.name ?? '';

  /** Новая строка — фокус на её «Вид»: поле появится после отрисовки. */
  const addRow = () => {
    const key = entries.add(defaultMonth);
    requestAnimationFrame(() => document.getElementById(deductionFieldId(idPrefix, key, 'kind'))?.focus());
  };

  if (entries.isError) return <p className={fields.error}>Не удалось загрузить удержания</p>;
  if (readOnly && entries.drafts.length === 0) return <p className={styles.empty}>—</p>;

  return (
    <div className={styles.entries}>
      {entries.drafts.map((draft, index) => {
        const errors = entries.errors[draft.key] ?? {};
        const monthId = deductionFieldId(idPrefix, draft.key, 'month');
        const kindId = deductionFieldId(idPrefix, draft.key, 'kind');
        const amountId = deductionFieldId(idPrefix, draft.key, 'amount');
        const showLabels = index === 0;
        const rowLabel = [formatAccrualMonthLabel(draft.month, true), kindName(draft.kindId)].filter(Boolean).join(' · ');
        return (
          <div key={draft.key} className={styles.row}>
            <div className={`${fields.field} ${styles.month}`}>
              {showLabels && <label htmlFor={monthId} className={fields.label}>Месяц</label>}
              <select
                id={monthId}
                className={fields.control}
                value={draft.month}
                disabled={readOnly}
                aria-label={showLabels ? undefined : 'Месяц'}
                onChange={event => entries.change(draft.key, { month: event.target.value })}
              >
                {months.map(month => (
                  <option key={month} value={month}>{formatAccrualMonthLabel(month, withYear)}</option>
                ))}
              </select>
            </div>

            <div className={`${fields.field} ${styles.kind}`}>
              {showLabels && <label htmlFor={kindId} className={fields.label}>Вид</label>}
              <select
                id={kindId}
                className={fields.control}
                value={draft.kindId ?? ''}
                disabled={readOnly || !kinds.data}
                aria-label={showLabels ? undefined : 'Вид'}
                aria-invalid={errors.kind ? true : undefined}
                aria-describedby={errors.kind ? `${kindId}-error` : undefined}
                onChange={event => entries.change(draft.key, { kindId: event.target.value ? Number(event.target.value) : null })}
              >
                <option value="">—</option>
                {kindList.map(kind => <option key={kind.id} value={kind.id}>{kind.name}</option>)}
              </select>
              {errors.kind && <p id={`${kindId}-error`} className={fields.error}>{errors.kind}</p>}
            </div>

            <div className={`${fields.field} ${styles.amount}`}>
              {showLabels && <label htmlFor={amountId} className={fields.label}>Сумма, ₽</label>}
              {/* Крестик строки — рядом с суммой: подпись над обоими, ошибка под обоими. */}
              <div className={styles.amountRow}>
                <input
                  id={amountId}
                  className={fields.control}
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.amount}
                  disabled={readOnly}
                  aria-label={showLabels ? undefined : 'Сумма, ₽'}
                  aria-invalid={errors.amount ? true : undefined}
                  aria-describedby={errors.amount ? `${amountId}-error` : undefined}
                  onChange={event => entries.change(draft.key, { amount: event.target.value })}
                />
                {!readOnly && (
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`Удалить удержание${rowLabel ? `: ${rowLabel}` : ''}`}
                    onClick={() => entries.remove(draft.key)}
                  >
                    <X size={18} aria-hidden="true" />
                  </button>
                )}
              </div>
              {errors.amount && <p id={`${amountId}-error`} className={fields.error}>{errors.amount}</p>}
            </div>
          </div>
        );
      })}

      {!readOnly && (
        <button type="button" className={styles.add} disabled={!entries.ready} onClick={addRow}>
          Добавить удержание
        </button>
      )}
    </div>
  );
};
