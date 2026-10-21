import { useId, useState, type FC } from 'react';

import type { IPayrollDictionaryPayload } from '../../utils/payrollDictionary';
import { PayrollDictionaryForm } from './PayrollDictionaryForm';
import { PayrollDictionaryRow, type IPayrollDictionaryItem } from './PayrollDictionaryRow';
import { PayrollEmployeesButton } from './PayrollEmployeesButton';
import styles from './PayrollDictionary.module.css';

interface IPayrollDictionarySectionProps {
  title: string;
  /** false — заголовка на экране нет (его даёт окно: «Виды удержаний» кадров), title — подпись для диктора. */
  showTitle?: boolean;
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
  /** Кнопки таблиц сотрудников рядом с заголовком: у «Удержаний» — одна, у «Ставок» — по таблице на ставку. */
  lists?: ReadonlyArray<IPayrollDictionaryList>;
}

/** Кнопка таблицы сотрудников у заголовка колонки. */
export interface IPayrollDictionaryList {
  /** Подпись на кнопке: «Сотрудники», «Проживание», «Общежитие». */
  label: string;
  /** Что за таблица — для экранного диктора: «Сотрудники с удержаниями». */
  ariaLabel: string;
  onOpen: () => void;
}

/**
 * Колонка окна «Справочник»: список записей с правкой на месте и поле новой записи внизу; у «Удержаний» и
 * «Ставок» рядом с заголовком кнопки таблиц сотрудников.
 */
export const PayrollDictionarySection: FC<IPayrollDictionarySectionProps> = ({
  title,
  showTitle = true,
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
  lists,
}) => {
  const titleId = useId();
  // Правится одна строка: открытие другой закрывает прежнюю без сохранения.
  const [editingId, setEditingId] = useState<number | null>(null);

  return (
    <section
      className={styles.section}
      aria-labelledby={showTitle ? titleId : undefined}
      aria-label={showTitle ? undefined : title}
    >
      {showTitle && (lists && lists.length > 0 ? (
        <div className={styles.sectionHead}>
          <h3 id={titleId} className={styles.sectionTitle}>{title}</h3>
          {lists.map(list => (
            <PayrollEmployeesButton key={list.label} label={list.label} onClick={list.onOpen} ariaLabel={list.ariaLabel} />
          ))}
        </div>
      ) : (
        <h3 id={titleId} className={styles.sectionTitle}>{title}</h3>
      ))}

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
