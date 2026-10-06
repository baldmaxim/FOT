import { useId, useState, type FC, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { useToast } from '../../contexts/ToastContext';
import { PAYROLL_DEDUCTION_KINDS_KEY } from '../../hooks/usePayrollDeductionKinds';
import { payrollService } from '../../services/payrollService';
import { ModalShell } from '../ui/ModalShell';
import shared from './PayrollModal.module.css';
import styles from './AddDeductionKindModal.module.css';

interface IAddDeductionKindModalProps {
  onClose: () => void;
}

/**
 * Добавление вида удержания в справочник «Расчётов». Новый вид сразу становится столбцом
 * таблицы и пунктом «Вида» в карточке. Такой уже есть — ошибка под полем, окно открыто.
 */
export const AddDeductionKindModal: FC<IAddDeductionKindModalProps> = ({ onClose }) => {
  const titleId = useId();
  const inputId = useId();
  const { success } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: (value: string) => payrollService.addDeductionKind(value),
    onSuccess: kind => {
      void queryClient.invalidateQueries({ queryKey: PAYROLL_DEDUCTION_KINDS_KEY });
      success(`Вид удержания добавлен: ${kind.name}`);
      onClose();
    },
    onError: (err: Error) => setError(err.message || 'Не удалось добавить вид'),
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (addMutation.isPending) return;
    const value = name.replace(/\s+/g, ' ').trim();
    if (!value) {
      setError('Введите название вида');
      document.getElementById(inputId)?.focus();
      return;
    }
    addMutation.mutate(value);
  };

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={shared.overlay}
      containerClassName={styles.container}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <form className={shared.form} onSubmit={handleSubmit} noValidate>
          <header className={shared.header}>
            <div className={shared.headerText}>
              <h2 id={titleId} className={shared.title}>Новый вид удержания</h2>
            </div>
            <button type="button" className={shared.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={shared.body}>
            <div className={styles.field}>
              <label htmlFor={inputId} className={styles.label}>Название</label>
              <input
                id={inputId}
                className={styles.control}
                value={name}
                maxLength={100}
                autoComplete="off"
                autoFocus
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${inputId}-error` : undefined}
                onChange={event => {
                  setName(event.target.value);
                  setError(null);
                }}
              />
              {error && <p id={`${inputId}-error`} className={styles.error} role="alert">{error}</p>}
            </div>
          </div>

          <footer className={shared.footer}>
            <div className={shared.actions}>
              <button type="button" className={shared.secondaryButton} onClick={requestClose}>
                Отмена
              </button>
              <button type="submit" className={shared.primaryButton} disabled={addMutation.isPending}>
                {addMutation.isPending ? 'Сохранение…' : 'Добавить'}
              </button>
            </div>
          </footer>
        </form>
      )}
    </ModalShell>
  );
};
