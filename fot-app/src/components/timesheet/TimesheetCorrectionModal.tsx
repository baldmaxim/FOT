import { type FC, type ReactNode, useState, useEffect, useCallback } from 'react';
import { X, LogIn, LogOut, Timer } from 'lucide-react';
import type { TimesheetEntry, TimesheetStatus, SkudEvent } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useAccessPointMapViewer } from '../../hooks/useAccessPointMapViewer';
import { skudService } from '../../services/skudService';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import {
  buildDisplayItems,
  calculateWorkSeconds,
  findFirstExternalEntry,
  findLastExternalExit,
} from '../../utils/skudDisplay';
import { AccessPointTrigger } from '../skud/AccessPointTrigger';

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
  allowAccessPointMap?: boolean;
  allowedStatuses?: TimesheetStatus[];
  customContent?: ReactNode;
  customContentFooterLabel?: string;
  timesheetEntry?: Pick<TimesheetEntry, 'first_entry' | 'last_exit' | 'hours_worked' | 'display_hours_worked'> | null;
  maxHours?: number | null;
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
  allowAccessPointMap?: boolean;
  timesheetEntry?: Pick<TimesheetEntry, 'first_entry' | 'last_exit' | 'hours_worked' | 'display_hours_worked'> | null;
}> = ({ employeeId, workDate, allowAccessPointMap = false, timesheetEntry }) => {
  const { canViewPage } = useAuth();
  const {
    canOpenAccessPointMap,
    openAccessPointMap,
    accessPointMapModal,
  } = useAccessPointMapViewer(allowAccessPointMap && canViewPage('/skud-settings'));
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

  const displayItems = buildDisplayItems(events, internalPoints, workDate);
  const fallbackTotalSec = calculateWorkSeconds(events, internalPoints, workDate);
  const fallbackFirstEntry = findFirstExternalEntry(events, internalPoints);
  const fallbackLastExit = findLastExternalExit(events, internalPoints);
  const visibleHours = timesheetEntry?.display_hours_worked ?? timesheetEntry?.hours_worked ?? null;
  const totalSec = visibleHours != null
    ? Math.max(0, Math.round(visibleHours * 3600))
    : fallbackTotalSec;
  const firstEntry = timesheetEntry?.first_entry || fallbackFirstEntry?.event_time || null;
  const lastExit = timesheetEntry?.last_exit || fallbackLastExit?.event_time || null;

  if (loading) return <div className="ts-modal-events-empty">Загрузка...</div>;
  if (error) return <div className="ts-modal-events-empty">{error}</div>;
  if (events.length === 0) return <div className="ts-modal-events-empty">Нет событий СКУД за этот день</div>;

  return (
    <div className="ts-modal-events">
      <div className="ts-modal-events-list">
        {displayItems.map((item, idx) => {
          if (item.kind === 'break') {
            return (
              <div key={`break-${idx}`} className="ts-modal-event-row ts-modal-event-row--break">
                <span className="ts-modal-event-break-label">
                  Перерыв: {formatDuration(item.breakSeconds)}
                </span>
              </div>
            );
          }
          const { event: ev, pairDurationSeconds, isInternal } = item;
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
              {ev.access_point ? (
                <AccessPointTrigger
                  accessPointName={ev.access_point}
                  className="ts-modal-event-point"
                  canOpen={canOpenAccessPointMap}
                  onOpen={openAccessPointMap}
                />
              ) : (
                <span className="ts-modal-event-point">—</span>
              )}
              {pairDurationSeconds !== null && pairDurationSeconds > 0 && (
                <span className="ts-modal-event-pair-duration">{formatDuration(pairDurationSeconds)}</span>
              )}
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
      {accessPointMapModal}
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
  maxHours?: number | null;
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
  maxHours,
}) => {
  const [selectedStatus, setSelectedStatus] = useState<TimesheetStatus>(initialStatus);
  const [hours, setHours] = useState<number>(initialHours);
  const [notes, setNotes] = useState(initialNotes || '');
  const statusOptions = TYPE_OPTIONS.filter(option => !allowedStatuses || allowedStatuses.includes(option.status));
  const showStatusPicker = statusOptions.length > 1;

  const handleSave = () => {
    const needsHours = HOURS_EDITABLE_STATUSES.has(selectedStatus);
    const normalizedHours = needsHours && maxHours != null
      ? Math.max(0, Math.min(hours, maxHours))
      : hours;
    onSave(selectedStatus, needsHours ? normalizedHours : null, notes);
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
              onChange={e => {
                const nextValue = parseFloat(e.target.value) || 0;
                setHours(maxHours != null ? Math.max(0, Math.min(nextValue, maxHours)) : nextValue);
              }}
              min={0}
              max={maxHours ?? 24}
              step={0.5}
            />
            <span className="ts-hours-hint">
              {formatHM(hours)}
              {maxHours != null ? ` • максимум по графику ${formatHM(maxHours)}` : ''}
            </span>
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
  allowAccessPointMap = false,
  allowedStatuses,
  customContent,
  customContentFooterLabel,
  timesheetEntry,
  correctionInfo,
  onDelete,
  initialNotes,
  deleteLabel,
  maxHours,
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
          <EventsTab
            employeeId={employeeId}
            workDate={workDate}
            allowAccessPointMap={allowAccessPointMap}
            timesheetEntry={timesheetEntry}
          />
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
          maxHours={maxHours}
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
