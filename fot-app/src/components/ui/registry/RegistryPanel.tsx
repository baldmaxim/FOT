import { useMemo, useState, type ReactElement } from 'react';
import { Download, UserPlus } from 'lucide-react';

import { useSnapshotExport } from '../../../hooks/useSnapshotExport';
import { applyTableView, matchesNameSearch, type ITableExportSnapshot, type ITableView } from '../../../utils/tableView';
import { MonthsPicker } from '../MonthsPicker';
import { SearchInput } from '../SearchInput';
import { RegistryTable, type IRegistryTableProps } from './RegistryTable';
import styles from './RegistryPanel.module.css';

const DEFAULT_VIEW: ITableView = { sort: 'full_name', dir: 'asc', filters: {} };

/** Итог видимых строк: текст в строке «Итого» таблицы и значения той же строки в xlsx (ключ — столбец). */
export interface IRegistryTotals {
  display: Readonly<Record<string, string>>;
  export: Readonly<Record<string, string | number | null>>;
}

/** Выбор месяцев рядом с «Экспортом»; пусто — «Весь период». */
export interface IRegistryMonths {
  value: string[];
  options: string[];
  onChange: (months: string[]) => void;
}

interface IRegistryPanelProps<Row> extends Omit<IRegistryTableProps<Row>, 'rows' | 'visibleRows' | 'view' | 'onViewChange' | 'loading' | 'footer'> {
  /** undefined — ещё не загружены. */
  rows: Row[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** ФИО строки (или другое имя — см. searchPlaceholder) — по нему поиск над таблицей. */
  searchText: (row: Row) => string | null;
  searchPlaceholder?: string;
  /** Снимок xlsx видимых строк (с итогом, если он есть) и его отправка на сервер. */
  buildExport: (rows: ReadonlyArray<Row>, totals?: IRegistryTotals['export']) => ITableExportSnapshot;
  sendExport: (snapshot: ITableExportSnapshot) => Promise<{ blob: Blob; filename: string }>;
  /** Передан — «Добавить сотрудника» (право «Редактирование»). */
  onAdd?: () => void;
  /** Начальная сортировка; по умолчанию — ФИО по возрастанию. */
  initialView?: ITableView;
  /** Передан — выбор месяцев перед «Экспортом», той же высоты. */
  months?: IRegistryMonths;
  /** Передан — строка «Итого» из видимых строк (после поиска и фильтров): и на экране, и в xlsx. */
  totals?: (rows: ReadonlyArray<Row>) => IRegistryTotals | null;
}

/**
 * Таблица-реестр с панелью: поиск по ФИО, выбор месяцев, «Экспорт» ровно видимых строк, при праве правки —
 * «Добавить сотрудника»; ошибка загрузки — с «Повторить». «Общежитие», таблицы «Справочника» и «Свод» «Зарплаты».
 */
export const RegistryPanel = <Row,>({
  rows, isLoading, isError, onRetry, searchText, searchPlaceholder = 'Поиск по ФИО...', buildExport, sendExport, onAdd,
  initialView = DEFAULT_VIEW, months, totals, ...tableProps
}: IRegistryPanelProps<Row>): ReactElement => {
  const { columns } = tableProps;
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ITableView>(initialView);
  // Итог считается из тех же строк, что уходят в снимок, — экран и xlsx не расходятся.
  const buildSnapshot = (exported: ReadonlyArray<Row>) => buildExport(exported, totals?.(exported)?.export);
  const { exporting, exportRows } = useSnapshotExport(buildSnapshot, sendExport);

  const searchedRows = useMemo(
    () => (rows ?? []).filter(row => matchesNameSearch(searchText(row), search)),
    [rows, search, searchText],
  );
  const visibleRows = useMemo(() => applyTableView(searchedRows, columns, view), [searchedRows, columns, view]);
  const footer = useMemo(() => totals?.(visibleRows)?.display ?? null, [totals, visibleRows]);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput clearable value={search} onValueChange={setSearch} placeholder={searchPlaceholder} />
        </div>
        <div className={styles.actions}>
          {months && (
            <MonthsPicker
              value={months.value}
              options={months.options}
              onChange={months.onChange}
              ariaLabel="Месяцы таблицы"
              className={styles.monthsButton}
            />
          )}
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
          footer={footer}
        />
      )}
    </div>
  );
};
