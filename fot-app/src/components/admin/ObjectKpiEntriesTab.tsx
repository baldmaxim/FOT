import type { FC, ReactNode } from 'react';

import { formatDate, formatMoney, formatMonthLabel } from '../../utils/formatMoney';
import { formatMoneyInput, toMoneyInput } from '../../utils/moneyInput';
import styles from './ObjectKpiCardModal.module.css';

/**
 * Таблица записей карточки (допсоглашения, КС-2, КС-6) с правкой черновиков по месту.
 *
 * Подписанное и аннулированное не редактируется — это правило жизненного цикла из
 * object-kpi.service.ts, и здесь оно выражено тем, что инпуты появляются только у draft.
 * Сами правки живут в состоянии модалки: их сохраняет общая кнопка «Сохранить» в футере.
 */

export interface IEntryColumn {
  /** Имя поля в payload запроса; для readonly-колонок может быть любым уникальным. */
  key: string;
  label: string;
  kind: 'text' | 'date' | 'month' | 'money' | 'readonly';
  /** Только для money: минус разрешён допсоглашениям, у КС-2 и КС-6 знака нет. */
  allowNegative?: boolean;
  /**
   * Правится и у ПОДПИСАННОЙ записи. Ставится ровно тем колонкам, которые разрешает
   * сервер (у КС-2 это месяц, сумма и примечание): расхождение дало бы форму, ввод из
   * которой отвергается с signed_field_locked.
   */
  editableWhenSigned?: boolean;
  /**
   * Второе поле в той же ячейке — комментарий под суммой. Отдельной колонкой он бы
   * оторвался от того, что поясняет, и растянул таблицу.
   */
  secondary?: {
    key: string;
    placeholder: string;
    editableWhenSigned?: boolean;
  };
  /** Отображение для readonly-колонок и для нередактируемых строк. */
  render?: (row: IEntryRow) => ReactNode;
  placeholder?: string;
}

export interface IEntryRow {
  id: string;
  status: 'draft' | 'signed' | 'cancelled';
  version: number;
  [key: string]: unknown;
}

interface IProps {
  columns: IEntryColumn[];
  rows: IEntryRow[];
  emptyText: string;
  canEdit: boolean;
  /** Правки черновиков: id записи → изменённые поля в том виде, как их видит человек. */
  edits: Record<string, Record<string, string>>;
  onEditChange: (id: string, key: string, value: string) => void;
  onSign: (row: IEntryRow) => void;
  onCancel: (row: IEntryRow) => void;
  addForm?: ReactNode;
}

const STATUS_LABELS: Record<IEntryRow['status'], string> = {
  draft: 'черновик',
  signed: 'подписан',
  cancelled: 'аннулирован',
};

const displayValue = (column: IEntryColumn, row: IEntryRow): ReactNode => {
  if (column.render) return column.render(row);
  const raw = row[column.key];
  if (raw === null || raw === undefined || raw === '') return '—';
  if (column.kind === 'money') return formatMoney(String(raw));
  if (column.kind === 'date') return formatDate(String(raw));
  if (column.kind === 'month') return formatMonthLabel(String(raw));
  return String(raw);
};

const editValue = (
  column: IEntryColumn,
  row: IEntryRow,
  edits: Record<string, Record<string, string>>,
): string => {
  const edited = edits[row.id]?.[column.key];
  if (edited !== undefined) return edited;
  const raw = row[column.key];
  if (raw === null || raw === undefined) return '';
  if (column.kind === 'money') return toMoneyInput(String(raw));
  // input[type=month] понимает только YYYY-MM, а из БД приходит YYYY-MM-01.
  if (column.kind === 'month') return String(raw).slice(0, 7);
  return String(raw);
};

const INPUT_TYPES: Record<IEntryColumn['kind'], string> = {
  text: 'text',
  date: 'date',
  month: 'month',
  money: 'text',
  readonly: 'text',
};

/**
 * Ширина поля задаётся типом колонки, а не «100 % ячейки»: тянущийся инпут строки-черновика
 * забирал под номер акта четверть таблицы, и месяц с суммой уезжали вправо.
 */
const INPUT_CLASSES: Record<IEntryColumn['kind'], string> = {
  text: styles.cellInputText,
  date: styles.cellInputDate,
  month: styles.cellInputMonth,
  money: styles.cellInputMoney,
  readonly: styles.cellInputText,
};

export const ObjectKpiEntriesTab: FC<IProps> = ({
  columns,
  rows,
  emptyText,
  canEdit,
  edits,
  onEditChange,
  onSign,
  onCancel,
  addForm,
}) => (
  <>
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map(column => <th key={column.key}>{column.label}</th>)}
            <th>Статус</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            // Аннулированная запись не правится вовсе; у подписанной — только колонки
            // с editableWhenSigned (правило жизненного цикла из object-kpi.service.ts).
            const editable = canEdit && row.status !== 'cancelled';
            return (
              <tr key={row.id}>
                {columns.map(column => {
                  const cellEditable = editable && column.kind !== 'readonly'
                    && (row.status === 'draft' || column.editableWhenSigned);
                  const secondary = column.secondary;
                  const secondaryEditable = secondary !== undefined && editable
                    && (row.status === 'draft' || secondary.editableWhenSigned);
                  const secondaryValue = secondary
                    ? (edits[row.id]?.[secondary.key] ?? String(row[secondary.key] ?? ''))
                    : '';
                  return (
                    <td key={column.key}>
                      {/* Обёртка — <div>: display:flex прямо на <td> выбивает ячейку из
                          табличного потока, и две соседние такие ячейки браузер сливает
                          в одну. */}
                      <div className={styles.cellStack}>
                        {cellEditable ? (
                          <input
                            className={`${styles.cellInput} ${INPUT_CLASSES[column.kind]}`}
                            type={INPUT_TYPES[column.kind]}
                            inputMode={column.kind === 'money' ? 'decimal' : undefined}
                            value={editValue(column, row, edits)}
                            placeholder={column.placeholder}
                            onChange={(event) => onEditChange(
                              row.id,
                              column.key,
                              column.kind === 'money'
                                ? formatMoneyInput(event.target.value, {
                                  allowNegative: column.allowNegative,
                                })
                                : event.target.value,
                            )}
                          />
                        ) : displayValue(column, row)}

                        {secondary && (secondaryEditable ? (
                          <input
                            className={`${styles.cellInput} ${styles.cellInputNote}`}
                            type="text"
                            value={secondaryValue}
                            placeholder={secondary.placeholder}
                            aria-label={secondary.placeholder}
                            onChange={(event) => onEditChange(
                              row.id, secondary.key, event.target.value,
                            )}
                          />
                        ) : secondaryValue && (
                          <span className={styles.cellNote}>{secondaryValue}</span>
                        ))}
                      </div>
                    </td>
                  );
                })}
                <td>{STATUS_LABELS[row.status]}</td>
                <td className={styles.actions}>
                  {canEdit && row.status === 'draft' && (
                    <button type="button" onClick={() => onSign(row)}>Подписать</button>
                  )}
                  {canEdit && row.status === 'signed' && (
                    <button type="button" onClick={() => onCancel(row)}>Аннулировать</button>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + 2} className={styles.empty}>{emptyText}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>

    {addForm}
  </>
);
