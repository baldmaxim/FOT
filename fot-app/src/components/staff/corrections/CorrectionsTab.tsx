import { type FC, useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';

import { useAuth } from '../../../contexts/AuthContext';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useSnapshotExport } from '../../../hooks/useSnapshotExport';
import {
  STAFF_CORRECTIONS_KEY,
  staffCorrectionsService,
  type IStaffCorrectionRow,
  type IStaffCorrectionsList,
} from '../../../services/staffCorrectionsService';
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
import { canGoToNextWeekendMonth, canGoToPreviousWeekendMonth } from '../../../utils/staffWeekendGrid';
import { buildStaffCorrectionsExport, type IStaffCorrectionTableRow } from '../../../utils/staffCorrectionsTable';
import { SearchInput } from '../../ui/SearchInput';
import { DepartmentTreeSelect } from '../DepartmentTreeSelect';
import { branchTimesheetKey, fetchBranchTimesheet } from '../weekends/branchTimesheetQuery';
import styles from '../weekends/WeekendsTab.module.css';
import { CorrectionsBranchGrid } from './CorrectionsBranchGrid';

const EMPTY_ROWS: IStaffCorrectionRow[] = [];
const EMPTY_BRANCHES: IStaffCorrectionsList['branches'] = [];
const BRANCH_STORAGE_KEY = 'staff-corrections:branch';

/**
 * «Управление кадрами» → «Корректировки» (миграция 365): правки часов, которые руководители ставят своим людям, —
 * кадрам проверить. Как табель: отдел — в дереве (как в «Текущих сотрудниках», число людей с правками), на экране —
 * сетка отдела только по этим людям, дни с правкой руководителя — в рамке с подсказкой (кто, когда, по СКУД → правка).
 * Клик по дню — окно дня, исправить можно с правами табеля. Поиск по ФИО — по всем отделам. «Экспорт» — список правок.
 */
export const CorrectionsTab: FC = () => {
  const { canViewPage, canEditPage, canManageAsHrAdmin } = useAuth();
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
  // (N) — люди с правками после поиска, как на «Выходных».
  const options = useMemo(() => {
    const people = new Map<string, Set<number>>();
    for (const row of searchedRows) {
      const set = people.get(row.branch_id) ?? new Set<number>();
      set.add(row.employee_id);
      people.set(row.branch_id, set);
    }
    return buildBranchOptions(branches.map(branch => ({
      id: branch.id,
      name: branch.name,
      visibleCount: people.get(branch.id)?.size ?? 0,
    })), searching);
  }, [branches, searchedRows, searching]);
  const branchTree = useMemo(() => buildBranchTree(options, branches), [options, branches]);
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

  const pickBranch = useCallback((branchId: string) => {
    if (!branchId) return;
    setManualBranchId(branchId);
    writeStoredBranch(BRANCH_STORAGE_KEY, branchId);
  }, []);

  // Табель выбранного отдела — для сетки и окна дня (ключ общий с «Выходными» — грузится один раз).
  const timesheetQuery = useQuery({
    queryKey: branchTimesheetKey(selectedId ?? 'none', month),
    queryFn: () => fetchBranchTimesheet(selectedId ?? '', month),
    enabled: canViewTimesheet && selectedId !== null,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: 'always' as const,
  });

  const handleCorrectionClosed = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: STAFF_CORRECTIONS_KEY });
  }, [queryClient]);

  const buildSnapshot = useCallback(
    (rows: ReadonlyArray<IStaffCorrectionTableRow>) => buildStaffCorrectionsExport(rows, month, selectedName),
    [month, selectedName],
  );
  const { exporting, exportRows } = useSnapshotExport(buildSnapshot, staffCorrectionsService.exportTable);
  const exportReady = branchRows.length > 0 && skudQuery.isSuccess;

  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
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
          onClick={() => { void exportRows(branchRows); }}
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
        <CorrectionsBranchGrid
          key={selectedId}
          branchName={selectedName}
          rows={branchRows}
          searching={searching}
          month={month}
          queryKey={branchTimesheetKey(selectedId, month)}
          query={timesheetQuery}
          canViewTimesheet={canViewTimesheet}
          canEdit={canEdit}
          compact={compact}
          onCorrectionClosed={handleCorrectionClosed}
        />
      )}
    </div>
  );
};
