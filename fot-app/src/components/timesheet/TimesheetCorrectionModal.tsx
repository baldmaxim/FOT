import { type FC, useState, useEffect, useCallback } from 'react';
import { X, LogIn, LogOut, Timer } from 'lucide-react';
import type { TimesheetStatus, SkudEvent } from '../../types';
import { skudService } from '../../services/skudService';

interface ICorrectionModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (status: TimesheetStatus, hours: number | null, notes: string) => void;
  initialStatus?: TimesheetStatus;
  initialHours?: number | null;
  dayLabel?: string;
  employeeId?: number;
  workDate?: string;
}

interface ITypeOption {
  status: TimesheetStatus;
  icon: string;
  label: string;
}

type ModalTab = 'events' | 'correction';

const formatHM = (decimal: number): string => {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

const formatTime = (time: string): string => time.slice(0, 5);

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
  { status: 'work', icon: '✓', label: 'Присутствие' },
  { status: 'sick', icon: '🏥', label: 'Больничный' },
  { status: 'vacation', icon: '🏖', label: 'Отпуск' },
  { status: 'business_trip', icon: '✈️', label: 'Командировка' },
  { status: 'absent', icon: '❌', label: 'Прогул' },
  { status: 'manual', icon: '✏️', label: 'Ручная корр.' },
];

const EventsTab: FC<{ employeeId: number; workDate: string }> = ({ employeeId, workDate }) => {
  const [events, setEvents] = useState<SkudEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [internalPoints, setInternalPoints] = useState<Set<string>>(new Set());

  useEffect(() => {
    skudService.getAccessPointSettings().then(settings => {
      setInternalPoints(new Set(settings.filter(s => s.is_internal).map(s => s.access_point_name.trim())));
    }).catch(() => {});
  }, []);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await skudService.getEmployeeEvents(employeeId, workDate, workDate);
      data.sort((a, b) => a.event_time.localeCompare(b.event_time));
      setEvents(data);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [employeeId, workDate]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // Calculate summary
  const extEvents = events.filter(e => !e.access_point || !internalPoints.has(e.access_point));
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
    return total;
  };
  let totalSec = calcPairs(extEvents);
  if (totalSec === 0 && events.length > 0) totalSec = calcPairs(events);

  const srcEvents = (calcPairs(extEvents) > 0 ? extEvents : events);
  const firstEntry = srcEvents.find(e => e.direction === 'entry');
  const lastExit = [...srcEvents].reverse().find(e => e.direction === 'exit');

  if (loading) return <div className="ts-modal-events-empty">Загрузка...</div>;
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
            <LogIn size={12} /> {formatTime(firstEntry.event_time)}
          </span>
        )}
        {lastExit && (
          <span className="skud-time-badge exit">
            <LogOut size={12} /> {formatTime(lastExit.event_time)}
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
  initialStatus: TimesheetStatus;
  initialHours: number;
}> = ({ onClose, onSave, initialStatus, initialHours }) => {
  const [selectedStatus, setSelectedStatus] = useState<TimesheetStatus>(initialStatus);
  const [hours, setHours] = useState<number>(initialHours);
  const [notes, setNotes] = useState('');

  const handleSave = () => {
    const needsHours = selectedStatus === 'work' || selectedStatus === 'manual';
    onSave(selectedStatus, needsHours ? hours : null, notes);
  };

  return (
    <>
      <div className="ts-modal-body">
        <div className="ts-form-group">
          <label className="ts-form-label">Тип записи</label>
          <div className="ts-type-options">
            {TYPE_OPTIONS.map(opt => (
              <div
                key={opt.status}
                className={`ts-type-option ${selectedStatus === opt.status ? 'ts-type-option--selected' : ''}`}
                onClick={() => setSelectedStatus(opt.status)}
              >
                <div className="ts-type-option-icon">{opt.icon}</div>
                <div className="ts-type-option-label">{opt.label}</div>
              </div>
            ))}
          </div>
        </div>

        {(selectedStatus === 'work' || selectedStatus === 'manual') && (
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
        <button className="ts-btn ts-btn--primary" onClick={handleSave}>Сохранить</button>
      </div>
    </>
  );
};

const ModalContent: FC<Omit<ICorrectionModalProps, 'open'>> = ({
  onClose,
  onSave,
  initialStatus = 'work',
  initialHours = 8,
  dayLabel,
  employeeId,
  workDate,
}) => {
  const [tab, setTab] = useState<ModalTab>('events');

  return (
    <div className="ts-modal" onClick={e => e.stopPropagation()}>
      <div className="ts-modal-header">
        <h3 className="ts-modal-title">
          {dayLabel || 'День'}
        </h3>
        <button className="ts-panel-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

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

      {tab === 'events' && employeeId && workDate ? (
        <div className="ts-modal-body">
          <EventsTab employeeId={employeeId} workDate={workDate} />
        </div>
      ) : tab === 'events' ? (
        <div className="ts-modal-body">
          <div className="ts-modal-events-empty">Нет данных</div>
        </div>
      ) : (
        <CorrectionTab
          onClose={onClose}
          onSave={onSave}
          initialStatus={initialStatus}
          initialHours={initialHours ?? 8}
        />
      )}
    </div>
  );
};

export const TimesheetCorrectionModal: FC<ICorrectionModalProps> = ({ open, ...rest }) => (
  <div
    className={`ts-modal-overlay ${open ? 'ts-modal-overlay--open' : ''}`}
    onClick={rest.onClose}
  >
    {open && <ModalContent {...rest} />}
  </div>
);
