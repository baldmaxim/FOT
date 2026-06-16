import { type FC, useMemo, useState, Suspense, lazy } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { TimesheetEmployee, TimesheetEntry } from '../../types';
import { timesheetService } from '../../services/timesheetService';
import { getMonthBounds, formatMonthLabel } from '../../utils/timesheetApprovalPeriod';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { useIsMobile } from '../../hooks/useIsMobile';
import { TimesheetGrid } from './TimesheetGrid';
import styles from './DepartmentTimesheetModal.module.css';

const TimesheetCorrectionModal = lazy(() =>
  import('./TimesheetCorrectionModal').then(module => ({ default: module.TimesheetCorrectionModal })),
);

const WEEKDAY_SHORT_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/** 'YYYY-MM-DD' → '06.06.2026 (Сб)' для подписи дня в read-only day-view. */
const formatDayLabel = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00');
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()} (${WEEKDAY_SHORT_RU[d.getDay()]})`;
};

interface IDepartmentTimesheetModalProps {
  /** Месяц табеля в формате 'YYYY-MM'. */
  month: string;
  departmentName: string;
  /** UUID отдела (обычная группа). */
  departmentId?: string;
  /** Состав группы «Непосредственные подчинённые» (department_id синтетический). */
  employeeIds?: number[];
  onClose: () => void;
}

/**
 * Read-only модалка с табелем отдела за месяц. Переиспользует тот же запрос
 * (timesheetService.getAll) и грид (TimesheetGrid), что карточка проверки
 * табеля во вкладке «Табели». Клик по дню открывает детали дня (без правок).
 */
export const DepartmentTimesheetModal: FC<IDepartmentTimesheetModalProps> = ({
  month,
  departmentName,
  departmentId,
  employeeIds,
  onClose,
}) => {
  const isMobile = useIsMobile(768);
  const overlay = useOverlayDismiss(onClose);
  const [year, monthNum] = useMemo(() => month.split('-').map(Number), [month]);
  const monthBounds = useMemo(() => getMonthBounds(month), [month]);

  const tsQuery = useQuery({
    queryKey: ['department-timesheet-modal', departmentId ?? null, (employeeIds ?? []).join(','), month],
    queryFn: () => timesheetService.getAll({
      month,
      department_id: departmentId,
      employee_ids: employeeIds,
      from: monthBounds?.firstDate,
      to: monthBounds?.lastDate,
      include_objects: true,
      schedule_payload: 'compact',
    }),
    staleTime: 30_000,
  });

  const [dayModal, setDayModal] = useState<{
    employee: TimesheetEmployee;
    day: number;
    entry: TimesheetEntry | null;
  } | null>(null);

  const dayModalDate = dayModal ? `${month}-${String(dayModal.day).padStart(2, '0')}` : null;

  return createPortal(
    <>
      <div
        className={styles.overlay}
        onMouseDown={overlay.onMouseDown}
        onMouseUp={overlay.onMouseUp}
        onMouseLeave={overlay.onMouseLeave}
        onTouchStart={overlay.onTouchStart}
        onTouchEnd={overlay.onTouchEnd}
      >
        <div className={styles.container} role="dialog" aria-modal="true">
          <div className={styles.header}>
            <span className={styles.title} title={`Табель · ${departmentName} · ${formatMonthLabel(month)}`}>
              Табель · {departmentName} · {formatMonthLabel(month)}
            </span>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>
          <div className={styles.body}>
            {tsQuery.isLoading ? (
              <div className={styles.state}>Загрузка табеля…</div>
            ) : tsQuery.isError ? (
              <div className={styles.state}>
                Не удалось загрузить табель: {tsQuery.error instanceof Error ? tsQuery.error.message : 'ошибка'}
              </div>
            ) : tsQuery.data ? (
              <TimesheetGrid
                employees={tsQuery.data.employees}
                entries={tsQuery.data.entries}
                objectEntries={tsQuery.data.object_entries}
                employeeStats={tsQuery.data.employee_stats}
                year={year}
                month={monthNum}
                schedules={tsQuery.data.schedules}
                dailySchedules={tsQuery.data.daily_schedules}
                calendar={tsQuery.data.calendar}
                compact={isMobile}
                highlightedCell={null}
                onEmployeeClick={() => {}}
                onDayClick={(emp, day, entry) => setDayModal({ employee: emp, day, entry })}
                onObjectDayClick={() => {}}
              />
            ) : null}
          </div>
        </div>
      </div>

      <Suspense fallback={null}>
        <TimesheetCorrectionModal
          open={dayModal !== null}
          onClose={() => setDayModal(null)}
          onSave={() => {}}
          hideCorrectionTab
          employeeId={dayModal?.employee.id}
          employeeName={dayModal?.employee.full_name}
          workDate={dayModalDate ?? undefined}
          dayLabel={dayModalDate ? formatDayLabel(dayModalDate) : undefined}
          timesheetEntry={dayModal?.entry ?? null}
          allowAccessPointMap={false}
        />
      </Suspense>
    </>,
    document.body,
  );
};
