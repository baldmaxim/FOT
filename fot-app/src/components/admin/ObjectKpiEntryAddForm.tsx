import type { FC } from 'react';

import { formatMoneyInput, parseMoneyInput } from '../../utils/moneyInput';
import styles from './ObjectKpiCardModal.module.css';

/**
 * Строка добавления записи: допсоглашение или КС-2.
 *
 * У КС-2 вводится МЕСЯЦ, а не дата подписания: расчётный месяц в БД — производная от даты
 * (period_month GENERATED), и человек, вводя «15.02.2026», не видел, куда попадёт запись.
 * Дату подписания выводит сервер (последний день месяца, для текущего — сегодня).
 *
 * Номера у КС-2 в форме нет: сервер берёт следующий порядковый по договору.
 */

interface IProps {
  kind: 'addenda' | 'ks2';
  /** Текущий месяц по МСК: акт будущего месяца сервер отклоняет. */
  maxMonth: string;
  pending: boolean;
  onSubmit: (payload: Record<string, unknown>) => void;
}

export const ObjectKpiEntryAddForm: FC<IProps> = ({ kind, maxMonth, pending, onSubmit }) => (
  <form
    className={styles.inlineForm}
    onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const amount = parseMoneyInput(String(form.get('amount') ?? ''));

      if (kind === 'addenda') {
        const date = String(form.get('date') ?? '');
        onSubmit({
          addendum_number: String(form.get('number') ?? '').trim(),
          addendum_date: date,
          // Отдельного «действует с» в форме нет: дата ДС и есть дата вступления в силу.
          effective_date: date,
          amount_delta: amount,
        });
      } else {
        onSubmit({
          entry_kind: form.get('entry_kind'),
          period_month: form.get('period_month'),
          // Сумма всегда положительная: знак уменьшения ставит бэкенд по entry_kind.
          amount,
        });
      }
      event.currentTarget.reset();
    }}
  >
    {kind === 'ks2' && (
      <select name="entry_kind" defaultValue="act">
        <option value="act">КС-2</option>
        <option value="reduction">Уменьшение объёма</option>
      </select>
    )}
    {kind === 'addenda'
      ? (
        <>
          <input name="number" placeholder="Номер ДС" required />
          <input type="date" name="date" required />
        </>
      )
      : <input type="month" name="period_month" max={maxMonth} required aria-label="Месяц акта" />}
    <input
      name="amount"
      inputMode="decimal"
      placeholder={kind === 'addenda' ? 'Сумма (± ₽)' : 'Сумма, ₽'}
      required
      onChange={(event) => {
        event.target.value = formatMoneyInput(event.target.value, {
          allowNegative: kind === 'addenda',
        });
      }}
    />
    <button type="submit" className={styles.primaryBtn} disabled={pending}>
      Добавить
    </button>
  </form>
);
