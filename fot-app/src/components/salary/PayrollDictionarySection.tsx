import { useId, useState, type FC } from 'react';

import type { IPayrollDictionaryPayload } from '../../utils/payrollDictionary';
import { PayrollDictionaryForm } from './PayrollDictionaryForm';
import { PayrollDictionaryRow, type IPayrollDictionaryItem } from './PayrollDictionaryRow';
import styles from './PayrollDictionary.module.css';

interface IPayrollDictionarySectionProps {
  title: string;
  /** Записи в порядке списка; undefined — ещё не загружены. */
  items: readonly IPayrollDictionaryItem[] | undefined;
  isError: boolean;
  onRetry: () => void;
  /** Что такое запись: «Вид удержания», «Ставка» — подпись полей и шапка столбца у ставок. */
  nameLabel: string;
  /** Подпись значения. Передана — у записей есть значение (ставки). */
  amountLabel?: string;
  /** Подсказка в поле новой записи: «Новая ставка». */
  addLabel: string;
  canEdit: boolean;
  deleteQuestion: (name: string) => string;
  onAdd: (payload: IPayrollDictionaryPayload) => Promise<void>;
  onUpdate: (id: number, payload: IPayrollDictionaryPayload) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

/** Колонка окна «Справочник»: список записей с правкой на месте и поле новой записи внизу. */
export const PayrollDictionarySection: FC<IPayrollDictionarySectionProps> = ({
  title,
  items,
  isError,
  onRetry,
  nameLabel,
  amountLabel,
  addLabel,
  canEdit,
  deleteQuestion,
  onAdd,
  onUpdate,
  onDelete,
}) => {
  const titleId = useId();
  // Правится одна строка: открытие другой закрывает прежнюю без сохранения.
  const [editingId, setEditingId] = useState<number | null>(null);

  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.sectionTitle}>{title}</h3>

      {!items && !isError && <p className={styles.state}>Загрузка…</p>}
      {!items && isError && (
        <p className={`${styles.state} ${styles.stateError}`}>
          Не удалось загрузить
          <button type="button" className={styles.retryButton} onClick={onRetry}>Повторить</button>
        </p>
      )}
      {items && items.length === 0 && <p className={styles.state}>Список пуст</p>}

      {items && items.length > 0 && (
        <>
          {amountLabel !== undefined && (
            <div className={styles.listHead} aria-hidden="true">
              <span className={styles.rowName}>{nameLabel}</span>
              <span className={styles.rowAmount}>{amountLabel}</span>
              {canEdit && <span className={styles.actionsSpacer} />}
            </div>
          )}
          <ul className={styles.list}>
            {items.map(item => (
              <PayrollDictionaryRow
                key={item.id}
                item={item}
                nameLabel={nameLabel}
                amountLabel={amountLabel}
                canEdit={canEdit}
                isEditing={editingId === item.id}
                deleteQuestion={deleteQuestion(item.name)}
                onStartEdit={() => setEditingId(item.id)}
                onCancelEdit={() => setEditingId(null)}
                onSave={async payload => {
                  await onUpdate(item.id, payload);
                  setEditingId(null);
                }}
                onDelete={() => onDelete(item.id)}
              />
            ))}
          </ul>
        </>
      )}

      {canEdit && items && (
        <PayrollDictionaryForm mode="add" nameLabel={addLabel} amountLabel={amountLabel} onSubmit={onAdd} />
      )}
    </section>
  );
};
