import { type FC, lazy, Suspense } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { selectVisibleHours, formatHoursLabel } from '../../utils/hoursDisplay';
import { STATUS_LABEL_RU } from '../../utils/dayStatus';
import type { IDayFocusPayload } from './MyMonthTimesheet';
import styles from './DayDetailPanel.module.css';

const EmployeeSkudSection = lazy(() =>
  import('../employees/EmployeeSkudSection').then((m) => ({ default: m.EmployeeSkudSection })),
);

interface IDayDetailPanelProps {
  employeeId: number;
  employeeName: string;
  focusedDay: string;
  payload: IDayFocusPayload;
  focusKey: number;
}

type Approval = 'auto_approved' | 'pending' | 'approved' | 'rejected';

const APPROVAL_LABEL: Record<Approval, string> = {
  auto_approved: 'Учтено',
  pending: 'На согласовании',
  approved: 'Согласовано',
  rejected: 'Отклонено',
};

const approvalClass = (status?: string | null): string => {
  if (status === 'pending') return styles.badgePending;
  if (status === 'rejected') return styles.badgeRejected;
  return styles.badgeApproved;
};

const ApprovalBadge: FC<{ status?: string | null }> = ({ status }) => {
  const key = (status ?? 'auto_approved') as Approval;
  return <span className={`${styles.badge} ${approvalClass(status)}`}>{APPROVAL_LABEL[key] ?? 'Учтено'}</span>;
};

export const DayDetailPanel: FC<IDayDetailPanelProps> = ({
  employeeId,
  employeeName,
  focusedDay,
  payload,
  focusKey,
}) => {
  const { showActualHours } = useAuth();
  const { entry, objectEntries, ds, isProblematic } = payload;

  const visibleHours = selectVisibleHours(entry, showActualHours);
  const dateLabel = new Date(focusedDay + 'T00:00').toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  // Реальные объектные строки (СКУД + manual_object). Эхо day-level корректировки скрываем.
  const realObjects = objectEntries.filter((o) => !o.from_day_level);
  const dayLevelCorrection = entry?.is_correction ? entry : null;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.date}>{dateLabel}</span>
        <span className={styles.status}>{STATUS_LABEL_RU[ds]}</span>
      </div>

      {visibleHours != null && visibleHours > 0 ? (
        <div className={styles.hoursRow}>
          <span className={styles.hoursLabel}>Часы</span>
          <span className={styles.hoursValue}>{formatHoursLabel(visibleHours)}</span>
        </div>
      ) : null}

      {/* Корректировки из табеля по объектам (#10) */}
      {realObjects.length > 0 ? (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Корректировки по объектам</div>
          <ul className={styles.objectList}>
            {realObjects.map((o) => (
              <li key={o.object_key} className={styles.objectItem}>
                <div className={styles.objectMain}>
                  <span className={styles.objectName}>{o.object_name}</span>
                  <span className={styles.objectHours}>{formatHoursLabel(o.hours_worked)}</span>
                </div>
                <div className={styles.objectMeta}>
                  {o.is_correction ? <ApprovalBadge status={o.approval_status} /> : <span className={styles.muted}>по СКУД</span>}
                  {o.corrected_by_name ? <span className={styles.muted}>· {o.corrected_by_name}</span> : null}
                </div>
                {o.notes ? <div className={styles.objectNotes}>{o.notes}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Day-level корректировка без объекта (легаси/особые случаи) */}
      {dayLevelCorrection && realObjects.length === 0 ? (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Корректировка табеля</div>
          <div className={styles.objectMeta}>
            <ApprovalBadge status={dayLevelCorrection.approval_status} />
            {dayLevelCorrection.corrected_by_name ? (
              <span className={styles.muted}>· {dayLevelCorrection.corrected_by_name}</span>
            ) : null}
          </div>
          {dayLevelCorrection.notes ? (
            <div className={styles.objectNotes}>{dayLevelCorrection.notes}</div>
          ) : null}
          {dayLevelCorrection.approved_by_name ? (
            <div className={styles.muted}>Согласовал: {dayLevelCorrection.approved_by_name}</div>
          ) : null}
        </div>
      ) : null}

      {!entry && realObjects.length === 0 ? (
        <div className={styles.empty}>Нет данных по этому дню</div>
      ) : null}

      {/* Просмотр СКУД для проблемных дней (#7) */}
      {isProblematic ? (
        <div className={styles.skudSection}>
          <div className={styles.sectionTitle}>Проходы СКУД</div>
          <Suspense fallback={<div className={styles.muted}>Загрузка событий…</div>}>
            <EmployeeSkudSection
              employeeId={employeeId}
              employeeName={employeeName}
              focusDate={focusedDay}
              focusKey={focusKey}
              externalViewMode="day"
              externalViewDate={focusedDay}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
};
