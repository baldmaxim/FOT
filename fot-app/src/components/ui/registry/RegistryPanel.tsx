import { useCallback, useMemo, type ReactElement, type ReactNode } from 'react';
import { Download, UserPlus, type LucideIcon } from 'lucide-react';

import { useColumnWidths } from '../../../hooks/useColumnWidths';
import { useSessionState } from '../../../hooks/useSessionState';
import { useSnapshotExport } from '../../../hooks/useSnapshotExport';
import { searchRowsByFio } from '../../../utils/fioSearch';
import {
  applyTableView, matchesNameSearch, parseTableView, type IRegistryColumn, type ITableExportSnapshot, type ITableView,
} from '../../../utils/tableView';
import { MonthsPicker } from '../MonthsPicker';
import { SearchInput } from '../SearchInput';
import { RegistryTable, type IRegistryTableProps } from './RegistryTable';
import styles from './RegistryPanel.module.css';

const DEFAULT_VIEW: ITableView = { sort: 'full_name', dir: 'asc', filters: {} };

/** Что переживает уход в карточку сотрудника (viewKey): сортировка, фильтры столбцов, поиск, галочка «Уволенные». */
interface IRegistryPanelState {
  view: ITableView;
  search: string;
  showDismissed: boolean;
}

const parsePanelState = (raw: unknown): IRegistryPanelState | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { view, search, showDismissed } = raw as Record<string, unknown>;
  const parsedView = parseTableView(view);
  if (!parsedView || typeof search !== 'string' || typeof showDismissed !== 'boolean') return null;
  return { view: parsedView, search, showDismissed };
};

/** Итог видимых строк: текст в строке «Итого» таблицы и значения той же строки в xlsx (ключ — столбец). */
export interface IRegistryTotals {
  display: Readonly<Record<string, string>>;
  export: Readonly<Record<string, string | number | null>>;
}

/** Своя кнопка панели перед выбором месяцев: «Виды удержаний» во вкладке кадров. */
export interface IRegistryToolbarAction {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}

/** Текущие поиск и фильтры столбцов — к другим строкам со своими столбцами: видимые строки, как в таблице. */
export type RegistryVisibleOf<Row> = (rows: ReadonlyArray<Row>, columns: ReadonlyArray<IRegistryColumn<Row>>) => Row[];

/** Выбор месяцев рядом с «Экспортом»: только месяцы, «Весь период» не выбирается — последний месяц не снять. */
export interface IRegistryMonths {
  value: string[];
  options: string[];
  onChange: (months: string[]) => void;
}

