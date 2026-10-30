import { useId, useState, type FC, type ReactNode } from 'react';

import type { IPayrollDictionaryPayload } from '../../utils/payrollDictionary';
import { PayrollDictionaryForm } from './PayrollDictionaryForm';
import { PayrollDictionaryRow, type IPayrollDictionaryItem } from './PayrollDictionaryRow';
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
  /** Ставки с историей значений (миграция 324): «с какого месяца» в правке, первый — текущий. */
  monthOptions?: ReadonlyArray<{ value: string; label: string }>;
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
  /** Передан — у каждой строки «+», раскрывающий под ней этот блок (подвиды вида удержания, миграция 321). */
  renderDetails?: (item: IPayrollDictionaryItem) => ReactNode;
  /** Подпись «+» для диктора: «Подвиды: Спецодежда». */
  detailsLabel?: (name: string) => string;
  /** Надпись у пустого списка, по умолчанию «Список пуст»; null — без надписи (подвиды вида). */
  emptyText?: string | null;
}

/**
 * Колонка окна «Справочник»: список записей с правкой на месте и поле новой записи внизу. Таблицы сотрудников
 * открываются кнопками в шапке «Справочника».
 */
export const PayrollDictionarySection: FC<IPayrollDictionarySectionProps> = ({
  title,
  showTitle = true,
  items,
  isError,
  onRetry,
  nameLabel,
  amountLabel,
  monthOptions,
  addLabel,
  canEdit,
  deleteQuestion,
  onAdd,
  onUpdate,
  onDelete,
  isLocked,
  renderDetails,
  detailsLabel = name => name,
  emptyText = 'Список пуст',
}) => {
  const titleId = useId();
  // Правится одна строка: открытие другой закрывает прежнюю без сохранения.
  const [editingId, setEditingId] = useState<number | null>(null);
  // Раскрытых строк может быть несколько.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(() => new Set());
  const toggleExpanded = (id: number) => setExpandedIds(prev => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  return (
    <section
      className={styles.section}
      aria-labelledby={showTitle ? titleId : undefined}
      aria-label={showTitle ? undefined : title}
    >
      {showTitle && <h3 id={titleId} className={styles.sectionTitle}>{title}</h3>}

      {!items && !isError && <p className={styles.state}>Загрузка…</p>}
      {!items && isError && (
        <p className={`${styles.state} ${styles.stateError}`}>
          Не удалось загрузить
          <button type="button" className={styles.retryButton} onClick={onRetry}>Повторить</button>
        </p>
      )}
      {items && items.length === 0 && emptyText && <p className={styles.state}>{emptyText}</p>}

      {items && items.length > 0 && (
        <ul className={styles.list}>
          {items.map(item => (
            <PayrollDictionaryRow
              key={item.id}
              item={item}
              nameLabel={nameLabel}
              amountLabel={amountLabel}
              monthOptions={monthOptions}
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
              details={renderDetails && {
                // Свёрнутый блок не строится: подвиды рисуются только у раскрытых строк.
                content: expandedIds.has(item.id) ? renderDetails(item) : null,
                expanded: expandedIds.has(item.id),
                onToggle: () => toggleExpanded(item.id),
                label: detailsLabel(item.name),
              }}
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
