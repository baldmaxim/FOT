import { useEffect, useId, useRef, useState, type FC, type ReactNode } from 'react';
import { Minus, Pencil, Plus, Trash2 } from 'lucide-react';

import type { IPayrollRateValue } from '../../services/payrollService';
import { rateAmountInputValue, type IPayrollDictionaryPayload } from '../../utils/payrollDictionary';
import { formatPayrollMoney } from '../../utils/payrollFormat';
import { nextRateValue, rateFromLabel } from '../../utils/payrollRates';
import { PayrollDictionaryForm } from './PayrollDictionaryForm';
import styles from './PayrollDictionary.module.css';

/** Запись справочника: вид удержания (без значения) или ставка. */
export interface IPayrollDictionaryItem {
  id: number;
  name: string;
  amount?: string | number | null;
  /** Ставка, привязанная к функционалу (миграция 315: housing — «Доплата за проживание»). */
  code?: string | null;
  /** История значений ставки по месяцам (миграция 324). */
  values?: IPayrollRateValue[];
}

interface IPayrollDictionaryRowProps {
  item: IPayrollDictionaryItem;
  nameLabel: string;
  /** Подпись значения (ставки). Не передана — у записи значения нет. */
  amountLabel?: string;
  /** Единица значения за числом: «₽/день» у ставок проживания (миграция 339); нет — без единицы. */
  amountUnit?: string | null;
  /**
   * Ставки с историей: месяцы «с какого» для правки (первый — текущий). У ставки ещё без значения выбора нет —
   * первое значение действует «с начала». Под строкой — запланированное значение.
   */
  monthOptions?: ReadonlyArray<{ value: string; label: string }>;
  canEdit: boolean;
  /** Привязана к функционалу: правится только значение, удалить нельзя (сервер стережёт тоже). */
  locked: boolean;
  isEditing: boolean;
  /** Вопрос перед удалением: «Удалить ставку «Сварщик»?». */
  deleteQuestion: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (payload: IPayrollDictionaryPayload) => Promise<void>;
  /** Отклонённый промис — причина отказа (вид отмечен у сотрудников): показывается под строкой. */
  onDelete: () => Promise<void>;
  /**
   * Блок под строкой (подвиды вида): передан — у строки «+», раскрывающий его; кнопка есть и без права правки.
   */
  details?: {
    content: ReactNode;
    expanded: boolean;
    onToggle: () => void;
    /** Для диктора: «Подвиды: Спецодежда». */
    label: string;
  };
}

/** Строка справочника «Расчётов»: просмотр с кнопками «Изменить» / «Удалить» или правка на месте. */
export const PayrollDictionaryRow: FC<IPayrollDictionaryRowProps> = ({
  item,
  nameLabel,
  amountLabel,
  amountUnit = null,
  monthOptions,
  canEdit,
  locked,
  isEditing,
  deleteQuestion,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
  details,
}) => {
  const detailsId = useId();
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

  // Раскрытый блок остаётся и на время правки строки: подвиды не прячутся, пока переименовывают вид.
  // Пустой (показывать нечего) — не рисуется: иначе осталась бы пустая полоса с линией слева.
  const detailsBlock = details?.expanded && details.content ? (
    <div id={detailsId} className={styles.rowDetails}>{details.content}</div>
  ) : null;

  const currentMonth = monthOptions?.[0]?.value;
  const scheduled = currentMonth && item.values ? nextRateValue(item.values, currentMonth) : null;

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
          monthOptions={item.values && item.values.length > 0 ? monthOptions : undefined}
          onSubmit={onSave}
          onCancel={onCancelEdit}
        />
        {detailsBlock}
      </li>
    );
  }

  return (
    <li className={styles.row}>
      <span className={styles.rowName}>{item.name}</span>
      {amountLabel !== undefined && (
        <span className={styles.rowAmount}>
          {formatPayrollMoney(item.amount) ?? '—'}
          {amountUnit && item.amount !== null && item.amount !== undefined ? ` ${amountUnit}` : ''}
        </span>
      )}
      {(canEdit || details) && (
        <span className={styles.rowActions}>
          {details && (
            <button
              type="button"
              className={`${styles.iconButton} ${details.expanded ? styles.iconButtonActive : ''}`}
              onClick={details.onToggle}
              aria-expanded={details.expanded}
              aria-controls={details.expanded ? detailsId : undefined}
              aria-label={details.label}
            >
              {details.expanded ? <Minus size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
            </button>
          )}
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
      {scheduled && (
        <span className={styles.rowNote}>
          {rateFromLabel(scheduled.effective_from)} — {formatPayrollMoney(scheduled.amount) ?? 'не задано'}
        </span>
      )}
      {deleteError && <p className={styles.error} role="alert">{deleteError}</p>}
      {detailsBlock}
    </li>
  );
};
