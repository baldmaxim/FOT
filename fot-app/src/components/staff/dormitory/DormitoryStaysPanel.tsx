import { useMemo, useState, type FC } from 'react';
import { Download, UserPlus } from 'lucide-react';

import { useDormitoryExport } from '../../../hooks/useDormitoryExport';
import type { IDormitoryStay } from '../../../services/dormitoryService';
import { DORMITORY_COLUMNS, matchesDormitorySearch } from '../../../utils/dormitoryTable';
import { applyTableView, type ITableView } from '../../../utils/tableView';
import { SearchInput } from '../../ui/SearchInput';
import { DormitoryStaysTable } from './DormitoryStaysTable';
import styles from './DormitoryStaysPanel.module.css';

const INITIAL_VIEW: ITableView = { sort: 'full_name', dir: 'asc', filters: {} };

interface IDormitoryStaysPanelProps {
  /** undefined — ещё не загружены. */
  rows: IDormitoryStay[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Переданы — «Добавить сотрудника», ✎ и 🗑 (право «Редактирование»). */
  onAdd?: () => void;
  onEdit?: (stay: IDormitoryStay) => void;
  onDelete?: (stay: IDormitoryStay) => void;
  busyId?: number | null;
  /** Таблица в модальном окне: фильтр столбца — над окном. */
  raisedFilters?: boolean;
  onFilterOpenChange?: (open: boolean) => void;
}

/**
 * Таблица «Общежитие» с панелью — вкладка «Управления кадрами» и окно «Справочника» «Зарплаты»:
 * поиск по ФИО, «Экспорт» ровно видимых строк, при праве правки — «Добавить сотрудника».
 */
export const DormitoryStaysPanel: FC<IDormitoryStaysPanelProps> = ({
  rows, isLoading, isError, onRetry, onAdd, onEdit, onDelete, busyId = null, raisedFilters = false, onFilterOpenChange,
}) => {
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ITableView>(INITIAL_VIEW);
  const { exporting, exportRows } = useDormitoryExport();

  const searchedRows = useMemo(() => (rows ?? []).filter(stay => matchesDormitorySearch(stay, search)), [rows, search]);
  const visibleRows = useMemo(() => applyTableView(searchedRows, DORMITORY_COLUMNS, view), [searchedRows, view]);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput clearable value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." />
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonSecondary}`}
            // Выгружается ровно видимая таблица: поиск, фильтры и сортировка столбцов.
            onClick={() => { void exportRows(visibleRows); }}
            disabled={exporting || isLoading || visibleRows.length === 0}
          >
            <Download size={14} aria-hidden="true" />
            <span>{exporting ? 'Готовим…' : 'Экспорт'}</span>
          </button>
          {onAdd && (
            <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={onAdd}>
              <UserPlus size={14} aria-hidden="true" />
              <span>Добавить сотрудника</span>
            </button>
          )}
        </div>
      </div>

      {isError && !rows ? (
        <p className={styles.state}>
          Не удалось загрузить
          <button type="button" className={styles.retry} onClick={onRetry}>Повторить</button>
        </p>
      ) : (
        <DormitoryStaysTable
          rows={searchedRows}
          visibleRows={visibleRows}
          view={view}
          onViewChange={setView}
          loading={isLoading}
          onEdit={onEdit}
          onDelete={onDelete}
          busyId={busyId}
          raisedFilters={raisedFilters}
          onFilterOpenChange={onFilterOpenChange}
        />
      )}
    </div>
  );
};
