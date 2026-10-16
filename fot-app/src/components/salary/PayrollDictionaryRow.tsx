import { useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { Pencil, Trash2 } from 'lucide-react';

import { rateAmountInputValue, type IPayrollDictionaryPayload } from '../../utils/payrollDictionary';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import { PayrollDictionaryForm } from './PayrollDictionaryForm';
import styles from './PayrollDictionary.module.css';

/** Запись справочника: вид удержания (без значения) или ставка. */
export interface IPayrollDictionaryItem {
  id: number;
  name: string;
  amount?: string | number | null;
  /** Ставка, привязанная к функционалу (миграция 313: dormitory). */
  code?: string | null;
}

interface IPayrollDictionaryRowProps {
  item: IPayrollDictionaryItem;
  nameLabel: string;
  /** Подпись значения (ставки). Не передана — у записи значения нет. */
  amountLabel?: string;
  canEdit: boolean;
  /** Привязана к функционалу: правится только значение, удалить нельзя (сервер стережёт тоже). */
  locked: boolean;
  /** Своя кнопка записи — перед «Изменить»; видна и без права правки. */
  extraAction?: ReactNode;
  isEditing: boolean;
  /** Вопрос перед удалением: «Удалить ставку «Сварщик»?». */
  deleteQuestion: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (payload: IPayrollDictionaryPayload) => Promise<void>;
  /** Отклонённый промис — причина отказа (вид отмечен у сотрудников): показывается под строкой. */
  onDelete: () => Promise<void>;
}

/** Строка справочника «Расчётов»: просмотр с кнопками «Изменить» / «Удалить» или правка на месте. */
export const PayrollDictionaryRow: FC<IPayrollDictionaryRowProps> = ({
  item,
  nameLabel,
  amountLabel,
  canEdit,
  locked,
  extraAction,
  isEditing,
  deleteQuestion,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
}) => {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Выход из правки (сохранили или отменили) возвращает фокус на «Изменить» — клавиатура не теряет место.
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(isEditing);
  useEffect(() => {
    if (wasEditingRef.current && !isEditing) editButtonRef.current?.focus();
    wasEditingRef.current = isEditing;
  }, [isEditing]);

  const handleDelete = async () => {
    if (deleting || !window.confirm(deleteQuestion)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
    } catch (err) {
      setDeleteError(err instanceof Error && err.message ? err.message : 'Не удалось удалить');
      setDeleting(false);
    }
  };

  if (isEditing) {
    return (
      <li className={styles.row}>
        <PayrollDictionaryForm
          mode="edit"
          nameLabel={nameLabel}
          amountLabel={amountLabel}
          initialName={item.name}
          fixedName={locked}
          initialAmount={rateAmountInputValue(item.amount)}
          onSubmit={onSave}
          onCancel={onCancelEdit}
        />
      </li>
    );
  }

  return (
    <li className={styles.row}>
      <span className={styles.rowName}>{item.name}</span>
      {amountLabel !== undefined && (
        <span className={styles.rowAmount}>{formatPayrollMoney(item.amount) ?? '—'}</span>
      )}
      {(canEdit || extraAction) && (
        <span className={styles.rowActions}>
          {extraAction}
          {canEdit && (
            <button
              ref={editButtonRef}
              type="button"
              className={styles.iconButton}
              disabled={deleting}
              onClick={() => {
                setDeleteError(null);
                onStartEdit();
              }}
              aria-label={`Изменить: ${item.name}`}
            >
              <Pencil size={16} aria-hidden="true" />
            </button>
          )}
          {canEdit && !locked && (
            <button
              type="button"
              className={`${styles.iconButton} ${styles.iconButtonDanger}`}
              disabled={deleting}
              onClick={() => { void handleDelete(); }}
              aria-label={`Удалить: ${item.name}`}
            >
              <Trash2 size={16} aria-hidden="true" />
            </button>
          )}
        </span>
      )}
      {deleteError && <p className={styles.error} role="alert">{deleteError}</p>}
    </li>
  );
};
