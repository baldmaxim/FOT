import { useMemo, useState, type FC } from 'react';
import { Pencil, Trash2 } from 'lucide-react';

import { ColumnValuesFilterPopover } from '../ui/ColumnValuesFilterPopover';
import { TableSortHeader } from '../ui/TableSortHeader';
import type { IWorkSchedule } from '../../types/schedule';
import { SCHEDULE_TEMPLATE_COLUMNS } from '../../utils/scheduleTemplatesTable';
import {
  columnFilterOptions,
  isColumnFiltered,
  setColumnFilter,
  toggleSort,
  type ITableView,
} from '../../utils/tableView';
import styles from './ScheduleTemplatesTable.module.css';

interface IScheduleTemplatesTableProps {
  /** Все шаблоны — из них считаются варианты фильтров. */
  rows: ReadonlyArray<IWorkSchedule>;
  /** Шаблоны после фильтров и сортировки — ровно они же уходят в экспорт. */
  visibleRows: ReadonlyArray<IWorkSchedule>;
  view: ITableView;
  onViewChange: (view: ITableView) => void;
  onEdit: (template: IWorkSchedule) => void;
  onDelete: (template: IWorkSchedule) => void;
  loading: boolean;
}

const COLUMNS = SCHEDULE_TEMPLATE_COLUMNS;

/**
 * Таблица «Шаблоны графиков» в стиле «Управления кадрами»: «№», у каждого столбца —
 * сортировка и фильтр по значениям, действия иконками справа.
 */
export const ScheduleTemplatesTable: FC<IScheduleTemplatesTableProps> = ({
  rows, visibleRows, view, onViewChange, onEdit, onDelete, loading,
}) => {
  const [filterFor, setFilterFor] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const filterColumn = filterFor ? COLUMNS.find(column => column.key === filterFor.key) ?? null : null;
  const filterOptions = useMemo(
    () => (filterFor ? columnFilterOptions(rows, COLUMNS, view.filters, filterFor.key) : []),
    [filterFor, rows, view.filters],
  );
  const columnCount = COLUMNS.length + 2;

  return (
    <div className={styles.wrap}>
      <table className={styles.table} aria-label="Шаблоны графиков">
        <colgroup>
          <col className={styles.colNum} />
          {COLUMNS.map(column => <col key={column.key} className={styles[column.width]} />)}
          <col className={styles.colActions} />
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
            <th aria-label="Действия" />
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={columnCount} className={styles.empty}>Загрузка…</td></tr>
          )}
          {!loading && visibleRows.length === 0 && (
            <tr>
              <td colSpan={columnCount} className={styles.empty}>
                {/* Шаблоны есть, но все скрыты фильтрами столбцов — это не «нет данных». */}
                {rows.length > 0 ? 'Ничего не найдено' : 'Шаблонов пока нет'}
              </td>
            </tr>
          )}
          {!loading && visibleRows.map((template, index) => (
            // Чередование — по индексу видимой строки: после фильтра полосы не «слипаются».
            <tr key={template.id} className={index % 2 === 1 ? styles.rowEven : undefined}>
              <td className={styles.cellNum}>{index + 1}</td>
              {COLUMNS.map(column => (
                column.key === 'name' ? (
                  <td key={column.key} className={styles.cellText}>
                    <span className={styles.nameCell}>
                      <span className={styles.clamp2}>{column.text(template)}</span>
                      {template.is_default && <span className={`${styles.badge} ${styles.badgeDefault}`}>дефолт</span>}
                      {template.pattern_type !== 'cycle' && (
                        <span className={styles.badge} title="Старый формат — будет переписан в N/M при сохранении">legacy</span>
                      )}
                    </span>
                  </td>
                ) : (
                  <td key={column.key} className={styles.cellValue}>{column.text(template)}</td>
                )
              ))}
              <td className={styles.cellActions}>
                <span className={styles.actions}>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    title="Редактировать"
                    aria-label={`Редактировать: ${template.name}`}
                    onClick={() => onEdit(template)}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                    title="Удалить"
                    aria-label={`Удалить: ${template.name}`}
                    onClick={() => onDelete(template)}
                    disabled={template.is_default}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </span>
              </td>
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
        />
      )}
    </div>
  );
};
