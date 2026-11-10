import { type FC, type ReactNode, useCallback, useMemo } from 'react';
import type { QueryKey } from '@tanstack/react-query';

import type { IStaffWeekendBranch, IStaffWeekendRow } from '../../../services/staffWeekendService';
import type { TimesheetResponse } from '../../../types/timesheet';
import {
  pickWeekendGridData,
  WEEKEND_NO_CORRECTION_LABEL,
  WEEKEND_ZERO_HOURS_LABEL,
  weekendProblemKeys,
  weekendRowBadges,
  weekendZeroHourKeys,
} from '../../../utils/staffWeekendGrid';
import { type ITimesheetGridBadge, TimesheetGrid } from '../../timesheet/TimesheetGrid';
import { useWeekendDayCorrection } from './useWeekendDayCorrection';
import { WeekendDayCorrectionModal } from './WeekendDayCorrectionModal';
import styles from './WeekendsTab.module.css';

const noop = (): void => undefined;

interface ITimesheetQueryState {
  data: TimesheetResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: (options: { cancelRefetch: boolean }) => Promise<{ isError: boolean }>;
}

interface IWeekendBranchGridProps {
  branch: IStaffWeekendBranch;
  /** Строки после поиска по ФИО. */
  rows: ReadonlyArray<IStaffWeekendRow>;
  searching: boolean;
  /** YYYY-MM */
  month: string;
  queryKey: QueryKey;
  query: ITimesheetQueryState;
  canViewTimesheet: boolean;
  canEdit: boolean;
  /** Часы клеток по роли (show_actual_hours) — как в сетке. */
  showActualHours: boolean;
  showLegend: boolean;
  compact: boolean;
  /** Кнопки справа в шапке отдела. */
  actions?: ReactNode;
  lockHint?: string;
  onCorrectionClosed: () => void;
}

/** Отдел на вкладке «Выходные»: шапка с названием и кнопками, сетка табеля только по людям из списка. */
export const WeekendBranchGrid: FC<IWeekendBranchGridProps> = ({
  branch, rows, searching, month, queryKey, query, canViewTimesheet, canEdit, showActualHours, showLegend, compact, actions,
  lockHint, onCorrectionClosed,
}) => {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];

  const correction = useWeekendDayCorrection({
    year,
    month: monthNumber,
    data: query.data,
    queryKey,
    dataUpdatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    refetch: query.refetch,
    canEdit,
    onClosed: onCorrectionClosed,
  });

  const picked = useMemo(() => (query.data ? pickWeekendGridData(query.data, rows) : null), [query.data, rows]);
  const problemDates = useMemo(() => ({ red: weekendProblemKeys(rows) }), [rows]);
  // Рамка у обоих видов дня красная: «без часов» (в клетке 0) отличают метка у ФИО и подсказка.
  const zeroHourKeys = useMemo(
    () => weekendZeroHourKeys(picked?.entries ?? [], rows, showActualHours),
    [picked, rows, showActualHours],
  );
  const badgesByEmployee = useMemo(
    () => new Map(rows.map(row => [row.employee_id, weekendRowBadges(row, zeroHourKeys)])),
    [rows, zeroHourKeys],
  );
  const employeeBadge = useCallback(
    (employeeId: number): ReadonlyArray<ITimesheetGridBadge> => badgesByEmployee.get(employeeId) ?? [],
    [badgesByEmployee],
  );
  const problemTitle = useCallback(
    (cellKey: string): string => (zeroHourKeys.has(cellKey) ? WEEKEND_ZERO_HOURS_LABEL : WEEKEND_NO_CORRECTION_LABEL),
    [zeroHourKeys],
  );

  const notice = ((): string | null => {
    if (rows.length === 0) return searching ? 'Никого не найдено' : 'Нет выходов без корректировки';
    if (!canViewTimesheet) return 'Нужен доступ к табелю';
    if (query.isLoading) return 'Загрузка табеля…';
    if (query.isError || !picked) return 'Не удалось загрузить табель';
    return null;
  })();

  if (notice) {
    return (
      <section className={styles.section}>
        <div className="ts-table-container">
          <div className="ts-table-header-bar ts-table-header-bar--with-actions">
            <h3 className="ts-table-title">{branch.name}</h3>
            {actions}
          </div>
          <div className={styles.notice}>
            {notice}
            {query.isError && canViewTimesheet && rows.length > 0 && (
              <button type="button" className={styles.retry} onClick={() => { void query.refetch({ cancelRefetch: false }); }}>
                Повторить
              </button>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <TimesheetGrid
        employees={picked?.employees ?? []}
        entries={picked?.entries ?? []}
        objectEntries={picked?.object_entries ?? []}
        employeeStats={picked?.employee_stats}
        year={year}
        month={monthNumber}
        schedules={query.data?.schedules}
        dailySchedules={query.data?.daily_schedules}
        calendar={query.data?.calendar}
        compact={compact}
        approvalStatusFor={correction.lockStatusFor}
        problemDates={problemDates}
        headerTitle={branch.name}
        headerActions={actions}
        hideLegend={!showLegend}
        hideSectionLabels
        problemLegendLabel={WEEKEND_NO_CORRECTION_LABEL}
        problemTitle={problemTitle}
        employeeBadge={employeeBadge}
        hideEmployeeDetails
        onEmployeeClick={noop}
        onDayClick={correction.handleDayClick}
        onObjectDayClick={correction.handleObjectDayClick}
      />
      <WeekendDayCorrectionModal correction={correction} lockHint={lockHint} />
    </section>
  );
};
