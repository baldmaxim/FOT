import { useId, useState, type FC, type ReactNode } from 'react';

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
  /** Что такое запись: «Вид удержания», «Ставка» — подпись полей правки. */
  nameLabel: string;
  /** Подпись значения. Передана — у записей есть значение (ставки). */
  amountLabel?: string;
  /** Подсказка в поле новой записи: «Новый вид удержания». */
  addLabel?: string;
  canEdit: boolean;
  deleteQuestion: (name: string) => string;
  /** Не передан — поля новой записи нет (ставки заводятся миграцией). */
  onAdd?: (payload: IPayrollDictionaryPayload) => Promise<void>;
  onUpdate: (id: number, payload: IPayrollDictionaryPayload) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** Запись, привязанная к функционалу: название не меняется, удалить нельзя. */
  isLocked?: (item: IPayrollDictionaryItem) => boolean;
  /** Своя кнопка записи — перед «Изменить» (у «Проживания общежития» — таблица проживающих). */
  renderExtraAction?: (item: IPayrollDictionaryItem) => ReactNode;
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
  isLocked,
  renderExtraAction,
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
        <ul className={styles.list}>
          {items.map(item => (
            <PayrollDictionaryRow
              key={item.id}
              item={item}
              nameLabel={nameLabel}
              amountLabel={amountLabel}
              canEdit={canEdit}
              locked={isLocked?.(item) ?? false}
              extraAction={renderExtraAction?.(item)}
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
      )}

      {canEdit && items && onAdd && addLabel && (
        <PayrollDictionaryForm mode="add" nameLabel={addLabel} amountLabel={amountLabel} onSubmit={onAdd} />
      )}
    </section>
  );
};
