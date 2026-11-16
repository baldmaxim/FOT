import { type FC, useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';

import { useAuth } from '../../../contexts/AuthContext';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useSnapshotExport } from '../../../hooks/useSnapshotExport';
import { STAFF_WEEKENDS_KEY, staffWeekendService, type IStaffWeekendBranch } from '../../../services/staffWeekendService';
import {
  buildBranchOptions,
  readStoredBranch,
  resolveSelectedBranch,
  writeStoredBranch,
} from '../../../utils/branchSelect';
import { buildBranchTree } from '../../../utils/branchTree';
import { getMonthLabel } from '../../../utils/calendarUtils';
import { searchRowsByFio } from '../../../utils/fioSearch';
import { moscowCurrentMonth, shiftMonth } from '../../../utils/moscowDate';
import {
  canGoToNextWeekendMonth,
  canGoToPreviousWeekendMonth,
  weekendVisibleHours,
} from '../../../utils/staffWeekendGrid';
import { buildStaffWeekendExport, type IStaffWeekendExportRow } from '../../../utils/staffWeekendTable';
import { SearchInput } from '../../ui/SearchInput';
import { DepartmentTreeSelect } from '../DepartmentTreeSelect';
import { branchTimesheetKey, fetchBranchTimesheet } from './branchTimesheetQuery';
import { WeekendBranchGrid } from './WeekendBranchGrid';
import { WeekendPeriodActions } from './WeekendPeriodActions';
import styles from './WeekendsTab.module.css';

const EMPTY_BRANCHES: IStaffWeekendBranch[] = [];
const BRANCH_STORAGE_KEY = 'staff-weekends:branch';

/**
 * «Управление кадрами» → «Выходные» (миграция 346): отделы и бригады, где кто-то работал в выходной по СКУД без
 * корректировки, в том числе вошёл без пары (в клетке 0 — метка «без часов»). Отдел выбирается в дереве (как в
 * «Текущих сотрудниках»), на экране —
 * сетка табеля только выбранного, такие дни в красной рамке; плановые субботы графика сюда не входят. Клик по дню
 * открывает то же окно, что в «Табеле».
 */
