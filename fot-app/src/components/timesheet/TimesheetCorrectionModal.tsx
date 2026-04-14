import { type FC, type ReactNode, useState, useEffect, useCallback } from 'react';
import { X, LogIn, LogOut, Timer } from 'lucide-react';
import type { TimesheetEntry, TimesheetStatus, SkudEvent } from '../../types';
import { skudService } from '../../services/skudService';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';

interface ICorrectionModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (status: TimesheetStatus, hours: number | null, notes: string) => void;
  onDelete?: () => void;
  initialStatus?: TimesheetStatus;
  initialHours?: number | null;
  initialNotes?: string | null;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
  deleteLabel?: string;
  dayLabel?: string;
  employeeName?: string;
  employeeId?: number;
  workDate?: string;
  hideCorrectionTab?: boolean;
  hideSkudTab?: boolean;
  allowedStatuses?: TimesheetStatus[];
  customContent?: ReactNode;
  customContentFooterLabel?: string;
  timesheetEntry?: Pick<TimesheetEntry, 'first_entry' | 'last_exit' | 'hours_worked'> | null;
  correctionInfo?: {
    is_correction: boolean;
    corrected_at?: string | null;
    corrected_by_name?: string | null;
  } | null;
}

interface ITypeOption {
  status: TimesheetStatus;
  icon: string;
  label: string;
}

type ModalTab = 'events' | 'correction';
const HOURS_EDITABLE_STATUSES = new Set<TimesheetStatus>(['work', 'manual']);

