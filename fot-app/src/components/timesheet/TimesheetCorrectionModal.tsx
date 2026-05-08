import { type FC, type ReactNode, useState, useEffect, useCallback, useRef } from 'react';
import { X, LogIn, LogOut, Timer, Pencil, Trash2 } from 'lucide-react';
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
  sumBreakSeconds,
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
  { status: 'work',              icon: '✔',  label: 'Присутствие' },
  { status: 'remote',            icon: '🏠', label: 'Удалёнка' },
  { status: 'sick',              icon: '🏥', label: 'Больничный' },
  { status: 'vacation',          icon: '🏖', label: 'Отпуск' },
  { status: 'unpaid',            icon: '💸', label: 'За свой счёт' },
  { status: 'educational_leave', icon: '🎓', label: 'Учебный отпуск' },
  { status: 'absent',            icon: '❌', label: 'Неявка' },
];

const LEGACY_TYPE_OPTIONS: Record<string, ITypeOption> = {
  dayoff: { status: 'dayoff', icon: '📅', label: 'Отгул' },
  manual: { status: 'manual', icon: '✏️', label: 'Ручная корр.' },
};

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
  const breakSec = sumBreakSeconds(displayItems);
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
          // В корректировке табеля показываются только успешные проходы.
          if (item.kind === 'failure') return null;
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
              <span className={`ts-modal-event-pair-duration${pairDurationSeconds && pairDurationSeconds > 0 ? '' : ' ts-modal-event-pair-duration--empty'}`}>
                {pairDurationSeconds && pairDurationSeconds > 0 ? formatDuration(pairDurationSeconds) : ''}
              </span>
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
        {breakSec > 0 && (
          <span className="skud-time-badge break" title="Сумма перерывов">
            <Timer size={12} /> Перерывы: {formatDuration(breakSec)}
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
  correctionInfo?: {
    is_correction: boolean;
    corrected_at?: string | null;
    corrected_by_name?: string | null;
  } | null;
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
  correctionInfo,
}) => {
  const hasExistingCorrection = Boolean(correctionInfo?.is_correction);
  const [mode, setMode] = useState<'view' | 'edit'>(hasExistingCorrection ? 'view' : 'edit');
  const [selectedStatus, setSelectedStatus] = useState<TimesheetStatus>(initialStatus);
  const [hours, setHours] = useState<number>(initialHours);
  const [notes, setNotes] = useState(initialNotes || '');
  const statusOptions = TYPE_OPTIONS.filter(option => !allowedStatuses || allowedStatuses.includes(option.status));
  const showStatusPicker = statusOptions.length > 1;

  const trimmedNotes = notes.trim();
  const needsHoursForStatus = HOURS_EDITABLE_STATUSES.has(selectedStatus);
  const exceedsMax = needsHoursForStatus && maxHours != null && hours > maxHours;
  const canSave = trimmedNotes.length > 0 && !exceedsMax;

  const handleSave = () => {
    if (!canSave) return;
    onSave(selectedStatus, needsHoursForStatus ? hours : null, trimmedNotes);
  };

  if (mode === 'view' && hasExistingCorrection) {
    const statusOption = TYPE_OPTIONS.find(option => option.status === initialStatus) ?? LEGACY_TYPE_OPTIONS[initialStatus];
    const statusLabel = statusOption?.label ?? initialStatus;
    const statusIcon = statusOption?.icon ?? '✎';
    const hoursLabel = HOURS_EDITABLE_STATUSES.has(initialStatus)
      ? formatHM(initialHours)
      : '—';
    const authorLine = [
      correctionInfo?.corrected_by_name ?? null,
      correctionInfo?.corrected_at ? formatCorrectionDate(correctionInfo.corrected_at) : null,
    ].filter(Boolean).join(' • ');
    const tooltip = [
      `${statusLabel} · ${hoursLabel}`,
      authorLine || null,
    ].filter(Boolean).join('\n');
    const trimmedInitialNotes = initialNotes?.trim();
    return (
      <>
        <div className="ts-modal-body">
          <div className="ts-correction-view-row" title={tooltip}>
            <span className="ts-correction-view-row__icon">{statusIcon}</span>
            <span className="ts-correction-view-row__text">
              {statusLabel} · <b>{hoursLabel}</b>
            </span>
            <span className="ts-correction-view-row__actions">
              <button
                type="button"
                className="ts-corrections-btn"
                onClick={() => setMode('edit')}
                aria-label="Изменить корректировку"
                title="Изменить"
              >
                <Pencil size={14} />
              </button>
              {onDelete && (
                <button
                  type="button"
                  className="ts-corrections-btn ts-corrections-btn--danger"
                  onClick={onDelete}
                  aria-label="Удалить корректировку"
                  title={deleteLabel || 'Удалить'}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </span>
          </div>
          {trimmedInitialNotes && (
            <div className="ts-correction-view-comment">{trimmedInitialNotes}</div>
          )}
        </div>
        <div className="ts-modal-footer">
          <button className="ts-btn" onClick={onClose} type="button">Закрыть</button>
        </div>
      </>
    );
  }

  return (
    <form onSubmit={e => { e.preventDefault(); handleSave(); }}>
      <div className="ts-modal-body">
        {showStatusPicker && (
          <div className="ts-form-group">
            <label className="ts-form-label">Тип записи</label>
            <select
              className="ts-form-select"
              value={selectedStatus}
              onChange={e => setSelectedStatus(e.target.value as TimesheetStatus)}
            >
              {statusOptions.map(opt => (
                <option key={opt.status} value={opt.status}>{opt.icon} {opt.label}</option>
              ))}
            </select>
          </div>
        )}

        {selectedStatus === 'remote' && (
          <div className="ts-hours-hint">Для удалёнки автоматически будет проставлен полный день по графику.</div>
        )}

        {HOURS_EDITABLE_STATUSES.has(selectedStatus) && (() => {
          const wholeHours = Math.floor(hours);
          const minutes = Math.round((hours - wholeHours) * 60);
          const applyHM = (h: number, m: number) => {
            const clampedM = Math.max(0, Math.min(59, m));
            const clampedH = Math.max(0, h);
            setHours(clampedH + clampedM / 60);
          };
          return (
            <div className="ts-form-group">
              <label className="ts-form-label">Часы</label>
              <div className="ts-hours-inputs">
                <input
                  type="number"
                  className="ts-form-input ts-form-input--hm"
                  value={wholeHours}
                  onChange={e => applyHM(parseInt(e.target.value, 10) || 0, minutes)}
                  min={0}
                  max={24}
                />
                <span className="ts-hours-separator">ч</span>
                <input
                  type="number"
                  className="ts-form-input ts-form-input--hm"
                  value={minutes}
                  onChange={e => applyHM(wholeHours, parseInt(e.target.value, 10) || 0)}
                  min={0}
                  max={59}
                />
                <span className="ts-hours-separator">м</span>
              </div>
              {maxHours != null && !exceedsMax && (
                <span className="ts-hours-hint">Максимум по смене {formatHM(maxHours)}</span>
              )}
              {exceedsMax && maxHours != null && (
                <span className="ts-form-hint ts-form-hint--error">
                  Превышает длительность смены ({formatHM(maxHours)})
                </span>
              )}
            </div>
          );
        })()}

        <div className="ts-form-group">
          <label className="ts-form-label">Комментарий <span className="ts-form-required">*</span></label>
          <input
            type="text"
            className="ts-form-input"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Причина корректировки..."
            required
          />
          {trimmedNotes.length === 0 && (
            <span className="ts-form-hint ts-form-hint--error">Комментарий обязателен для сохранения</span>
          )}
        </div>
      </div>
      <div className="ts-modal-footer">
        <button
          className="ts-btn"
          onClick={() => (hasExistingCorrection ? setMode('view') : onClose())}
          type="button"
        >
          Отмена
        </button>
        <button
          className="ts-btn ts-btn--primary"
          type="submit"
          disabled={!canSave}
          title={
            exceedsMax && maxHours != null
              ? `Часы превышают длительность смены (${formatHM(maxHours)})`
              : (canSave ? undefined : 'Заполните комментарий')
          }
        >
          {confirmLabel || 'Сохранить'}
        </button>
      </div>
    </form>
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
    if (showCorrectionTab && correctionInfo?.is_correction) return 'correction';
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

      {correctionInfo?.is_correction && (correctionInfo.corrected_by_name || correctionInfo.corrected_at) && (
        <div className="ts-correction-info">
          <span className="ts-correction-info-icon">✎</span>
          {correctionInfo.corrected_by_name}
          {correctionInfo.corrected_by_name && correctionInfo.corrected_at && ', '}
          {correctionInfo.corrected_at && formatCorrectionDate(correctionInfo.corrected_at)}
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
          correctionInfo={correctionInfo}
        />
      ) : null}
    </div>
  );
};

export const TimesheetCorrectionModal: FC<ICorrectionModalProps> = ({ open, ...rest }) => {
  const overlayMouseDownRef = useRef(false);
  if (!open) return null;
  return (
    <div
      className="ts-modal-overlay ts-modal-overlay--open"
      onMouseDown={e => {
        overlayMouseDownRef.current = e.target === e.currentTarget;
      }}
      onMouseUp={e => {
        if (overlayMouseDownRef.current && e.target === e.currentTarget) {
          rest.onClose();
        }
        overlayMouseDownRef.current = false;
      }}
    >
      <ModalContent {...rest} />
    </div>
  );
};