export const WeekendsTab: FC = () => {
  const { canViewPage, canEditPage, canManageAsHrAdmin, showActualHours } = useAuth();
  const queryClient = useQueryClient();
  const compact = useIsMobile(768);
  const [currentMonth] = useState(moscowCurrentMonth);
  const [month, setMonth] = useState(currentMonth);
  const [search, setSearch] = useState('');
  // Ручной выбор: автовыбор (поиск, отдел исчез) его не меняет и не сбрасывается при загрузке или смене месяца.
  const [manualBranchId, setManualBranchId] = useState<string | null>(() => readStoredBranch(BRANCH_STORAGE_KEY));

  const canViewTimesheet = canViewPage('/timesheet') || canViewPage('/timesheet-hr')
    || canEditPage('/timesheet') || canEditPage('/timesheet-hr');
  const canEdit = canManageAsHrAdmin('/timesheet-hr');

  const gridQuery = useQuery({
    queryKey: [...STAFF_WEEKENDS_KEY, 'grid', month],
    queryFn: ({ signal }) => staffWeekendService.grid(month, signal),
    staleTime: 0,
  });
  const branches = gridQuery.data?.branches ?? EMPTY_BRANCHES;
  const canManagePeriods = gridQuery.data?.can_manage_periods === true;
  const searching = search.trim() !== '';

  const visibleRows = useMemo(() => new Map(branches.map(branch => [
    branch.id,
    searchRowsByFio(branch.rows, row => row.full_name, search, rows => rows).visibleRows,
  ])), [branches, search]);

  const options = useMemo(() => buildBranchOptions(branches.map(branch => ({
    id: branch.id,
    name: branch.name,
    visibleCount: visibleRows.get(branch.id)?.length ?? 0,
    keepWhenEmpty: canManagePeriods && branch.periods.length > 0,
  })), searching), [branches, visibleRows, canManagePeriods, searching]);
  // Список отделов — деревом, как в «Текущих сотрудниках»: предки серыми заголовками, пункты с числом людей.
  const branchTree = useMemo(() => buildBranchTree(options, branches), [options, branches]);

  // Сверка выбора — только по успешному ответу: во время загрузки и ошибки ничего не выбрано и не сброшено.
  const selectedId = gridQuery.isSuccess ? resolveSelectedBranch(options, manualBranchId) : null;
  const selectedBranch = branches.find(branch => branch.id === selectedId) ?? null;
  const selectedRows = useMemo(
    () => (selectedBranch ? visibleRows.get(selectedBranch.id) ?? [] : []),
    [selectedBranch, visibleRows],
  );

  // Тот же запрос, что у «Табеля» по отделу: те же окна перевода, замки и часы. Только выбранный отдел со строками.
  const timesheetQuery = useQuery({
    queryKey: branchTimesheetKey(selectedBranch?.id ?? 'none', month),
    queryFn: () => fetchBranchTimesheet(selectedBranch?.id ?? '', month),
    enabled: canViewTimesheet && selectedBranch !== null && selectedBranch.rows.length > 0,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: 'always' as const,
  });

  const pickBranch = useCallback((branchId: string) => {
    if (!branchId) return;
    setManualBranchId(branchId);
    writeStoredBranch(BRANCH_STORAGE_KEY, branchId);
  }, []);

  // Часы экспорта — из записей сетки: файл собирается, когда загружен табель выбранного отдела.
  const exportReady = selectedRows.length > 0 && Boolean(timesheetQuery.data);
  const exportRowsList = useMemo((): IStaffWeekendExportRow[] => (
    selectedBranch
      ? selectedRows.map(row => ({
        full_name: row.full_name,
        department: selectedBranch.name,
        position: row.position,
        days: row.days,
        hours: weekendVisibleHours(timesheetQuery.data?.entries ?? [], row, showActualHours),
      }))
      : []
  ), [selectedBranch, selectedRows, timesheetQuery.data, showActualHours]);

  const buildSnapshot = useCallback(
    (rows: ReadonlyArray<IStaffWeekendExportRow>) => buildStaffWeekendExport(rows, month),
    [month],
  );
  const { exporting, exportRows } = useSnapshotExport(buildSnapshot, staffWeekendService.exportTable);

  const handleCorrectionClosed = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: STAFF_WEEKENDS_KEY });
  }, [queryClient]);

  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const emptyNotice = gridQuery.isSuccess && options.length === 0
    ? (searching ? 'Никого не найдено' : 'Нет выходов без корректировки')
    : null;

  return (
    <div className={styles.tab}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput clearable value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." />
        </div>
        {options.length > 0 && selectedId && (
          <div className={styles.branchSelect}>
            <DepartmentTreeSelect
              departments={branchTree}
              value={selectedId}
              onChange={pickBranch}
              showAllOption={false}
              selectableRoots
            />
          </div>
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
          onClick={() => { void exportRows(exportRowsList); }}
          disabled={!exportReady || exporting || exportRowsList.length === 0}
        >
          <Download size={14} aria-hidden="true" />
          <span>{exporting ? 'Выгрузка…' : 'Экспорт'}</span>
        </button>
      </div>

      {gridQuery.isLoading && <div className={styles.notice}>Загрузка…</div>}
      {gridQuery.isError && (
        <div className={styles.notice}>
          Не удалось загрузить список
          <button type="button" className={styles.retry} onClick={() => { void gridQuery.refetch(); }}>Повторить</button>
        </div>
      )}
      {emptyNotice && <div className={styles.notice}>{emptyNotice}</div>}

      {selectedBranch && (
        <WeekendBranchGrid
          key={selectedBranch.id}
          branch={selectedBranch}
          rows={selectedRows}
          searching={searching}
          month={month}
          queryKey={branchTimesheetKey(selectedBranch.id, month)}
          query={timesheetQuery}
          canViewTimesheet={canViewTimesheet}
          canEdit={canEdit}
          showActualHours={showActualHours}
          showLegend
          compact={compact}
          actions={canManagePeriods && selectedBranch.periods.length > 0
            ? <WeekendPeriodActions branch={selectedBranch} month={month} />
            : undefined}
          lockHint={canManagePeriods ? 'Чтобы править, откройте табель кнопкой над сеткой' : undefined}
          onCorrectionClosed={handleCorrectionClosed}
        />
      )}
    </div>
  );
};
