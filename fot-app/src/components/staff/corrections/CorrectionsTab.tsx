import { type FC, useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';

import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { useSnapshotExport } from '../../../hooks/useSnapshotExport';
import {
  STAFF_CORRECTIONS_KEY,
  staffCorrectionsService,
  type IStaffCorrectionRow,
} from '../../../services/staffCorrectionsService';
import {
  branchOptionLabel,
  buildBranchOptions,
  readStoredBranch,
  resolveSelectedBranch,
  writeStoredBranch,
} from '../../../utils/branchSelect';
import { getMonthLabel } from '../../../utils/calendarUtils';
import { searchRowsByFio } from '../../../utils/fioSearch';
import { moscowCurrentMonth, shiftMonth } from '../../../utils/moscowDate';
import { canGoToNextWeekendMonth, canGoToPreviousWeekendMonth } from '../../../utils/staffWeekendGrid';
import {
  buildStaffCorrectionsExport,
  STAFF_CORRECTION_COLUMNS,
  type IStaffCorrectionTableRow,
} from '../../../utils/staffCorrectionsTable';
import { applyTableView, type ITableView } from '../../../utils/tableView';
import { RegistryTable } from '../../ui/registry/RegistryTable';
import { SearchInput } from '../../ui/SearchInput';
import { branchTimesheetKey, fetchBranchTimesheet } from '../weekends/branchTimesheetQuery';
import { useWeekendDayCorrection } from '../weekends/useWeekendDayCorrection';
import { WeekendDayCorrectionModal } from '../weekends/WeekendDayCorrectionModal';
import styles from '../weekends/WeekendsTab.module.css';

const EMPTY_ROWS: IStaffCorrectionRow[] = [];
const EMPTY_BRANCHES: Array<{ id: string; name: string }> = [];
const BRANCH_STORAGE_KEY = 'staff-corrections:branch';
const INITIAL_VIEW: ITableView = { sort: '', dir: 'asc', filters: {} };

/**
 * «Управление кадрами» → «Корректировки» (миграция 365): правки часов, которые руководители ставят своим людям, —
 * кадрам проверить. Отдел — селект (число правок после поиска), поиск по ФИО — по всем отделам. Строка — правка:
 * часы «по СКУД» (как посчитал бы табель без неё) → часы правки, кто и когда. Правка действует сразу; клик по строке
 * открывает окно дня (у правки по объекту — окно объекта), исправить можно с правами табеля.
 */
export const CorrectionsTab: FC = () => {
  const { canViewPage, canEditPage, canManageAsHrAdmin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [currentMonth] = useState(moscowCurrentMonth);
  const [month, setMonth] = useState(currentMonth);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ITableView>(INITIAL_VIEW);
  const [manualBranchId, setManualBranchId] = useState<string | null>(() => readStoredBranch(BRANCH_STORAGE_KEY));

  const canViewTimesheet = canViewPage('/timesheet') || canViewPage('/timesheet-hr')
    || canEditPage('/timesheet') || canEditPage('/timesheet-hr');
  const canEdit = canManageAsHrAdmin('/timesheet-hr');

  const listQuery = useQuery({
    queryKey: [...STAFF_CORRECTIONS_KEY, 'list', month],
    queryFn: ({ signal }) => staffCorrectionsService.list(month, signal),
    staleTime: 0,
  });
  const allRows = listQuery.data?.rows ?? EMPTY_ROWS;
  const branches = listQuery.data?.branches ?? EMPTY_BRANCHES;
  const searching = search.trim() !== '';

  // Поиск — по всем отделам сразу: список отделов сужается до тех, где человек нашёлся.
  const searchedRows = useMemo(
    () => searchRowsByFio(allRows, row => row.full_name, search, rows => rows).visibleRows,
    [allRows, search],
  );
  const options = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of searchedRows) counts.set(row.branch_id, (counts.get(row.branch_id) ?? 0) + 1);
    return buildBranchOptions(branches.map(branch => ({
      id: branch.id,
      name: branch.name,
      visibleCount: counts.get(branch.id) ?? 0,
    })), searching);
  }, [branches, searchedRows, searching]);
  const selectedId = listQuery.isSuccess ? resolveSelectedBranch(options, manualBranchId) : null;
  const selectedName = branches.find(branch => branch.id === selectedId)?.name ?? '';

  const skudQuery = useQuery({
    queryKey: [...STAFF_CORRECTIONS_KEY, 'skud', month, selectedId ?? 'none'],
    queryFn: ({ signal }) => staffCorrectionsService.skud(month, selectedId ?? '', signal),
    enabled: selectedId !== null,
    staleTime: 0,
  });

  const branchRows = useMemo((): IStaffCorrectionTableRow[] => searchedRows
    .filter(row => row.branch_id === selectedId)
    .map(row => ({ ...row, skud: skudQuery.data?.[row.id] ?? null })), [searchedRows, selectedId, skudQuery.data]);
  const visibleRows = useMemo(() => applyTableView(branchRows, STAFF_CORRECTION_COLUMNS, view), [branchRows, view]);

  const pickBranch = useCallback((branchId: string) => {
    setManualBranchId(branchId);
    writeStoredBranch(BRANCH_STORAGE_KEY, branchId);
  }, []);

  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  // Табель выбранного отдела — для окна дня (как на «Выходных»; ключ общий — грузится один раз).
  const timesheetQuery = useQuery({
    queryKey: branchTimesheetKey(selectedId ?? 'none', month),
    queryFn: () => fetchBranchTimesheet(selectedId ?? '', month),
    enabled: canViewTimesheet && selectedId !== null,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
  });

  const handleCorrectionClosed = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: STAFF_CORRECTIONS_KEY });
  }, [queryClient]);

  const correction = useWeekendDayCorrection({
    year,
    month: monthNumber,
    data: timesheetQuery.data,
    queryKey: branchTimesheetKey(selectedId ?? 'none', month),
    dataUpdatedAt: timesheetQuery.dataUpdatedAt,
    isFetching: timesheetQuery.isFetching,
    refetch: timesheetQuery.refetch,
    canEdit,
    onClosed: handleCorrectionClosed,
  });

  // Правка по объекту — окно объекта, иначе — окно дня. Табель отдела ещё грузится — подсказка, окно не открываем.
  const { handleDayClick, handleObjectDayClick } = correction;
  const timesheetData = timesheetQuery.data;
  const handleRowClick = useCallback((row: IStaffCorrectionTableRow) => {
    if (!canViewTimesheet) {
      toast.info('Нужен доступ к табелю');
      return;
    }
    if (!timesheetData) {
      toast.info(timesheetQuery.isError ? 'Не удалось загрузить табель отдела' : 'Табель отдела загружается — повторите через секунду');
      return;
    }
    const employee = timesheetData.employees.find(item => item.id === row.employee_id);
    if (!employee) {
      toast.info('Сотрудника нет в табеле этого отдела за месяц');
      return;
    }
    const day = Number(row.work_date.slice(8, 10));
    if (row.window === 'object' && row.object_id) {
      const objectEntry = timesheetData.object_entries.find(item => item.employee_id === employee.id
        && item.work_date === row.work_date && item.object_id === row.object_id) ?? null;
      handleObjectDayClick(employee, day, {
        object_key: row.object_id,
        object_id: row.object_id,
        object_name: row.object_name ?? 'Объект',
      }, objectEntry);
      return;
    }
    const entry = timesheetData.entries.find(item => item.employee_id === employee.id && item.work_date === row.work_date) ?? null;
    handleDayClick(employee, day, entry);
  }, [canViewTimesheet, timesheetData, timesheetQuery.isError, handleDayClick, handleObjectDayClick, toast]);

  const buildSnapshot = useCallback(
    (rows: ReadonlyArray<IStaffCorrectionTableRow>) => buildStaffCorrectionsExport(rows, month, selectedName),
    [month, selectedName],
  );
  const { exporting, exportRows } = useSnapshotExport(buildSnapshot, staffCorrectionsService.exportTable);
  const exportReady = visibleRows.length > 0 && skudQuery.isSuccess;

  const emptyNotice = listQuery.isSuccess && options.length === 0
    ? (searching ? 'Никого не найдено' : 'Нет корректировок руководителей за месяц')
    : null;

  return (
    <div className={styles.tab}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput clearable value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." />
        </div>
        {options.length > 0 && selectedId && (
          <select
            className={styles.branchSelect}
            value={selectedId}
            onChange={event => pickBranch(event.target.value)}
            aria-label="Отдел"
          >
            {options.map(option => (
              <option key={option.id} value={option.id}>{branchOptionLabel(option)}</option>
            ))}
          </select>
        )}
        <div className={styles.monthNav}>
          <button
            type="button"
            className={styles.monthButton}
            onClick={() => setMonth(value => shiftMonth(value, -1))}
            disabled={!canGoToPreviousWeekendMonth(month, currentMonth)}
            aria-label="Предыдущий месяц"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span className={styles.monthLabel}>{getMonthLabel(year, monthNumber)}</span>
          <button
            type="button"
            className={styles.monthButton}
            onClick={() => setMonth(value => shiftMonth(value, 1))}
            disabled={!canGoToNextWeekendMonth(month, currentMonth)}
            aria-label="Следующий месяц"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className={styles.exportButton}
          onClick={() => { void exportRows(visibleRows); }}
          disabled={!exportReady || exporting}
        >
          <Download size={14} aria-hidden="true" />
          <span>{exporting ? 'Выгрузка…' : 'Экспорт'}</span>
        </button>
      </div>

      {listQuery.isLoading && <div className={styles.notice}>Загрузка…</div>}
      {listQuery.isError && (
        <div className={styles.notice}>
          Не удалось загрузить корректировки
          <button type="button" className={styles.retry} onClick={() => { void listQuery.refetch(); }}>Повторить</button>
        </div>
      )}
      {skudQuery.isError && (
        <div className={styles.notice}>
          Не удалось посчитать часы по СКУД
          <button type="button" className={styles.retry} onClick={() => { void skudQuery.refetch(); }}>Повторить</button>
        </div>
      )}
      {emptyNotice && <div className={styles.notice}>{emptyNotice}</div>}

      {selectedId && (
        <RegistryTable
          columns={STAFF_CORRECTION_COLUMNS}
          rows={branchRows}
          visibleRows={visibleRows}
          view={view}
          onViewChange={setView}
          loading={false}
          label={`Корректировки — ${selectedName}`}
          rowKey={row => row.id}
          rowLabel={row => `${row.full_name}, ${row.work_date}`}
          onRowClick={handleRowClick}
        />
      )}
      <WeekendDayCorrectionModal correction={correction} />
    </div>
  );
};
