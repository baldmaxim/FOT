import { useId, useState, type FC, type ReactNode } from 'react';
import { Users } from 'lucide-react';

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
  /** Своя кнопка записи — перед «Изменить» (у «Доплаты за проживание» — таблица доплат). */
  renderExtraAction?: (item: IPayrollDictionaryItem) => ReactNode;
  /** Название записи — кнопка (у «Доплаты за проживание» — та же таблица); null — обычный текст. */
  getItemOpener?: (item: IPayrollDictionaryItem) => (() => void) | null;
  /** Передан — заголовок раздела кнопкой и 👥 рядом: таблица сотрудников («Удержания»). */
  onOpenList?: () => void;
  /** Подпись кнопки таблицы для экранного диктора: «Сотрудники с удержаниями». */
  listLabel?: string;
}

/**
 * Колонка окна «Справочник»: список записей с правкой на месте и поле новой записи внизу; у «Удержаний»
 * заголовок открывает таблицу сотрудников.
 */
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
  getItemOpener,
  onOpenList,
  listLabel,
}) => {
  const titleId = useId();
  // Правится одна строка: открытие другой закрывает прежнюю без сохранения.
  const [editingId, setEditingId] = useState<number | null>(null);

  return (
    <section className={styles.section} aria-labelledby={titleId}>
      {onOpenList ? (
        <h3 id={titleId} className={styles.sectionTitle}>
          <button
            type="button"
            className={styles.sectionTitleButton}
            onClick={onOpenList}
            title={listLabel}
            aria-label={listLabel ? `${title}: ${listLabel.toLowerCase()}` : undefined}
          >
            <span>{title}</span>
            <Users size={16} aria-hidden="true" />
          </button>
        </h3>
      ) : (
        <h3 id={titleId} className={styles.sectionTitle}>{title}</h3>
      )}

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
              onOpen={getItemOpener?.(item) ?? undefined}
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
