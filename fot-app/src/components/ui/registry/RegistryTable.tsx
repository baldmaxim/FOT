import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react';
import { Pencil, Trash2 } from 'lucide-react';

import { ColumnValuesFilterPopover } from '../ColumnValuesFilterPopover';
import { TableSortHeader } from '../TableSortHeader';
import {
  columnFilterOptions,
  fitRegistryColumnWidths,
  isColumnFiltered,
  REGISTRY_ACTIONS_WIDTH,
  REGISTRY_ACTIONS_WIDTH_TOUCH,
  REGISTRY_NAME_MIN_WIDTH,
  REGISTRY_NUM_WIDTH,
  setColumnFilter,
  toggleSort,
  type IRegistryColumn,
  type ITableView,
} from '../../../utils/tableView';
import styles from './RegistryTable.module.css';

/** Подпись заголовка: 12px, 600, ПРОПИСНЫЕ, letter-spacing 0.04em (RegistryTable.module.css). */
const HEADER_FONT = '600 12px';
const HEADER_LETTER_SPACING = 0.48;
/** Текст ячейки: 13px, обычный (.table). */
const CELL_FONT = '400 13px';
/** Запас на расхождение замера canvas и вёрстки. */
const HEADER_MEASURE_SLACK = 4;
const TOUCH_QUERY = '(max-width: 768px)';

export interface IRegistryTableProps<Row> {
  columns: ReadonlyArray<IRegistryColumn<Row>>;
  /** Все строки — из них считаются варианты фильтров. */
  rows: ReadonlyArray<Row>;
  /** Строки для ширин столбцов по тексту; не переданы — rows. Панель даёт строки до поиска: ширины не прыгают. */
  sizeRows?: ReadonlyArray<Row>;
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
  /** Передан — строка кликабельна (и Enter / пробел с клавиатуры): «Свод» → сотрудники объекта. */
  onRowClick?: (row: Row) => void;
  /** Строка итогов под таблицей: текст по ключу столбца (первый столбец — «Итого»). */
  footer?: Readonly<Record<string, string>> | null;
}

/**
 * Таблица-реестр в стиле «Управления кадрами» (общежитие, таблицы «Справочника» «Зарплаты»): «№», у
 * каждого столбца — сортировка и фильтр по значениям; при праве правки — ✎ и 🗑 справа. Строк десятки–
 * сотни, без виртуализации: таблица скроллится по горизонтали внутри своего блока, страница — нет. На широком
 * экране подписи столбцов — в одну строку (fitRegistryColumnWidths).
 */
export const RegistryTable = <Row,>({
  columns, rows, sizeRows = rows, visibleRows, view, onViewChange, loading, label, rowKey, rowLabel,
  onEdit, onDelete, deleteLabel = 'Удалить', canEditRow, busyKey = null, raisedFilters = false, onFilterOpenChange,
  onRowClick, footer = null,
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
    const fixed = REGISTRY_NUM_WIDTH + REGISTRY_NAME_MIN_WIDTH + columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
    return {
      '--registry-min-width': `${fixed + (withActions ? REGISTRY_ACTIONS_WIDTH : 0)}px`,
      '--registry-min-width-touch': `${fixed + (withActions ? REGISTRY_ACTIONS_WIDTH_TOUCH : 0)}px`,
    } as CSSProperties;
  }, [columns, withActions]);

  // Широкий экран: столбцы с переносящейся подписью расширяются, пока есть запас, — подпись в одну строку;
  // остаток делится между ФИО, отделом, должностью и другими текстовыми столбцами по их тексту, а не весь у ФИО.
  // Пока не замерили (первый кадр) — компактные ширины, как в описании столбцов.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [fitted, setFitted] = useState<Array<number | undefined> | null>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    const context = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (!wrap || !context || typeof ResizeObserver === 'undefined') return undefined;
    const touch = window.matchMedia(TOUCH_QUERY);
    // Текст ячеек замеряется один раз (и заново после загрузки шрифта), не на каждый ресайз.
    let contentWidths: number[] | null = null;
    const measure = () => {
      const fontFamily = getComputedStyle(wrap).fontFamily;
      if (!contentWidths) {
        context.font = `${CELL_FONT} ${fontFamily}`;
        contentWidths = columns.map(column => (column.nowrap ? 0 : sizeRows.reduce(
          (max, row) => Math.max(max, context.measureText(column.text(row)).width),
          0,
        )));
      }
      context.font = `${HEADER_FONT} ${fontFamily}`;
      const next = fitRegistryColumnWidths({
        columns,
        containerWidth: wrap.clientWidth,
        labelWidth: label => context.measureText(label.toLocaleUpperCase('ru')).width
          + HEADER_LETTER_SPACING * label.length + HEADER_MEASURE_SLACK,
        actionsWidth: withActions ? (touch.matches ? REGISTRY_ACTIONS_WIDTH_TOUCH : REGISTRY_ACTIONS_WIDTH) : 0,
        contentWidths,
      });
      setFitted(prev => (prev && prev.length === next.length && prev.every((width, index) => width === next[index]) ? prev : next));
    };
    // Первый вызов — сразу при observe; шрифт мог догрузиться позже — пересчёт после него.
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (!alive) return;
      contentWidths = null;
      measure();
    });
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [columns, sizeRows, withActions]);
  const columnWidth = (index: number): number | undefined => (fitted ? fitted[index] : columns[index].width);

  const filterOpen = filterFor !== null;
  useEffect(() => {
    onFilterOpenChange?.(filterOpen);
  }, [filterOpen, onFilterOpenChange]);

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <table className={styles.table} style={tableStyle} aria-label={label}>
        <colgroup>
          <col className={styles.colNum} />
          {columns.map((column, index) => {
            const width = columnWidth(index);
            return <col key={column.key} style={width ? { width: `${width}px` } : undefined} />;
          })}
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
                // Подпись числового столбца — над числами, по правому краю.
                className={column.numeric ? styles.headNumeric : undefined}
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
              <tr
                key={key}
                className={[index % 2 === 1 ? styles.rowEven : '', onRowClick ? styles.rowClickable : ''].filter(Boolean).join(' ') || undefined}
                {...(onRowClick ? {
                  tabIndex: 0,
                  onClick: () => onRowClick(row),
                  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    onRowClick(row);
                  },
                } : {})}
              >
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
        {footer && !loading && visibleRows.length > 0 && (
          <tfoot>
            <tr>
              <td className={styles.cellNum} />
              {columns.map(column => (
                <td
                  key={column.key}
                  className={column.numeric ? `${styles.cellValue} ${styles.cellNumeric}` : styles.cellValue}
                >
                  {footer[column.key] ?? ''}
                </td>
              ))}
              {withActions && <td />}
            </tr>
          </tfoot>
        )}
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