const formatHM = (decimal: number): string => {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

const formatTime = (time: string): string => time.slice(0, 5);

const todayISO = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const timeToSeconds = (time: string): number => {
  const [h, m, s = 0] = time.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

const formatDuration = (seconds: number): string => {
  if (seconds <= 0) return '0м';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}м`;
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

const TYPE_OPTIONS: ITypeOption[] = [
  { status: 'work', icon: '✔', label: 'Присутствие' },
  { status: 'remote', icon: '🏠', label: 'Удалёнка' },
  { status: 'sick', icon: '🏥', label: 'Больничный' },
  { status: 'vacation', icon: '🏖', label: 'Отпуск' },
  { status: 'business_trip', icon: '✈️', label: 'Командировка' },
  { status: 'absent', icon: '❌', label: 'Прогул' },
  { status: 'manual', icon: '✏️', label: 'Ручная корр.' },
];

const EventsTab: FC<{
  employeeId: number;
  workDate: string;
  timesheetEntry?: Pick<TimesheetEntry, 'first_entry' | 'last_exit' | 'hours_worked'> | null;
}> = ({ employeeId, workDate, timesheetEntry }) => {
  const [events, setEvents] = useState<SkudEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [internalPoints, setInternalPoints] = useState<Set<string>>(new Set());

  useEffect(() => {
    skudService.getAccessPointSettings().then(settings => {
      setInternalPoints(new Set(settings.filter(s => s.is_internal).map(s => s.access_point_name.trim())));
    }).catch(() => {});
  }, []);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await skudService.getEmployeeEvents(employeeId, workDate, workDate);
      data.sort((a, b) => a.event_time.localeCompare(b.event_time));
      setEvents(data);
    } catch (err) {
      setEvents([]);
      setError(err instanceof Error ? err.message : 'Не удалось загрузить события СКУД');
    } finally {
      setLoading(false);
    }
  }, [employeeId, workDate]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const extEvents = events.filter(e => !e.access_point || !internalPoints.has(e.access_point));
  const summaryEvents = extEvents.length > 0 ? extEvents : events;

  const calcPairs = (evts: SkudEvent[]): number => {
    let total = 0;
    let entry: number | null = null;
    for (const ev of evts) {
      if (ev.direction === 'entry') {
        if (entry === null) entry = timeToSeconds(ev.event_time);
      } else if (ev.direction === 'exit' && entry !== null) {
        total += timeToSeconds(ev.event_time) - entry;
        entry = null;
      }
    }
    // Открытый вход (на работе сейчас) — считаем до текущего времени
    if (entry !== null && workDate === todayISO()) {
      const now = new Date();
      const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      if (nowSec > entry) total += nowSec - entry;
    }
    return total;
  };

  const fallbackTotalSec = calcPairs(summaryEvents);
  const fallbackFirstEntry = summaryEvents.find(e => e.direction === 'entry');
  const fallbackLastExit = [...summaryEvents].reverse().find(e => e.direction === 'exit');
  const totalSec = timesheetEntry?.hours_worked != null
    ? Math.max(0, Math.round(timesheetEntry.hours_worked * 3600))
    : fallbackTotalSec;
  const firstEntry = timesheetEntry?.first_entry || fallbackFirstEntry?.event_time || null;
  const lastExit = timesheetEntry?.last_exit || fallbackLastExit?.event_time || null;

  if (loading) return <div className="ts-modal-events-empty">Загрузка...</div>;
  if (error) return <div className="ts-modal-events-empty">{error}</div>;
  if (events.length === 0) return <div className="ts-modal-events-empty">Нет событий СКУД за этот день</div>;

  return (
    <div className="ts-modal-events">
      <div className="ts-modal-events-list">
        {events.map(ev => {
          const isInternal = ev.access_point ? internalPoints.has(ev.access_point) : false;
          return (
            <div
              key={ev.id}
              className={`ts-modal-event-row ${ev.direction || ''} ${isInternal ? 'internal' : ''}`}
            >
              <span className="ts-modal-event-icon">
                {ev.direction === 'entry' ? <LogIn size={14} /> : <LogOut size={14} />}
              </span>
              <span className="ts-modal-event-time">{formatTime(ev.event_time)}</span>
              <span className="ts-modal-event-dir">
                {ev.direction === 'entry' ? 'Вход' : 'Выход'}
              </span>
              <span className="ts-modal-event-point">{ev.access_point || '—'}</span>
            </div>
          );
        })}
      </div>
      <div className="ts-modal-events-summary">
        {firstEntry && (
          <span className="skud-time-badge entry">
            <LogIn size={12} /> {formatTime(firstEntry)}
          </span>
        )}
        {lastExit && (
          <span className="skud-time-badge exit">
            <LogOut size={12} /> {formatTime(lastExit)}
          </span>
        )}
        {totalSec > 0 && (
          <span className="skud-time-badge duration">
            <Timer size={12} /> {formatDuration(totalSec)}
          </span>
        )}
      </div>
    </div>
  );
};

const CorrectionTab: FC<{
  onClose: () => void;
  onSave: (status: TimesheetStatus, hours: number | null, notes: string) => void;
  onDelete?: () => void;
  initialStatus: TimesheetStatus;
  initialHours: number;
  initialNotes?: string | null;
  confirmLabel?: string;
  deleteLabel?: string;
  allowedStatuses?: TimesheetStatus[];
}> = ({
  onClose,
  onSave,
  onDelete,
  initialStatus,
  initialHours,
  initialNotes,
  confirmLabel,
  deleteLabel,
  allowedStatuses,
}) => {
  const [selectedStatus, setSelectedStatus] = useState<TimesheetStatus>(initialStatus);
  const [hours, setHours] = useState<number>(initialHours);
  const [notes, setNotes] = useState(initialNotes || '');
  const statusOptions = TYPE_OPTIONS.filter(option => !allowedStatuses || allowedStatuses.includes(option.status));
  const showStatusPicker = statusOptions.length > 1;

  const handleSave = () => {
    const needsHours = HOURS_EDITABLE_STATUSES.has(selectedStatus);
    onSave(selectedStatus, needsHours ? hours : null, notes);
  };

  return (
    <>
      <div className="ts-modal-body">
        {showStatusPicker && (
          <div className="ts-form-group">
            <label className="ts-form-label">Тип записи</label>
            <div className="ts-type-options">
              {statusOptions.map(opt => (
                <button
                  key={opt.status}
                  type="button"
                  className={`ts-type-option ${selectedStatus === opt.status ? 'ts-type-option--selected' : ''}`}
                  onClick={() => setSelectedStatus(opt.status)}
                >
                  <div className="ts-type-option-icon">{opt.icon}</div>
                  <div className="ts-type-option-label">{opt.label}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {selectedStatus === 'remote' && (
          <div className="ts-hours-hint">Для удалёнки автоматически будет проставлен полный день по графику.</div>
        )}

        {HOURS_EDITABLE_STATUSES.has(selectedStatus) && (
          <div className="ts-form-group">
            <label className="ts-form-label">Часы</label>
            <input
              type="number"
              className="ts-form-input"
              value={hours}
              onChange={e => setHours(parseFloat(e.target.value) || 0)}
              min={0}
              max={24}
              step={0.5}
            />
            <span className="ts-hours-hint">{formatHM(hours)}</span>
          </div>
        )}

        <div className="ts-form-group">
          <label className="ts-form-label">Комментарий</label>
          <input
            type="text"
            className="ts-form-input"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Причина корректировки..."
          />
        </div>
      </div>
      <div className="ts-modal-footer">
        <button className="ts-btn" onClick={onClose}>Отмена</button>
        {onDelete && (
          <button className="ts-btn" onClick={onDelete}>{deleteLabel || 'Удалить'}</button>
        )}
        <button className="ts-btn ts-btn--primary" onClick={handleSave}>{confirmLabel || 'Сохранить'}</button>
      </div>
    </>
  );
};

const formatCorrectionDate = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const ModalContent: FC<Omit<ICorrectionModalProps, 'open'>> = ({
  onClose,
  onSave,
  initialStatus = 'work',
  initialHours = 8,
  title,
  subtitle,
  confirmLabel,
  dayLabel,
  employeeName,
  employeeId,
  workDate,
  hideCorrectionTab,
  hideSkudTab,
  allowedStatuses,
  customContent,
  customContentFooterLabel,
  timesheetEntry,
  correctionInfo,
  onDelete,
  initialNotes,
  deleteLabel,
}) => {
  const showEventsTab = !hideSkudTab;
  const showCorrectionTab = !hideCorrectionTab;
  const [tab, setTab] = useState<ModalTab>(() => {
    if (!showEventsTab && showCorrectionTab) return 'correction';
    return 'events';
  });
  const shortName = employeeName ? formatTimesheetEmployeeName(employeeName) : null;
  const headerTitle = title || dayLabel || 'День';
  const headerSubtitle = subtitle || shortName;

  if (customContent) {
    return (
      <div className="ts-modal" onClick={e => e.stopPropagation()}>
        <div className="ts-modal-header">
          <h3 className="ts-modal-title">
            {headerTitle}
            {headerSubtitle && (
              <div className="ts-modal-subtitle">{headerSubtitle}</div>
            )}
          </h3>
          <button className="ts-panel-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="ts-modal-body">
          {customContent}
        </div>
        <div className="ts-modal-footer">
          <button className="ts-btn ts-btn--primary" onClick={onClose}>
            {customContentFooterLabel || 'Закрыть'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ts-modal" onClick={e => e.stopPropagation()}>
      <div className="ts-modal-header">
        <h3 className="ts-modal-title">
          {headerTitle}
          {headerSubtitle && <div className="ts-modal-subtitle">{headerSubtitle}</div>}
        </h3>
        <button className="ts-panel-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      {correctionInfo?.is_correction && (
        <div className="ts-correction-info">
          <span className="ts-correction-info-icon">✎</span>
          Корректировка
          {correctionInfo.corrected_by_name && `: ${correctionInfo.corrected_by_name}`}
          {correctionInfo.corrected_at && `${correctionInfo.corrected_by_name ? ', ' : ': '}${formatCorrectionDate(correctionInfo.corrected_at)}`}
        </div>
      )}

      {showEventsTab && showCorrectionTab && (
        <div className="ts-modal-tabs">
          <button
            className={`ts-modal-tab ${tab === 'events' ? 'ts-modal-tab--active' : ''}`}
            onClick={() => setTab('events')}
          >
            События СКУД
          </button>
          <button
            className={`ts-modal-tab ${tab === 'correction' ? 'ts-modal-tab--active' : ''}`}
            onClick={() => setTab('correction')}
          >
            Корректировка
          </button>
        </div>
      )}

      {tab === 'events' && showEventsTab && employeeId && workDate ? (
        <div className="ts-modal-body">
          <EventsTab employeeId={employeeId} workDate={workDate} timesheetEntry={timesheetEntry} />
        </div>
      ) : tab === 'events' && showEventsTab ? (
        <div className="ts-modal-body">
          <div className="ts-modal-events-empty">Нет данных</div>
        </div>
      ) : showCorrectionTab ? (
        <CorrectionTab
          onClose={onClose}
          onSave={onSave}
          onDelete={onDelete}
          initialStatus={initialStatus}
          initialHours={initialHours ?? 8}
          initialNotes={initialNotes}
          confirmLabel={confirmLabel}
          deleteLabel={deleteLabel}
          allowedStatuses={allowedStatuses}
        />
      ) : null}
    </div>
  );
};

export const TimesheetCorrectionModal: FC<ICorrectionModalProps> = ({ open, ...rest }) =>
  open ? (
    <div
      className="ts-modal-overlay ts-modal-overlay--open"
      onClick={rest.onClose}
    >
      <ModalContent {...rest} />
    </div>
  ) : null;
