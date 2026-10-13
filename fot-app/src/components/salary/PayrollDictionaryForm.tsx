import { useId, useState, type FC, type FormEvent, type KeyboardEvent } from 'react';
import { Check, X } from 'lucide-react';

import {
  normalizeDictionaryName,
  parseRateAmount,
  type IPayrollDictionaryPayload,
} from '../../utils/payrollDictionary';
import { ClearableInput } from '../ui/ClearableInput';
import styles from './PayrollDictionary.module.css';

interface IPayrollDictionaryFormProps {
  /** Добавление — поля очищаются после сохранения; правка строки — «Сохранить» и «Отменить». */
  mode: 'add' | 'edit';
  /** Что вводят в поле названия: подпись для экранного диктора, в добавлении — и подсказка в поле. */
  nameLabel: string;
  /** Подпись поля значения (ставки). Не передана — поля значения нет. */
  amountLabel?: string;
  initialName?: string;
  initialAmount?: string;
  /** Отклонённый промис — ошибка сохранения: её текст показывается под полями, ввод не теряется. */
  onSubmit: (payload: IPayrollDictionaryPayload) => Promise<void>;
  /** Правка: Escape и «Отменить». */
  onCancel?: () => void;
}

const MAX_NAME_LENGTH = 100;

/** Поля записи справочника «Расчётов»: название и, у ставок, значение. */
export const PayrollDictionaryForm: FC<IPayrollDictionaryFormProps> = ({
  mode,
  nameLabel,
  amountLabel,
  initialName = '',
  initialAmount = '',
  onSubmit,
  onCancel,
}) => {
  const nameId = useId();
  const amountId = useId();
  const errorId = useId();
  const [name, setName] = useState(initialName);
  const [amount, setAmount] = useState(initialAmount);
  const [error, setError] = useState<{ field: 'name' | 'amount' | null; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const withAmount = amountLabel !== undefined;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const cleanName = normalizeDictionaryName(name);
    if (!cleanName) {
      document.getElementById(nameId)?.focus();
      return;
    }
    const parsed = withAmount ? parseRateAmount(amount) : { amount: null, error: null };
    if (parsed.error !== null) {
      setError({ field: 'amount', message: parsed.error });
      document.getElementById(amountId)?.focus();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit({ name: cleanName, amount: parsed.amount });
      if (mode === 'add') {
        setName('');
        setAmount('');
        document.getElementById(nameId)?.focus();
      }
    } catch (err) {
      setError({ field: null, message: err instanceof Error && err.message ? err.message : 'Не удалось сохранить' });
    } finally {
      setPending(false);
    }
  };

  /** Escape отменяет правку строки и не доходит до окна — оно закрылось бы целиком. */
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !onCancel) return;
    event.stopPropagation();
    onCancel();
  };

  const describedBy = error ? errorId : undefined;

  return (
    <form
      className={[styles.form, withAmount ? styles.formWithAmount : '', mode === 'add' ? styles.formAdd : '']
        .filter(Boolean).join(' ')}
      onSubmit={event => { void handleSubmit(event); }}
      onKeyDown={handleKeyDown}
      noValidate
    >
      <ClearableInput
        id={nameId}
        className={styles.formName}
        value={name}
        onValueChange={value => {
          setName(value);
          setError(null);
        }}
        maxLength={MAX_NAME_LENGTH}
        autoComplete="off"
        autoFocus={mode === 'edit'}
        placeholder={mode === 'add' ? nameLabel : undefined}
        aria-label={nameLabel}
        aria-invalid={error && error.field !== 'amount' ? true : undefined}
        aria-describedby={describedBy}
        clearLabel="Очистить название"
      />
      {withAmount && (
        <ClearableInput
          id={amountId}
          className={styles.formAmount}
          value={amount}
          onValueChange={value => {
            setAmount(value);
            setError(null);
          }}
          inputMode="decimal"
          autoComplete="off"
          placeholder={amountLabel}
          aria-label={amountLabel}
          aria-invalid={error?.field === 'amount' ? true : undefined}
          aria-describedby={describedBy}
          clearLabel="Очистить значение"
        />
      )}
      {mode === 'add' ? (
        <button type="submit" className={styles.addButton} disabled={!name.trim() || pending}>
          {pending ? '…' : 'Добавить'}
        </button>
      ) : (
        <span className={styles.rowActions}>
          <button type="submit" className={styles.iconButton} disabled={!name.trim() || pending} aria-label="Сохранить">
            <Check size={18} aria-hidden="true" />
          </button>
          <button type="button" className={styles.iconButton} disabled={pending} onClick={onCancel} aria-label="Отменить">
            <X size={18} aria-hidden="true" />
          </button>
        </span>
      )}
      {error && <p id={errorId} className={styles.error} role="alert">{error.message}</p>}
    </form>
  );
};
