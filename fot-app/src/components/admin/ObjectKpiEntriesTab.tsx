import type { FC, ReactNode } from 'react';

import { formatDate, formatMoney } from '../../utils/formatMoney';
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
  kind: 'text' | 'date' | 'money' | 'readonly';
  /** Только для money: минус разрешён допсоглашениям, у КС-2 и КС-6 знака нет. */
  allowNegative?: boolean;
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
  return column.kind === 'money' ? toMoneyInput(String(raw)) : String(raw);
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
            const editable = canEdit && row.status === 'draft';
            return (
              <tr key={row.id}>
                {columns.map(column => (
                  <td key={column.key}>
                    {editable && column.kind !== 'readonly' ? (
                      <input
                        className={styles.cellInput}
                        type={column.kind === 'date' ? 'date' : 'text'}
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
                  </td>
                ))}
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
