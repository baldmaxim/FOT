import { type FC, useCallback, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';

import { useAuth } from '../../../contexts/AuthContext';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useSnapshotExport } from '../../../hooks/useSnapshotExport';
import { STAFF_WEEKENDS_KEY, staffWeekendService, type IStaffWeekendBranch } from '../../../services/staffWeekendService';
import { timesheetService } from '../../../services/timesheetService';
import { getMonthLabel } from '../../../utils/calendarUtils';
import { searchRowsByFio } from '../../../utils/fioSearch';
import { moscowCurrentMonth, shiftMonth } from '../../../utils/moscowDate';
import {
  canGoToNextWeekendMonth,
  canGoToPreviousWeekendMonth,
  weekendVisibleHours,
} from '../../../utils/staffWeekendGrid';
import { buildStaffWeekendExport, type IStaffWeekendExportRow } from '../../../utils/staffWeekendTable';
import { getMonthBounds } from '../../../utils/timesheetApprovalPeriod';
import { SearchInput } from '../../ui/SearchInput';
import { WeekendBranchGrid } from './WeekendBranchGrid';
import { WeekendPeriodActions } from './WeekendPeriodActions';
import styles from './WeekendsTab.module.css';

const EMPTY_BRANCHES: IStaffWeekendBranch[] = [];

/** Ключ внутри ['timesheet-page']: правка табеля обновляет и эту сетку. */
const branchTimesheetKey = (branchId: string, month: string) => ['timesheet-page', 'staff-weekends', branchId, month] as const;

/**
 * «Управление кадрами» → «Выходные» (миграция 346): ЛИНИЯ и ЛИНИЯ-Общестрой отдельными сетками табеля, в них — кто
 * работал в выходной по СКУД без корректировки. Такие дни в красной рамке; плановые субботы графика сюда не входят.
 * Клик по дню открывает то же окно, что в «Табеле».
 */
export const WeekendsTab: FC = () => {
  const { canViewPage, canEditPage, canManageAsHrAdmin, showActualHours } = useAuth();
  const queryClient = useQueryClient();
  const compact = useIsMobile(768);
  const [currentMonth] = useState(moscowCurrentMonth);
  const [month, setMonth] = useState(currentMonth);
  const [search, setSearch] = useState('');

  const canViewTimesheet = canViewPage('/timesheet') || canViewPage('/timesheet-hr')
    || canEditPage('/timesheet') || canEditPage('/timesheet-hr');
  const canEdit = canManageAsHrAdmin('/timesheet-hr');

  const gridQuery = useQuery({
    queryKey: [...STAFF_WEEKENDS_KEY, 'grid', month],
    queryFn: ({ signal }) => staffWeekendService.grid(month, signal),
    staleTime: 0,
  });
  const branches = gridQuery.data?.branches ?? EMPTY_BRANCHES;
  const bounds = getMonthBounds(month);

  // Те же параметры, что у «Табеля» по отделу: те же окна перевода, замки и часы.
  const timesheetQueries = useQueries({
    queries: branches.map(branch => ({
      queryKey: branchTimesheetKey(branch.id, month),
      queryFn: () => timesheetService.getAll({
        month,
        department_id: branch.id,
        from: bounds?.firstDate,
        to: bounds?.lastDate,
        include_objects: true,
        show_fired: true,
        schedule_payload: 'compact' as const,
      }),
      enabled: canViewTimesheet && branch.rows.length > 0,
      staleTime: 5 * 60_000,
      gcTime: 15 * 60_000,
      refetchOnWindowFocus: 'always' as const,
    })),
  });

  const visibleRows = useMemo(() => new Map(branches.map(branch => [
    branch.id,
    searchRowsByFio(branch.rows, row => row.full_name, search, rows => rows).visibleRows,
  ])), [branches, search]);

  // Часы экспорта — из записей сетки, поэтому файл собирается, только когда загружены все нужные табели.
  const exportReady = gridQuery.isSuccess && timesheetQueries.every((query, index) => (
    (branches[index]?.rows.length ?? 0) === 0 || Boolean(query.data)
  ));
  const exportRowsList = useMemo((): IStaffWeekendExportRow[] => (
    branches.flatMap((branch, index) => (visibleRows.get(branch.id) ?? []).map(row => ({
      full_name: row.full_name,
      department: branch.name,
      position: row.position,
      days: row.days,
      hours: weekendVisibleHours(timesheetQueries[index]?.data?.entries ?? [], row, showActualHours),
    })))
  ), [branches, visibleRows, timesheetQueries, showActualHours]);

  const buildSnapshot = useCallback(
    (rows: ReadonlyArray<IStaffWeekendExportRow>) => buildStaffWeekendExport(rows, month),
    [month],
  );
  const { exporting, exportRows } = useSnapshotExport(buildSnapshot, staffWeekendService.exportTable);

  const handleCorrectionClosed = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: STAFF_WEEKENDS_KEY });
  }, [queryClient]);

  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const canManagePeriods = gridQuery.data?.can_manage_periods === true;
  // Легенда одна на экран — у первой настоящей сетки.
  const legendBranchId = canViewTimesheet
    ? branches.find(branch => (visibleRows.get(branch.id) ?? []).length > 0)?.id
    : undefined;

  return (
    <div className={styles.tab}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchInput clearable value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." />
        </div>
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

      {branches.map((branch, index) => {
        const query = timesheetQueries[index];
        if (!query) return null;
        return (
          <WeekendBranchGrid
            key={branch.id}
            branch={branch}
            rows={visibleRows.get(branch.id) ?? []}
            searching={search.trim() !== ''}
            month={month}
            queryKey={branchTimesheetKey(branch.id, month)}
            query={query}
            canViewTimesheet={canViewTimesheet}
            canEdit={canEdit}
            showLegend={branch.id === legendBranchId}
            compact={compact}
            actions={canManagePeriods && branch.periods.length > 0
              ? <WeekendPeriodActions branch={branch} month={month} />
              : undefined}
            lockHint={canManagePeriods ? 'Чтобы править, откройте табель кнопкой над сеткой' : undefined}
            onCorrectionClosed={handleCorrectionClosed}
          />
        );
      })}
    </div>
  );
};
