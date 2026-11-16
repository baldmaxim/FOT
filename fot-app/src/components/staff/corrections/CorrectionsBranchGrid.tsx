import { type FC, useCallback, useMemo } from 'react';
import type { QueryKey } from '@tanstack/react-query';

import type { TimesheetResponse } from '../../../types/timesheet';
import { buildCorrectionGridMarks, CORRECTIONS_LEGEND_LABEL } from '../../../utils/staffCorrectionsGrid';
import type { IStaffCorrectionTableRow } from '../../../utils/staffCorrectionsTable';
import { pickWeekendGridData } from '../../../utils/staffWeekendGrid';
import { type ITimesheetGridBadge, TimesheetGrid } from '../../timesheet/TimesheetGrid';
import { useWeekendDayCorrection } from '../weekends/useWeekendDayCorrection';
import { WeekendDayCorrectionModal } from '../weekends/WeekendDayCorrectionModal';
import styles from '../weekends/WeekendsTab.module.css';

const noop = (): void => undefined;

interface ITimesheetQueryState {
  data: TimesheetResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: (options: { cancelRefetch: boolean }) => Promise<{ isError: boolean }>;
}

interface ICorrectionsBranchGridProps {
  branchName: string;
  /** Правки выбранного отдела после поиска, с часами по СКУД (null — ещё считаются). */
  rows: ReadonlyArray<IStaffCorrectionTableRow>;
  searching: boolean;
  /** YYYY-MM */
  month: string;
  queryKey: QueryKey;
  query: ITimesheetQueryState;
  canViewTimesheet: boolean;
  canEdit: boolean;
  compact: boolean;
  onCorrectionClosed: () => void;
}

/**
 * «Корректировки»: сетка табеля отдела только по людям с правками руководителей, такие дни — в рамке с подсказкой (кто,
 * когда, по СКУД → правка). Клик по дню — то же окно, что в «Табеле»: проверить и при праве табеля исправить.
 */
export const CorrectionsBranchGrid: FC<ICorrectionsBranchGridProps> = ({
  branchName, rows, searching, month, queryKey, query, canViewTimesheet, canEdit, compact, onCorrectionClosed,
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

  const marks = useMemo(() => buildCorrectionGridMarks(rows), [rows]);
  const picked = useMemo(() => (query.data ? pickWeekendGridData(query.data, marks.people) : null), [query.data, marks.people]);
  const problemDates = useMemo(() => ({ red: marks.keys }), [marks.keys]);
  const problemTitle = useCallback((cellKey: string): string | undefined => marks.titles.get(cellKey), [marks.titles]);
  const employeeBadge = useCallback(
    (employeeId: number): ReadonlyArray<ITimesheetGridBadge> => marks.badges.get(employeeId) ?? [],
    [marks.badges],
  );

  const notice = ((): string | null => {
    if (rows.length === 0) return searching ? 'Никого не найдено' : 'Нет корректировок руководителей';
    if (!canViewTimesheet) return 'Нужен доступ к табелю';
    if (query.isLoading) return 'Загрузка табеля…';
    if (query.isError || !picked) return 'Не удалось загрузить табель';
    return null;
  })();

  if (notice) {
    return (
      <section className={styles.section}>
        <div className="ts-table-container">
          <div className="ts-table-header-bar">
            <h3 className="ts-table-title">{branchName}</h3>
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
        headerTitle={branchName}
        hideSectionLabels
        problemLegendLabel={CORRECTIONS_LEGEND_LABEL}
        problemTitle={problemTitle}
        employeeBadge={employeeBadge}
        hideEmployeeDetails
        onEmployeeClick={noop}
        onDayClick={correction.handleDayClick}
        onObjectDayClick={correction.handleObjectDayClick}
      />
      <WeekendDayCorrectionModal correction={correction} />
    </section>
  );
};
