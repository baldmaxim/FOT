import { useRef, useState, type FC, type KeyboardEvent } from 'react';

import { formatMoneyInput, parseMoneyInput, toMoneyInput } from '../../utils/moneyInput';
import { ClearableInput } from '../ui/ClearableInput';

interface ITimesheetSalaryOutputInputProps {
  /** Сохранённая выработка строкой NUMERIC; null — не внесена. */
  value: string | null;
  canEdit: boolean;
  saving: boolean;
  /** Подпись для экранного диктора: «Выработка, ЖК Wave». */
  label: string;
  /** Сумму можно только стереть (на объекте больше нет часов бригады). */
  clearOnly?: boolean;
  onSave: (amount: number | null) => Promise<void>;
}

/**
 * «Выработка, ₽» объекта бригады: черновик живёт, пока поле в фокусе; сохраняется по уходу из поля и Enter,
 * Escape — выйти без сохранения.
 */
export const TimesheetSalaryOutputInput: FC<ITimesheetSalaryOutputInputProps> = ({
  value, canEdit, saving, label, clearOnly = false, onSave,
}) => {
  const savedValue = toMoneyInput(value);
  // Вне фокуса — сохранённое (смена месяца, ответ сервера).
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? savedValue;
  // Escape — blur приходит в том же обработчике, до перерисовки.
  const cancelRef = useRef(false);

  const commit = async (): Promise<void> => {
    const parsed = parseMoneyInput(shown);
    const next = parsed === null ? null : Number(parsed);
    const current = value === null ? null : Number(value);
    const forbidden = clearOnly && next !== null;
    if (cancelRef.current || forbidden || (next !== null && !Number.isFinite(next)) || next === current) {
      cancelRef.current = false;
      setDraft(null);
      return;
    }
    try {
      // Черновик держим до ответа: иначе поле на миг покажет прежнюю сумму.
      await onSave(next);
    } catch {
      // Тост об ошибке показал хук; в поле вернётся сохранённое значение.
    } finally {
      setDraft(null);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      cancelRef.current = true;
      event.currentTarget.blur();
    }
  };

  if (!canEdit) return <span className="ts-salary-output-value">{savedValue || '—'}</span>;
  return (
    <ClearableInput
      className="ts-salary-output-input"
      value={shown}
      // Сумму на объекте без часов можно только стереть: принимается лишь очистка.
      onValueChange={next => { if (!clearOnly || next === '') setDraft(formatMoneyInput(next)); }}
      // Крестик у поля без фокуса сначала очищает, потом ставит фокус — очищенное не затираем.
      onFocus={() => setDraft(current => current ?? savedValue)}
      onBlur={() => { void commit(); }}
      onKeyDown={handleKeyDown}
      inputMode="decimal"
      autoComplete="off"
      disabled={saving}
      aria-label={label}
      clearLabel={`Очистить: ${label}`}
    />
  );
};
