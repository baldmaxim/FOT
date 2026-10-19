import { useMemo, useState, type ReactElement } from 'react';
import { Download, UserPlus } from 'lucide-react';

import { useSnapshotExport } from '../../../hooks/useSnapshotExport';
import { applyTableView, matchesNameSearch, type ITableExportSnapshot, type ITableView } from '../../../utils/tableView';
import { SearchInput } from '../SearchInput';
import { RegistryTable, type IRegistryTableProps } from './RegistryTable';
import styles from './RegistryPanel.module.css';

const DEFAULT_VIEW: ITableView = { sort: 'full_name', dir: 'asc', filters: {} };

interface IRegistryPanelProps<Row> extends Omit<IRegistryTableProps<Row>, 'rows' | 'visibleRows' | 'view' | 'onViewChange' | 'loading'> {
  /** undefined — ещё не загружены. */
  rows: Row[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** ФИО строки — по нему поиск над таблицей. */
  searchText: (row: Row) => string | null;
  /** Снимок xlsx видимых строк и его отправка на сервер. */
  buildExport: (rows: ReadonlyArray<Row>) => ITableExportSnapshot;
  sendExport: (snapshot: ITableExportSnapshot) => Promise<{ blob: Blob; filename: string }>;
  /** Передан — «Добавить сотрудника» (право «Редактирование»). */
  onAdd?: () => void;
  /** Начальная сортировка; по умолчанию — ФИО по возрастанию. */
  initialView?: ITableView;
}

/**
 * Таблица-реестр с панелью: поиск по ФИО, «Экспорт» ровно видимых строк, при праве правки —
 * «Добавить сотрудника»; ошибка загрузки — с «Повторить». «Общежитие» и таблицы «Справочника» «Зарплаты».
 */
export const RegistryPanel = <Row,>({
  rows, isLoading, isError, onRetry, searchText, buildExport, sendExport, onAdd, initialView = DEFAULT_VIEW,
  ...tableProps
}: IRegistryPanelProps<Row>): ReactElement => {
  const { columns } = tableProps;
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ITableView>(initialView);
  const { exporting, exportRows } = useSnapshotExport(buildExport, sendExport);

  const searchedRows = useMemo(
    () => (rows ?? []).filter(row => matchesNameSearch(searchText(row), search)),
    [rows, search, searchText],
  );
  const visibleRows = useMemo(() => applyTableView(searchedRows, columns, view), [searchedRows, columns, view]);

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
        <RegistryTable
          {...tableProps}
          rows={searchedRows}
          visibleRows={visibleRows}
          view={view}
          onViewChange={setView}
          loading={isLoading}
        />
      )}
    </div>
  );
};