/** Snapshot — тело запроса «Экспорта»; своё у «Свода» (ведомость 1С), у остальных — снимок таблицы. */
interface IRegistryPanelProps<Row, Snapshot = ITableExportSnapshot>
  extends Omit<
    IRegistryTableProps<Row>,
    'rows' | 'visibleRows' | 'view' | 'onViewChange' | 'loading' | 'footer' | 'columnWidths' | 'onColumnWidth' | 'employeeToggle'
  > {
  /** undefined — ещё не загружены. */
  rows: Row[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** ФИО строки (или другое имя — см. searchPlaceholder) — по нему поиск над таблицей. */
  searchText: (row: Row) => string | null;
  /** searchText — ФИО: ё = е, английская раскладка, ничего точного — с одной ошибкой. */
  fioSearch?: boolean;
  searchPlaceholder?: string;
  /** Снимок xlsx видимых строк (с итогом, если он есть) и его отправка на сервер. */
  buildExport: (rows: ReadonlyArray<Row>, totals?: IRegistryTotals['export']) => Snapshot;
  sendExport: (snapshot: Snapshot) => Promise<{ blob: Blob; filename: string }>;
  /** Передан — «Добавить сотрудника» (право «Редактирование»). */
  onAdd?: () => void;
  /** Подпись кнопки добавления, если она добавляет не сотрудника вообще: «Разовая доплата» в «Доплате». */
  addLabel?: string;
  /** Начальная сортировка; по умолчанию — ФИО по возрастанию. */
  initialView?: ITableView;
  /** Передан — выбор месяцев перед «Экспортом», той же высоты. */
  months?: IRegistryMonths;
  /** Передан — строка «Итого» из видимых строк (после поиска и фильтров): и на экране, и в xlsx. */
  totals?: (rows: ReadonlyArray<Row>) => IRegistryTotals | null;
  /** Передана — своя кнопка перед выбором месяцев и «Экспортом». */
  toolbarAction?: IRegistryToolbarAction;
  /** Передан — блок справа от поиска: итоги вкладок «Свода» по текущим поиску и фильтрам. */
  searchAside?: (visibleOf: RegistryVisibleOf<Row>) => ReactNode;
  /**
   * Передан — ширина столбцов меняется, как в Excel (граница заголовка тянется мышью, двойной клик — по тексту), и
   * запоминается в localStorage по этому ключу («Проживание»). Не передан — ширины подгоняет таблица.
   */
  columnWidthsKey?: string;
  /** Передан — в фильтре столбца «Сотрудник» галочка «Уволенные» (по умолчанию показаны): уволен ли сотрудник строки. */
  isDismissed?: (row: Row) => boolean;
  /**
   * Передан — сортировка, фильтры столбцов, поиск и «Уволенные» хранятся в sessionStorage по этому ключу (у каждой
   * учётки свои, при выходе стираются): переживают уход в карточку сотрудника и пересоздание таблицы («Проживание»).
   */
  viewKey?: string;
}

/**
 * Таблица-реестр с панелью: поиск по ФИО, выбор месяцев, «Экспорт» ровно видимых строк, при праве правки —
 * «Добавить сотрудника»; ошибка загрузки — с «Повторить». «Проживание» и «Удержания» кадров, таблицы «Справочника»
 * и «Свод» «Зарплаты».
 */
export const RegistryPanel = <Row, Snapshot = ITableExportSnapshot>({
  rows, isLoading, isError, onRetry, searchText, fioSearch = false, searchPlaceholder = 'Поиск по ФИО...', buildExport, sendExport, onAdd,
  addLabel = 'Добавить сотрудника',
  initialView = DEFAULT_VIEW, months, totals, toolbarAction, searchAside, columnWidthsKey, isDismissed, viewKey, ...tableProps
}: IRegistryPanelProps<Row, Snapshot>): ReactElement => {
  const { columns } = tableProps;
  const { widths: columnWidths, setWidth: setColumnWidth } = useColumnWidths(columnWidthsKey);
  const [panelState, setPanelState] = useSessionState<IRegistryPanelState>(
    viewKey ? `registry-view:${viewKey}` : null,
    () => ({ view: initialView, search: '', showDismissed: true }),
    { parse: parsePanelState },
  );
  const { view, search, showDismissed } = panelState;
  const setSearch = useCallback((next: string) => setPanelState(prev => ({ ...prev, search: next })), [setPanelState]);
  const setView = useCallback((next: ITableView) => setPanelState(prev => ({ ...prev, view: next })), [setPanelState]);
  const setShowDismissed = useCallback(
    (next: boolean) => setPanelState(prev => ({ ...prev, showDismissed: next })),
    [setPanelState],
  );
  // Итог считается из тех же строк, что уходят в снимок, — экран и xlsx не расходятся.
  const buildSnapshot = (exported: ReadonlyArray<Row>) => buildExport(exported, totals?.(exported)?.export);
  const { exporting, exportRows } = useSnapshotExport(buildSnapshot, sendExport);

  // Все строки — для ширин столбцов (не прыгают); без уволенных, если их скрыли, — для поиска, фильтров и итога.
  const sizeRows = useMemo(() => rows ?? [], [rows]);
  const allRows = useMemo(
    () => (isDismissed && !showDismissed ? sizeRows.filter(row => !isDismissed(row)) : sizeRows),
    [isDismissed, showDismissed, sizeRows],
  );
  const searchRows = useCallback((list: ReadonlyArray<Row>, listColumns: ReadonlyArray<IRegistryColumn<Row>>) => {
    const finalize = (found: Row[]) => applyTableView(found, listColumns, view);
    if (fioSearch) return searchRowsByFio(list, searchText, search, finalize);
    const searched = list.filter(row => matchesNameSearch(searchText(row), search));
    return { searchedRows: searched, visibleRows: finalize(searched) };
  }, [fioSearch, search, searchText, view]);
  const { searchedRows, visibleRows } = useMemo(() => searchRows(allRows, columns), [searchRows, allRows, columns]);
  const visibleOf = useCallback<RegistryVisibleOf<Row>>(
    (list, listColumns) => searchRows(list, listColumns).visibleRows,
    [searchRows],
  );
  const footer = useMemo(() => totals?.(visibleRows)?.display ?? null, [totals, visibleRows]);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput clearable value={search} onValueChange={setSearch} placeholder={searchPlaceholder} />
        </div>
        {searchAside && <div className={styles.searchAside}>{searchAside(visibleOf)}</div>}
        <div className={styles.actions}>
          {toolbarAction && (
            <button type="button" className={`${styles.button} ${styles.buttonSecondary}`} onClick={toolbarAction.onClick}>
              <toolbarAction.icon size={14} aria-hidden="true" />
              <span>{toolbarAction.label}</span>
            </button>
          )}
          {months && (
            <MonthsPicker
              value={months.value}
              options={months.options}
              onChange={months.onChange}
              allowAll={false}
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
              <span>{addLabel}</span>
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
          columnWidths={columnWidths}
          onColumnWidth={setColumnWidth}
          employeeToggle={isDismissed
            ? { label: 'Уволенные', checked: showDismissed, onApply: setShowDismissed }
            : undefined}
          rows={searchedRows}
          sizeRows={sizeRows}
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
