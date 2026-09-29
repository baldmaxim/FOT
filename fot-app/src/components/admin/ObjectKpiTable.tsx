import { useMemo, useState, type ReactElement, type ReactNode } from 'react';

import { ColumnValuesFilterPopover } from '../ui/ColumnValuesFilterPopover';
import { TableSortHeader } from '../ui/TableSortHeader';
import {
  columnFilterOptions,
  isColumnFiltered,
  setColumnFilter,
  toggleSort,
  type IKpiColumn,
  type IKpiTableView,
} from '../../utils/objectKpiTable';
import styles from './ObjectKpiTable.module.css';

interface IObjectKpiTableProps<Row> {
  ariaLabel: string;
  /** Все строки — из них считаются варианты фильтров. */
  rows: ReadonlyArray<Row>;
  /** Строки после фильтров и сортировки — ровно они же уходят в экспорт. */
  visibleRows: ReadonlyArray<Row>;
  columns: ReadonlyArray<IKpiColumn<Row>>;
  view: IKpiTableView;
  onViewChange: (view: IKpiTableView) => void;
  rowKey: (row: Row) => string;
  rowLabel: (row: Row) => string;
  onRowClick: (row: Row) => void;
  /** Текущий месяц — фоном, прогноз — приглушённым цветом. */
  rowTone?: (row: Row) => 'current' | 'forecast' | undefined;
  /** Своя ячейка (подсказка премии, пометка ручного плана); undefined — текст столбца. */
  renderCell?: (column: IKpiColumn<Row>, row: Row) => ReactNode | undefined;
  loading: boolean;
  emptyText: string;
}

const TONE_CLASS = { current: styles.rowCurrent, forecast: styles.rowForecast } as const;

/**
 * Таблица вкладки «KPI объектов» в стиле «Управления кадрами»: «№», у каждого столбца —
 * сортировка и фильтр по значениям. Состояние сортировки и фильтров держит страница: при
 * переходе «объект ↔ все объекты» оно не сбрасывается.
 */
export const ObjectKpiTable = <Row,>({
  ariaLabel,
  rows,
  visibleRows,
  columns,
  view,
  onViewChange,
  rowKey,
  rowLabel,
  onRowClick,
  rowTone,
  renderCell,
  loading,
  emptyText,
}: IObjectKpiTableProps<Row>): ReactElement => {
  const [filterFor, setFilterFor] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const filterColumn = filterFor ? columns.find(column => column.key === filterFor.key) ?? null : null;
  const filterOptions = useMemo(
    () => (filterFor ? columnFilterOptions(rows, columns, view.filters, filterFor.key) : []),
    [filterFor, rows, columns, view.filters],
  );
  const columnCount = columns.length + 1;

  return (
    <div className={styles.wrap}>
      <table className={styles.table} aria-label={ariaLabel}>
        <colgroup>
          <col className={styles.colNum} />
          {columns.map(column => <col key={column.key} className={styles[column.width]} />)}
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
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={columnCount} className={styles.empty}>Загрузка…</td></tr>
          )}
          {!loading && visibleRows.length === 0 && (
            <tr>
              <td colSpan={columnCount} className={styles.empty}>
                {/* Строки есть, но все скрыты фильтрами столбцов — это не «нет данных». */}
                {rows.length > 0 ? 'Ничего не найдено' : emptyText}
              </td>
            </tr>
          )}
          {!loading && visibleRows.map((row, index) => {
            const tone = rowTone?.(row);
            // Чередование — по индексу видимой строки: после фильтра полосы не «слипаются».
            const className = [
              styles.rowClickable,
              index % 2 === 1 ? styles.rowEven : '',
              tone ? TONE_CLASS[tone] : '',
            ].filter(Boolean).join(' ');
            return (
              <tr
                key={rowKey(row)}
                className={className}
                tabIndex={0}
                aria-label={rowLabel(row)}
                onClick={() => onRowClick(row)}
                onKeyDown={event => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onRowClick(row);
                  }
                }}
              >
                <td className={styles.cellNum}>{index + 1}</td>
                {columns.map(column => (
                  <td key={column.key} className={column.type === 'text' ? styles.cellText : styles.cellNumber}>
                    {renderCell?.(column, row) ?? (column.type === 'text'
                      ? <span className={styles.clamp2}>{column.text(row)}</span>
                      : column.text(row))}
                  </td>
                ))}
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
        />
      )}
    </div>
  );
};
