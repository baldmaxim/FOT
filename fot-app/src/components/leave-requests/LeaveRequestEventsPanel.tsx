import { type FC, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Coffee, LogIn, LogOut, Timer, X, XCircle } from 'lucide-react';
import { skudService } from '../../services/skudService';
import {
  buildDisplayItems,
  calculateWorkSeconds,
  findFirstExternalEntry,
  findLastExternalExit,
  mergeFailuresIntoDisplay,
  sumBreakSeconds,
} from '../../utils/skudDisplay';
import { formatFailureType } from '../../utils/skudFailureTypes';
import { formatSecondsLabel } from '../../utils/hoursDisplay';
import styles from './LeaveRequestEventsPanel.module.css';

interface ILeaveRequestEventsPanelProps {
  employeeId: number;
  employeeName: string;
  date: string;
  onClose: () => void;
}

const formatTime = (time: string): string => time.slice(0, 5);

const formatRuDate = (date: string): string => {
  try {
    return new Date(`${date}T00:00:00`).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      weekday: 'short',
    });
  } catch {
    return date;
  }
};

export const LeaveRequestEventsPanel: FC<ILeaveRequestEventsPanelProps> = ({
  employeeId,
  employeeName,
  date,
  onClose,
}) => {
  const [internalPoints, setInternalPoints] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    skudService
      .getAccessPointSettings()
      .then(settings => {
        if (cancelled) return;
        setInternalPoints(
          new Set(settings.filter(s => s.is_internal).map(s => s.access_point_name.trim())),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const eventsQuery = useQuery({
    queryKey: ['leave-request-events', employeeId, date],
    queryFn: () => skudService.getEmployeeEventsWithFailures(employeeId, date, date),
    staleTime: 30_000,
  });

  const events = useMemo(() => eventsQuery.data?.events ?? [], [eventsQuery.data]);
  const failures = useMemo(() => eventsQuery.data?.failures ?? [], [eventsQuery.data]);

  const items = useMemo(
    () => mergeFailuresIntoDisplay(buildDisplayItems(events, internalPoints, date), failures),
    [events, failures, internalPoints, date],
  );

  const totalSeconds = useMemo(
    () => calculateWorkSeconds(events, internalPoints, date),
    [events, internalPoints, date],
  );

  const totalBreakSeconds = useMemo(() => sumBreakSeconds(items), [items]);

  const firstEntry = useMemo(() => findFirstExternalEntry(events, internalPoints), [events, internalPoints]);
  const lastExit = useMemo(() => findLastExternalExit(events, internalPoints), [events, internalPoints]);

  return (
    <aside className={styles.panel} aria-label="События дня">
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <span className={styles.title} title={employeeName}>{employeeName}</span>
          <span className={styles.subtitle}>{formatRuDate(date)}</span>
        </div>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Закрыть панель"
        >
          <X size={16} />
        </button>
      </div>

      <div className={styles.body}>
        {eventsQuery.isLoading ? (
          <div className={styles.loading}>Загрузка событий…</div>
        ) : eventsQuery.isError ? (
          <div className={styles.empty}>Не удалось загрузить события</div>
        ) : items.length === 0 ? (
          <div className={styles.empty}>Нет событий СКУД за этот день</div>
        ) : (
          <>
            <div className={styles.list}>
              {items.map((item, idx) => {
                if (item.kind === 'break') {
                  return (
                    <div key={`break-${idx}`} className={`${styles.row} ${styles.break}`}>
                      Перерыв: {formatSecondsLabel(item.breakSeconds)}
                    </div>
                  );
                }
                if (item.kind === 'failure') {
                  const f = item.failure;
                  return (
                    <div
                      key={`failure-${f.id}`}
                      className={`${styles.row} ${styles.failure}`}
                      title={f.reason || ''}
                    >
                      <span className={styles.icon}>
                        <XCircle size={14} />
                      </span>
                      <span className={styles.time}>{formatTime(f.event_time)}</span>
                      <span className={styles.dir}>{formatFailureType(f.failure_type)}</span>
                      {f.access_point && <span className={styles.point}>{f.access_point}</span>}
                    </div>
                  );
                }
                const { event: ev, pairDurationSeconds, isInternal } = item;
                return (
                  <div
                    key={ev.id}
                    className={`${styles.row} ${ev.direction === 'entry' ? styles.entry : styles.exit} ${isInternal ? styles.internal : ''}`.trim()}
                  >
                    <span className={styles.icon}>
                      {ev.direction === 'entry' ? <LogIn size={14} /> : <LogOut size={14} />}
                    </span>
                    <span className={styles.time}>{formatTime(ev.event_time)}</span>
                    <span className={styles.dir}>{ev.direction === 'entry' ? 'Вход' : 'Выход'}</span>
                    {ev.access_point && <span className={styles.point}>{ev.access_point}</span>}
                    {pairDurationSeconds !== null && pairDurationSeconds > 0 && (
                      <span className={styles.duration}>{formatSecondsLabel(pairDurationSeconds)}</span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className={styles.summary}>
              <span className={styles.firstLast}>
                {firstEntry && <span><LogIn size={11} /> {formatTime(firstEntry.event_time)}</span>}
                {lastExit && <span><LogOut size={11} /> {formatTime(lastExit.event_time)}</span>}
              </span>
              <span className={styles.summaryRow}>
                <span className={styles.summaryLabel}>
                  <Timer size={12} className={styles.summaryIcon} />
                  Присутствие:
                </span>
                <span className={styles.summaryValue}>{formatSecondsLabel(totalSeconds)}</span>
              </span>
              {totalBreakSeconds > 0 && (
                <span className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>
                    <Coffee size={12} className={styles.summaryIcon} />
                    Перерыв:
                  </span>
                  <span className={styles.summaryValue}>{formatSecondsLabel(totalBreakSeconds)}</span>
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
};
