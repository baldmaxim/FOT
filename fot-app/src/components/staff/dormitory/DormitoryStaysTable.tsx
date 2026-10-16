import { useEffect, useMemo, useState, type FC } from 'react';
import { Pencil, Trash2 } from 'lucide-react';

import { ColumnValuesFilterPopover } from '../../ui/ColumnValuesFilterPopover';
import { TableSortHeader } from '../../ui/TableSortHeader';
import type { IDormitoryStay } from '../../../services/dormitoryService';
import { DORMITORY_COLUMNS } from '../../../utils/dormitoryTable';
import {
  columnFilterOptions,
  isColumnFiltered,
  setColumnFilter,
  toggleSort,
  type ITableView,
} from '../../../utils/tableView';
import styles from './DormitoryStaysTable.module.css';

interface IDormitoryStaysTableProps {
  /** Все строки — из них считаются варианты фильтров. */
  rows: ReadonlyArray<IDormitoryStay>;
  /** Строки после поиска, фильтров и сортировки — ровно они же уходят в экспорт. */
  visibleRows: ReadonlyArray<IDormitoryStay>;
  view: ITableView;
  onViewChange: (view: ITableView) => void;
  loading: boolean;
  /** Переданы — столбец ✎ / 🗑 (право «Редактирование»). */
  onEdit?: (stay: IDormitoryStay) => void;
  onDelete?: (stay: IDormitoryStay) => void;
  /** Строка, которую удаляют: её кнопки неактивны. */
  busyId?: number | null;
  /** Таблица в модальном окне: фильтр столбца — над окном. */
  raisedFilters?: boolean;
  /** Открыт ли фильтр столбца: окно вокруг таблицы на это время не закрывается по Escape. */
  onFilterOpenChange?: (open: boolean) => void;
}

const COLUMNS = DORMITORY_COLUMNS;
/** Даты — одной строкой; ФИО, отдел, должность и адрес переносятся до двух строк. */
const DATE_KEYS = new Set(['check_in', 'check_out']);

/**
 * Таблица «Общежитие» в стиле «Управления кадрами»: «№», у каждого столбца — сортировка и фильтр
 * по значениям; при праве правки — ✎ и 🗑 справа.
 */
export const DormitoryStaysTable: FC<IDormitoryStaysTableProps> = ({
  rows, visibleRows, view, onViewChange, loading, onEdit, onDelete, busyId = null,
  raisedFilters = false, onFilterOpenChange,
}) => {
  const [filterFor, setFilterFor] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const filterColumn = filterFor ? COLUMNS.find(column => column.key === filterFor.key) ?? null : null;
  const filterOptions = useMemo(
    () => (filterFor ? columnFilterOptions(rows, COLUMNS, view.filters, filterFor.key) : []),
    [filterFor, rows, view.filters],
  );
  const withActions = onEdit !== undefined || onDelete !== undefined;
  const columnCount = COLUMNS.length + (withActions ? 2 : 1);

  const filterOpen = filterFor !== null;
  useEffect(() => {
    onFilterOpenChange?.(filterOpen);
  }, [filterOpen, onFilterOpenChange]);

  return (
    <div className={styles.wrap}>
      <table className={styles.table} aria-label="Общежитие">
        <colgroup>
          <col className={styles.colNum} />
          {COLUMNS.map(column => <col key={column.key} className={styles[column.width]} />)}
          {withActions && <col className={styles.colActions} />}
        </colgroup>
        <thead>
          <tr>
            <th className={styles.cellNum}>№</th>
            {COLUMNS.map(column => (
              <TableSortHeader
                key={column.key}
                sortKey={column.key}
                label={column.label}
                activeKey={view.sort}
                dir={view.dir}
                onSort={key => onViewChange(toggleSort(view, key))}
                onOpenFilter={(key, anchor) => setFilterFor({ key, anchor })}
                filterActive={isColumnFiltered(view, column.key)}
              />
            ))}
            {withActions && <th aria-label="Действия" />}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={columnCount} className={styles.empty}>Загрузка…</td></tr>
          )}
          {!loading && visibleRows.length === 0 && (
            <tr>
              <td colSpan={columnCount} className={styles.empty}>
                {/* Строки есть, но скрыты поиском или фильтрами — это не «нет данных». */}
                {rows.length > 0 ? 'Ничего не найдено' : 'Список пуст'}
              </td>
            </tr>
          )}
          {!loading && visibleRows.map((stay, index) => (
            // Чередование — по индексу видимой строки: после фильтра полосы не «слипаются».
            <tr key={stay.id} className={index % 2 === 1 ? styles.rowEven : undefined}>
              <td className={styles.cellNum}>{index + 1}</td>
              {COLUMNS.map(column => (
                DATE_KEYS.has(column.key) ? (
                  <td key={column.key} className={styles.cellValue}>{column.text(stay)}</td>
                ) : (
                  <td key={column.key} className={styles.cellText}>
                    <span className={styles.clamp2}>{column.text(stay)}</span>
                  </td>
                )
              ))}
              {withActions && (
                <td className={styles.cellActions}>
                  <span className={styles.actions}>
                    {onEdit && (
                      <button
                        type="button"
                        className={styles.iconBtn}
                        title="Изменить"
                        aria-label={`Изменить: ${stay.full_name}`}
                        onClick={() => onEdit(stay)}
                        disabled={busyId === stay.id}
                      >
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        title="Удалить"
                        aria-label={`Удалить: ${stay.full_name}`}
                        onClick={() => onDelete(stay)}
                        disabled={busyId === stay.id}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {filterFor && filterColumn && (
        <ColumnValuesFilterPopover
          label={filterColumn.label}
          options={filterOptions}
          selected={view.filters[filterColumn.key] ?? []}
          anchor={filterFor.anchor}
          onApply={values => onViewChange(setColumnFilter(view, filterColumn.key, values))}
          onClose={() => setFilterFor(null)}
          raised={raisedFilters}
        />
      )}
    </div>
  );
};
