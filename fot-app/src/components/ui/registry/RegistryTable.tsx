import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { Pencil, Trash2 } from 'lucide-react';

import { ColumnValuesFilterPopover } from '../ColumnValuesFilterPopover';
import { TableSortHeader } from '../TableSortHeader';
import {
  columnFilterOptions,
  isColumnFiltered,
  setColumnFilter,
  toggleSort,
  type IRegistryColumn,
  type ITableView,
} from '../../../utils/tableView';
import styles from './RegistryTable.module.css';

/** Ширины, которые таблица держит до горизонтальной прокрутки: «№», ФИО не уже 170px, действия. */
const NUM_WIDTH = 48;
const NAME_MIN_WIDTH = 170;
const ACTIONS_WIDTH = 84;
/** На телефоне кнопки 44px — колонка действий шире. */
const ACTIONS_WIDTH_TOUCH = 116;

export interface IRegistryTableProps<Row> {
  columns: ReadonlyArray<IRegistryColumn<Row>>;
  /** Все строки — из них считаются варианты фильтров. */
  rows: ReadonlyArray<Row>;
  /** Строки после поиска, фильтров и сортировки — ровно они же уходят в экспорт. */
  visibleRows: ReadonlyArray<Row>;
  view: ITableView;
  onViewChange: (view: ITableView) => void;
  loading: boolean;
  /** Подпись таблицы для экранного диктора: «Общежитие». */
  label: string;
  rowKey: (row: Row) => string | number;
  /** Кто в строке — для подписей ✎ / 🗑: «Изменить: Каримов Акмал». */
  rowLabel: (row: Row) => string;
  /** Переданы — столбец ✎ / 🗑 (право «Редактирование»). */
  onEdit?: (row: Row) => void;
  onDelete?: (row: Row) => void;
  /** Подпись 🗑: «Удалить» (по умолчанию), «Снять». */
  deleteLabel?: string;
  /** Можно ли править строку (охват сотрудника); не передано — все. */
  canEditRow?: (row: Row) => boolean;
  /** Строка, которую удаляют: её кнопки неактивны. */
  busyKey?: string | number | null;
  /** Таблица в модальном окне: фильтр столбца — над окном. */
  raisedFilters?: boolean;
  /** Открыт ли фильтр столбца: окно вокруг таблицы на это время не закрывается по Escape. */
  onFilterOpenChange?: (open: boolean) => void;
}

/**
 * Таблица-реестр в стиле «Управления кадрами» (общежитие, таблицы «Справочника» «Зарплаты»): «№», у
 * каждого столбца — сортировка и фильтр по значениям; при праве правки — ✎ и 🗑 справа. Строк десятки–
 * сотни, без виртуализации: таблица скроллится по горизонтали внутри своего блока, страница — нет.
 */
export const RegistryTable = <Row,>({
  columns, rows, visibleRows, view, onViewChange, loading, label, rowKey, rowLabel,
  onEdit, onDelete, deleteLabel = 'Удалить', canEditRow, busyKey = null, raisedFilters = false, onFilterOpenChange,
}: IRegistryTableProps<Row>): ReactElement => {
  const [filterFor, setFilterFor] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const filterColumn = filterFor ? columns.find(column => column.key === filterFor.key) ?? null : null;
  const filterOptions = useMemo(
    () => (filterFor ? columnFilterOptions(rows, columns, view.filters, filterFor.key) : []),
    [filterFor, rows, columns, view.filters],
  );
  const withActions = onEdit !== undefined || onDelete !== undefined;
  const columnCount = columns.length + (withActions ? 2 : 1);

  // Минимальная ширина: сумма колонок с шириной + ФИО не уже 170px — уже неё скроллится таблица.
  const tableStyle = useMemo((): CSSProperties => {
    const fixed = NUM_WIDTH + NAME_MIN_WIDTH + columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
    return {
      '--registry-min-width': `${fixed + (withActions ? ACTIONS_WIDTH : 0)}px`,
      '--registry-min-width-touch': `${fixed + (withActions ? ACTIONS_WIDTH_TOUCH : 0)}px`,
    } as CSSProperties;
  }, [columns, withActions]);

  const filterOpen = filterFor !== null;
  useEffect(() => {
    onFilterOpenChange?.(filterOpen);
  }, [filterOpen, onFilterOpenChange]);

  return (
    <div className={styles.wrap}>
      <table className={styles.table} style={tableStyle} aria-label={label}>
        <colgroup>
          <col className={styles.colNum} />
          {columns.map(column => (
            <col key={column.key} style={column.width ? { width: `${column.width}px` } : undefined} />
          ))}
          {withActions && <col className={styles.colActions} />}
        </colgroup>
        <thead>
          <tr>
            <th className={styles.cellNum}>№</th>
            {columns.map(column => (
              <TableSortHeader
                key={column.key}
                sortKey={column.key}
                label={column.label}
                title={column.title}
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
          {!loading && visibleRows.map((row, index) => {
            const key = rowKey(row);
            const editable = canEditRow ? canEditRow(row) : true;
            return (
              // Чередование — по индексу видимой строки: после фильтра полосы не «слипаются».
              <tr key={key} className={index % 2 === 1 ? styles.rowEven : undefined}>
                <td className={styles.cellNum}>{index + 1}</td>
                {columns.map(column => (
                  column.nowrap ? (
                    <td key={column.key} className={column.numeric ? `${styles.cellValue} ${styles.cellNumeric}` : styles.cellValue}>
                      {column.text(row)}
                    </td>
                  ) : (
                    <td key={column.key} className={styles.cellText}>
                      <span className={styles.clamp2}>{column.text(row)}</span>
                    </td>
                  )
                ))}
                {withActions && (
                  <td className={styles.cellActions}>
                    {editable && (
                      <span className={styles.actions}>
                        {onEdit && (
                          <button
                            type="button"
                            className={styles.iconBtn}
                            title="Изменить"
                            aria-label={`Изменить: ${rowLabel(row)}`}
                            onClick={() => onEdit(row)}
                            disabled={busyKey === key}
                          >
                            <Pencil size={14} aria-hidden="true" />
                          </button>
                        )}
                        {onDelete && (
                          <button
                            type="button"
                            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                            title={deleteLabel}
                            aria-label={`${deleteLabel}: ${rowLabel(row)}`}
                            onClick={() => onDelete(row)}
                            disabled={busyKey === key}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
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
