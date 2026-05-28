import { type FC, type ReactNode, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, LogIn, LogOut, Timer, Pencil, Trash2, Check, XCircle } from 'lucide-react';
import type { TimesheetEntry, TimesheetObjectEntry, TimesheetStatus, SkudEvent, SkudEventFailure } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useAccessPointMapViewer } from '../../hooks/useAccessPointMapViewer';
import { skudService } from '../../services/skudService';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import { CorrectionApprovalBadge } from './CorrectionApprovalBadge';
import { CorrectionAttachments } from './CorrectionAttachments';
import {
  buildDisplayItems,
  calculateWorkSeconds,
  findFirstExternalEntry,
  findLastExternalExit,
  mergeFailuresIntoDisplay,
  sumBreakSeconds,
} from '../../utils/skudDisplay';
import { formatFailureType } from '../../utils/skudFailureTypes';
import { AccessPointTrigger } from '../skud/AccessPointTrigger';
import { getDayStatus, STATUS_LABEL_RU, STATUS_TO_DETAIL_HOURS_CLASS } from '../../utils/dayStatus';

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
  timesheetEntry?: TimesheetEntry | null;
  maxHours?: number | null;
  // Информационная плашка под шапкой (например, «часы заданы корректировкой по объекту»).
  // Рендерится только в режиме корректировки и только если строка непустая.
  infoBanner?: ReactNode;
  correctionInfo?: {
    is_correction: boolean;
    corrected_at?: string | null;
    corrected_by_name?: string | null;
    approved_at?: string | null;
    approved_by_name?: string | null;
    approval_comment?: string | null;
    adjustment_id?: number | null;
  } | null;
  // Открытие из «По объектам» — какой объект подсветить/раскрыть справа.
  preselectedObjectKey?: string | null;
  // Контекст дня для рендера чипа со статусом в шапке. Если не передан — чип не рисуется.
  // Прокидывает родитель: те же значения, что считают TimesheetGrid и TimesheetSidePanel
  // через scheduleUtils, чтобы цвет/подпись совпадали с табелем и боковой панелью.
  dayStatusContext?: {
    isScheduledDayOff: boolean;
    isPreHoliday: boolean;
    fullDayThresholdHours: number;
    showActualHours: boolean;
  };
  // Список объектов дня (из СКУД + per-object корректировки). Передаётся только в day-mode;
  // если непуст, под формой «День» рендерится список блоков по объектам.
  objectEntries?: TimesheetObjectEntry[];
  // План часов дня по графику — для суммирующего чипа (Σ корректировок / план).
  plannedHours?: number | null;
  // Есть ли активная day-level корректировка — используется для confirm-диалога:
  // сохранение по-объектной корректировки её снимет (по правилу взаимоисключения на бэке).
  hasDayLevelCorrection?: boolean;
  // Сохранение/удаление корректировки по конкретному объекту.
  onSaveObject?: (target: { object_key: string; object_id: string | null; object_name: string }, hours: number, notes: string) => void;
  onDeleteObject?: (target: { object_key: string; object_id: string | null; object_name: string }) => void;
  // Явное обнуление дня (status='work', hours=0) — единственная точка входа к day-level
  // корректировке, когда CorrectionTab скрыт из-за объектных СКУД-записей.
  onZeroOutDay?: (notes: string) => void;
  // Стартовый режим внутреннего CorrectionTab/ObjectCorrectionsList. 'edit' принудительно
  // открывает форму редактирования; по умолчанию — 'view' для существующих корректировок,
  // 'edit' для новых. Используется из TimesheetCorrectionsList («✏ Скорректировать»).
  initialMode?: 'view' | 'edit';
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
  { status: 'work',              icon: '✔',  label: 'Работа' },
  { status: 'remote',            icon: '🏠', label: 'Удалёнка' },
  { status: 'sick',              icon: '🏥', label: 'Больничный' },
  { status: 'vacation',          icon: '🏖', label: 'Отпуск' },
  { status: 'unpaid',            icon: '💸', label: 'За свой счёт' },
  { status: 'educational_leave', icon: '🎓', label: 'Учебный отпуск' },
  { status: 'absent',            icon: '❌', label: 'Неявка' },
];

// manual — work, прицепленная к СКУД-объекту: показываем как «Работа», не «Ручная корр.».
const LEGACY_TYPE_OPTIONS: Record<string, ITypeOption> = {
  dayoff: { status: 'dayoff', icon: '📅', label: 'Отгул' },
  manual: { status: 'manual', icon: '✔', label: 'Работа' },
};

const EventsTab: FC<{
  employeeId: number;
  workDate: string;
  allowAccessPointMap?: boolean;
  timesheetEntry?: Pick<TimesheetEntry, 'first_entry' | 'last_exit' | 'hours_worked' | 'display_hours_worked'> | null;
}> = ({ employeeId, workDate, allowAccessPointMap = false, timesheetEntry }) => {
  const { canViewPage, showActualHours } = useAuth();
  const {
    canOpenAccessPointMap,
    openAccessPointMap,
    accessPointMapModal,
  } = useAccessPointMapViewer(allowAccessPointMap && canViewPage('/skud-settings'));
  const [events, setEvents] = useState<SkudEvent[]>([]);
  const [failures, setFailures] = useState<SkudEventFailure[]>([]);
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
      const { events: data, failures: dayFailures } = await skudService.getEmployeeEventsWithFailures(
        employeeId, workDate, workDate,
      );
      data.sort((a, b) => a.event_time.localeCompare(b.event_time));
      dayFailures.sort((a, b) => a.event_time.localeCompare(b.event_time));
      setEvents(data);
      setFailures(dayFailures);
    } catch (err) {
      setEvents([]);
      setFailures([]);
      setError(err instanceof Error ? err.message : 'Не удалось загрузить события СКУД');
    } finally {
      setLoading(false);
    }
  }, [employeeId, workDate]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // failures вставляются в timeline, но в расчёт totalSec/firstEntry/lastExit/breakSec
  // не идут — они работают только на success-событиях (events).
  const displayItems = mergeFailuresIntoDisplay(
    buildDisplayItems(events, internalPoints, workDate),
    failures,
  );
  const fallbackTotalSec = calculateWorkSeconds(events, internalPoints, workDate);
  const fallbackFirstEntry = findFirstExternalEntry(events, internalPoints);
  const fallbackLastExit = findLastExternalExit(events, internalPoints);
  // Уважаем per-role флаг show_actual_hours (system_roles.show_actual_hours,
  // миграция 077): админ с флагом «факт» видит hours_worked, остальные —
  // display_hours_worked (урезано под план). Раньше здесь был хардкод на
  // display_hours_worked → нижний бейдж модалки рассинхрон с табелем и боковой
  // панелью, где уже используется selectVisibleHours.
  // Inline (а не selectVisibleHours) — у нас Pick<>, а не полный TimesheetEntry.
  const visibleHours = timesheetEntry
    ? (showActualHours
        ? timesheetEntry.hours_worked ?? timesheetEntry.display_hours_worked ?? null
        : timesheetEntry.display_hours_worked ?? timesheetEntry.hours_worked ?? null)
    : null;
  const totalSec = visibleHours != null
    ? Math.max(0, Math.round(visibleHours * 3600))
    : fallbackTotalSec;
  const breakSec = sumBreakSeconds(displayItems);
  const firstEntry = timesheetEntry?.first_entry || fallbackFirstEntry?.event_time || null;
  const lastExit = timesheetEntry?.last_exit || fallbackLastExit?.event_time || null;

  if (loading) return <div className="ts-modal-events-empty">Загрузка...</div>;
  if (error) return <div className="ts-modal-events-empty">{error}</div>;
  if (events.length === 0 && failures.length === 0) return <div className="ts-modal-events-empty">Нет событий СКУД за этот день</div>;

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
          if (item.kind === 'failure') {
            const f = item.failure;
            return (
              <div
                key={`failure-${f.id}`}
                className="ts-modal-event-row ts-modal-event-row--failure"
                title={f.reason || ''}
              >
                <span className="event-status-mark event-status-mark--failure" aria-label="Не учитывается">
                  <XCircle size={14} />
                </span>
                <span className="ts-modal-event-time">{formatTime(f.event_time)}</span>
                <span className="ts-modal-event-failure-badge" title={f.failure_type}>{formatFailureType(f.failure_type)}</span>
                {f.access_point ? (
                  <AccessPointTrigger
                    accessPointName={f.access_point}
                    className="ts-modal-event-point"
                    canOpen={canOpenAccessPointMap}
                    onOpen={openAccessPointMap}
                  />
                ) : (
                  <span className="ts-modal-event-point">—</span>
                )}
                {f.reason && <span className="ts-modal-event-failure-reason">{f.reason}</span>}
              </div>
            );
          }
          const { event: ev, pairDurationSeconds, isInternal } = item;
          return (
            <div
              key={ev.id}
              className={`ts-modal-event-row ${ev.direction || ''} ${isInternal ? 'internal' : ''}`}
            >
              {!isInternal && (
                <span className="event-status-mark event-status-mark--success" aria-label="Учтено">
                  <Check size={12} />
                </span>
              )}
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
    approved_at?: string | null;
    approved_by_name?: string | null;
    approval_comment?: string | null;
    adjustment_id?: number | null;
  } | null;
  initialMode?: 'view' | 'edit';
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
  initialMode,
}) => {
  const hasExistingCorrection = Boolean(correctionInfo?.is_correction);
  const [mode, setMode] = useState<'view' | 'edit'>(
    initialMode ?? (hasExistingCorrection ? 'view' : 'edit'),
  );
  const statusOptions = TYPE_OPTIONS.filter(option => !allowedStatuses || allowedStatuses.includes(option.status));
  // initialStatus может прийти из display_status бэка (dayoff/holiday/manual) — таких опций
  // в <select> нет, и без fallback state остаётся «невалидным»: визуально выбран первый
  // option, но onChange не вызвался, и при сохранении уйдёт несовместимый со схемой статус.
  // Fallback гарантирует, что selectedStatus всегда есть среди statusOptions.
  const resolveValidStatus = (candidate: TimesheetStatus): TimesheetStatus => (
    statusOptions.some(option => option.status === candidate)
      ? candidate
      : statusOptions[0]?.status ?? 'work'
  );
  const [selectedStatus, setSelectedStatus] = useState<TimesheetStatus>(() => resolveValidStatus(initialStatus));
  useEffect(() => {
    setSelectedStatus(prev => resolveValidStatus(prev));
    // statusOptions пересчитывается каждый рендер из allowedStatuses — отслеживаем именно его.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedStatuses?.join('|')]);
  const [hours, setHours] = useState<number>(initialHours);
  const [notes, setNotes] = useState(initialNotes || '');
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
    const approvedLine = correctionInfo?.approved_at
      ? `Согласовано: ${formatCorrectionDate(correctionInfo.approved_at)}${correctionInfo.approved_by_name ? ` (${correctionInfo.approved_by_name})` : ''}`
      : null;
    const authorLine = [
      correctionInfo?.corrected_by_name ?? null,
      correctionInfo?.corrected_at ? formatCorrectionDate(correctionInfo.corrected_at) : null,
      approvedLine,
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

interface IObjectRowState {
  hours: number;
  notes: string;
}

interface IObjectCorrectionsListProps {
  objectEntries: TimesheetObjectEntry[];
  hasDayLevelCorrection: boolean;
  // Сводка day-level корректировки (часы + комментарий) — рисуем сверху,
  // если у дня есть и day-level и объекты: иначе кнопку «Снять» нечем дать.
  dayLevelSummary?: { hours: number; notes: string } | null;
  onDeleteDayLevel?: () => void;
  plannedHours?: number | null;
  onSaveObject: (target: { object_key: string; object_id: string | null; object_name: string }, hours: number, notes: string) => void;
  onDeleteObject: (target: { object_key: string; object_id: string | null; object_name: string }) => void;
  // Когда day-level корректировки нет, но у дня есть объектные СКУД-записи —
  // даём явный путь «не работал»: создаёт day-level 0ч (бэк снимет manual_object).
  onZeroOutDay?: (notes: string) => void;
  // Открытие из «По объектам» — этот ключ сразу раскрыт в edit-режиме (если
  // корректировка по нему уже есть) либо открывает форму создания для него.
  preselectedObjectKey?: string | null;
  // Из TimesheetCorrectionsList («Скорректировать»): открыть preselected
  // сразу в редактируемом режиме.
  initialMode?: 'view' | 'edit';
}

const ObjectCorrectionsList: FC<IObjectCorrectionsListProps> = ({
  objectEntries,
  hasDayLevelCorrection,
  dayLevelSummary,
  onDeleteDayLevel,
  plannedHours,
  onSaveObject,
  onDeleteObject,
  onZeroOutDay,
  preselectedObjectKey,
  initialMode,
}) => {
  // Показываем в списке ТОЛЬКО реальные корректировки (запись в
  // attendance_adjustments). «Фактовые» строки по СКУД — отфильтрованы,
  // иначе пустые объекты с 0/часовыми часами выглядели как «фантомы».
  const correctedEntries = useMemo(
    () => objectEntries.filter(e => e.is_correction && e.adjustment_id != null),
    [objectEntries],
  );
  // Объекты, доступные для НОВОЙ корректировки = те, у которых сейчас НЕТ
  // корректировки. Это и СКУД-факт-строки, и приписанные объекты без СКУД.
  const availableForAdd = useMemo(
    () => objectEntries.filter(e => !(e.is_correction && e.adjustment_id != null)),
    [objectEntries],
  );

  const initState = useCallback((): Record<string, IObjectRowState> => {
    const map: Record<string, IObjectRowState> = {};
    for (const entry of objectEntries) {
      map[entry.object_key] = {
        hours: Number(entry.display_hours_worked ?? entry.hours_worked ?? 0),
        notes: entry.notes ?? '',
      };
    }
    return map;
  }, [objectEntries]);

  const [rowState, setRowState] = useState<Record<string, IObjectRowState>>(initState);
  useEffect(() => {
    setRowState(initState());
  }, [initState]);

  // expanded — для уже существующих corrected: какие из них сейчас в edit-режиме.
  // По умолчанию все compacted; preselectedObjectKey + initialMode='edit' → raise.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (preselectedObjectKey && initialMode === 'edit') initial.add(preselectedObjectKey);
    return initial;
  });
  useEffect(() => {
    if (preselectedObjectKey && initialMode === 'edit') {
      setExpanded(prev => {
        if (prev.has(preselectedObjectKey)) return prev;
        const next = new Set(prev);
        next.add(preselectedObjectKey);
        return next;
      });
    }
  }, [preselectedObjectKey, initialMode]);
  const toggleExpanded = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Добавление новой корректировки через «+»: меню выбора объекта /
  // «обнулить день», затем inline-форма для выбранного варианта.
  type AddTarget =
    | { kind: 'object'; entry: TimesheetObjectEntry }
    | { kind: 'zero-out' }
    | null;
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addTarget, setAddTarget] = useState<AddTarget>(null);
  const [newRow, setNewRow] = useState<IObjectRowState>({ hours: 0, notes: '' });

  // Если приехал preselected, по которому нет корректировки — сразу открыть
  // форму создания для него (без меню).
  useEffect(() => {
    if (!preselectedObjectKey) return;
    const existing = correctedEntries.some(e => e.object_key === preselectedObjectKey);
    if (existing) return;
    const candidate = objectEntries.find(e => e.object_key === preselectedObjectKey);
    if (!candidate) return;
    setAddTarget({ kind: 'object', entry: candidate });
    setNewRow({ hours: 0, notes: '' });
  }, [preselectedObjectKey, correctedEntries, objectEntries]);

  const openAddObject = (entry: TimesheetObjectEntry) => {
    setAddMenuOpen(false);
    setAddTarget({ kind: 'object', entry });
    setNewRow({ hours: 0, notes: '' });
  };
  const openZeroOut = () => {
    setAddMenuOpen(false);
    setAddTarget({ kind: 'zero-out' });
    setNewRow({ hours: 0, notes: '' });
  };
  const cancelAdd = () => {
    setAddTarget(null);
    setNewRow({ hours: 0, notes: '' });
  };

  // Сумма берётся из текущего состояния — для подсчёта берём только
  // сохранённые корректировки + (если есть) форму создания.
  const totalHours = correctedEntries.reduce(
    (sum, e) => sum + Number(e.display_hours_worked ?? e.hours_worked ?? 0),
    0,
  ) + (addTarget?.kind === 'object' ? (newRow.hours || 0) : 0);
  const planned = plannedHours ?? null;
  const exceedsPlanned = planned != null && totalHours > planned + 0.001;

  const handleHoursChange = (key: string, hours: number) => {
    setRowState(prev => ({ ...prev, [key]: { ...(prev[key] ?? { hours: 0, notes: '' }), hours } }));
  };
  const handleNotesChange = (key: string, notes: string) => {
    setRowState(prev => ({ ...prev, [key]: { ...(prev[key] ?? { hours: 0, notes: '' }), notes } }));
  };
  const handleSave = (entry: TimesheetObjectEntry) => {
    const state = rowState[entry.object_key];
    if (!state) return;
    if (state.hours <= 0) {
      if (entry.adjustment_id == null || !entry.is_correction) return;
      handleDelete(entry);
      return;
    }
    const trimmedNotes = state.notes.trim();
    if (trimmedNotes.length === 0) return;
    if (hasDayLevelCorrection && !window.confirm(
      'Сохранение корректировки по объекту снимет общую корректировку дня. Продолжить?',
    )) {
      return;
    }
    onSaveObject(
      { object_key: entry.object_key, object_id: entry.object_id, object_name: entry.object_name },
      state.hours,
      trimmedNotes,
    );
  };
  const handleSaveNew = () => {
    if (addTarget?.kind !== 'object') return;
    const entry = addTarget.entry;
    if (newRow.hours <= 0) return;
    const trimmedNotes = newRow.notes.trim();
    if (trimmedNotes.length === 0) return;
    if (hasDayLevelCorrection && !window.confirm(
      'Сохранение корректировки по объекту снимет общую корректировку дня. Продолжить?',
    )) return;
    onSaveObject(
      { object_key: entry.object_key, object_id: entry.object_id, object_name: entry.object_name },
      newRow.hours,
      trimmedNotes,
    );
    cancelAdd();
  };
  const handleConfirmZeroOut = () => {
    const notes = newRow.notes.trim();
    if (notes.length === 0 || !onZeroOutDay) return;
    if (correctedEntries.length > 0 && !window.confirm(
      'Обнуление дня снимет все корректировки по объектам за этот день. Продолжить?',
    )) return;
    onZeroOutDay(notes);
    cancelAdd();
  };
  const handleDelete = (entry: TimesheetObjectEntry) => {
    if (!window.confirm(`Удалить корректировку по объекту «${entry.object_name}»?`)) return;
    onDeleteObject({
      object_key: entry.object_key,
      object_id: entry.object_id,
      object_name: entry.object_name,
    });
  };

  return (
    <div
      className="ts-modal-body"
      style={{
        borderTop: '1px solid var(--border, #e5e7eb)',
        paddingTop: 12,
        maxHeight: '50vh',
        overflowY: 'auto',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Корректировки по объектам</div>
      {hasDayLevelCorrection && dayLevelSummary && onDeleteDayLevel && (
        <div
          style={{
            borderBottom: '1px dashed var(--border, #e5e7eb)',
            paddingBottom: 10,
            marginBottom: 10,
            background: 'var(--bg-tertiary, #f5f6f8)',
            padding: 10,
            borderRadius: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontWeight: 500, flex: 1, minWidth: 0 }}>
              День целиком
              <span style={{ marginLeft: 8, color: 'var(--text-secondary, #5b6573)' }}>
                {formatHM(dayLevelSummary.hours)}
                {dayLevelSummary.notes.trim() && ` · «${dayLevelSummary.notes.trim()}»`}
              </span>
            </div>
            <button
              type="button"
              className="ts-btn ts-btn--danger"
              onClick={() => {
                if (window.confirm('Снять общую корректировку дня?')) onDeleteDayLevel();
              }}
              title="Снять корректировку дня"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      )}
      {correctedEntries.length === 0 && !addTarget && (
        <div style={{ color: 'var(--text-secondary, #5b6573)', fontSize: 13, marginBottom: 10 }}>
          Корректировок по объектам пока нет.
        </div>
      )}
      {correctedEntries.map(entry => {
        const state = rowState[entry.object_key] ?? { hours: 0, notes: '' };
        const hasExisting = entry.adjustment_id != null && entry.is_correction;
        const isExpanded = expanded.has(entry.object_key);
        const rowStyle = {
          borderBottom: '1px dashed var(--border, #e5e7eb)',
          paddingBottom: 10,
          marginBottom: 10,
        };

        // Сводный режим: уже внесённая корректировка → один компактный ряд с
        // часами/комментарием и кнопками «Изменить»/«Снять».
        if (hasExisting && !isExpanded) {
          const baseHours = Number(entry.display_hours_worked ?? entry.hours_worked ?? 0);
          const trimmedNotes = (entry.notes ?? '').trim();
          return (
            <div key={entry.object_key} style={rowStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontWeight: 500, flex: 1, minWidth: 0 }}>
                  {entry.object_name}
                  <span style={{ marginLeft: 8, color: 'var(--text-secondary, #5b6573)' }}>
                    {formatHM(baseHours)}
                    {trimmedNotes && ` · «${trimmedNotes}»`}
                  </span>
                </div>
                <button
                  type="button"
                  className="ts-btn"
                  onClick={() => toggleExpanded(entry.object_key)}
                  title="Изменить часы"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="ts-btn ts-btn--danger"
                  onClick={() => handleDelete(entry)}
                  title="Снять корректировку"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        }

        // Редактируемый ряд (новый объект или нажали «Изменить»).
        const wholeHours = Math.floor(state.hours);
        const minutes = Math.round((state.hours - wholeHours) * 60);
        const applyHM = (h: number, m: number) => {
          const clampedM = Math.max(0, Math.min(59, m));
          const clampedH = Math.max(0, h);
          handleHoursChange(entry.object_key, clampedH + clampedM / 60);
        };
        const trimmedNotes = state.notes.trim();
        const isZero = state.hours <= 0;
        const canSave = isZero ? hasExisting : trimmedNotes.length > 0;
        const saveLabel = isZero ? 'Снять корректировку' : 'Сохранить объект';
        const saveTitle = isZero
          ? (hasExisting ? '0 часов — корректировка будет снята' : 'Нечего сохранять: 0 часов и нет существующей корректировки')
          : (canSave ? undefined : 'Укажите комментарий');
        return (
          <div key={entry.object_key} style={rowStyle}>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>{entry.object_name}</div>
            <div className="ts-hours-inputs" style={{ marginBottom: 6 }}>
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
            <input
              type="text"
              className="ts-form-input"
              value={state.notes}
              onChange={e => handleNotesChange(entry.object_key, e.target.value)}
              placeholder="Причина корректировки..."
              style={{ marginBottom: 6 }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {hasExisting && (
                <>
                  <button
                    type="button"
                    className="ts-btn"
                    onClick={() => toggleExpanded(entry.object_key)}
                    title="Свернуть"
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="ts-btn"
                    onClick={() => handleDelete(entry)}
                    title="Снять корректировку"
                  >
                    Снять
                  </button>
                </>
              )}
              <button
                type="button"
                className="ts-btn ts-btn--primary"
                onClick={() => handleSave(entry)}
                disabled={!canSave}
                title={saveTitle}
              >
                {saveLabel}
              </button>
            </div>
          </div>
        );
      })}
      {/* Inline-форма создания (под кнопкой «+») */}
      {addTarget?.kind === 'object' && (() => {
        const entry = addTarget.entry;
        const wholeHours = Math.floor(newRow.hours);
        const minutes = Math.round((newRow.hours - wholeHours) * 60);
        const applyHM = (h: number, m: number) => {
          const clampedM = Math.max(0, Math.min(59, m));
          const clampedH = Math.max(0, h);
          setNewRow(prev => ({ ...prev, hours: clampedH + clampedM / 60 }));
        };
        const canSave = newRow.hours > 0 && newRow.notes.trim().length > 0;
        return (
          <div
            style={{
              borderBottom: '1px dashed var(--border, #e5e7eb)',
              paddingBottom: 10,
              marginBottom: 10,
              background: 'var(--bg-tertiary, #f5f6f8)',
              padding: 10,
              borderRadius: 6,
            }}
          >
            <div style={{ fontWeight: 500, marginBottom: 6 }}>{entry.object_name}</div>
            <div className="ts-hours-inputs" style={{ marginBottom: 6 }}>
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
            <input
              type="text"
              className="ts-form-input"
              value={newRow.notes}
              onChange={e => setNewRow(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Причина корректировки..."
              style={{ marginBottom: 6 }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="ts-btn" onClick={cancelAdd}>Отмена</button>
              <button
                type="button"
                className="ts-btn ts-btn--primary"
                onClick={handleSaveNew}
                disabled={!canSave}
                title={canSave ? undefined : 'Укажите часы и комментарий'}
              >
                Сохранить
              </button>
            </div>
          </div>
        );
      })()}
      {addTarget?.kind === 'zero-out' && (
        <div
          style={{
            borderBottom: '1px dashed var(--border, #e5e7eb)',
            paddingBottom: 10,
            marginBottom: 10,
            background: 'var(--bg-tertiary, #f5f6f8)',
            padding: 10,
            borderRadius: 6,
          }}
        >
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Обнулить день</div>
          <input
            type="text"
            className="ts-form-input"
            value={newRow.notes}
            onChange={e => setNewRow(prev => ({ ...prev, notes: e.target.value }))}
            placeholder="Причина обнуления (обязательно)…"
            style={{ marginBottom: 6 }}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="ts-btn" onClick={cancelAdd}>Отмена</button>
            <button
              type="button"
              className="ts-btn ts-btn--primary"
              onClick={handleConfirmZeroOut}
              disabled={newRow.notes.trim().length === 0}
              title={newRow.notes.trim().length === 0 ? 'Укажите комментарий' : 'Сохранить день 0 ч'}
            >
              Подтвердить
            </button>
          </div>
        </div>
      )}

      {/* Меню «+ Добавить корректировку» */}
      {!addTarget && !hasDayLevelCorrection && (
        <div style={{ marginBottom: 10 }}>
          {!addMenuOpen ? (
            <button
              type="button"
              className="ts-btn ts-btn--primary"
              onClick={() => setAddMenuOpen(true)}
              disabled={availableForAdd.length === 0 && !onZeroOutDay}
              title={availableForAdd.length === 0 && !onZeroOutDay
                ? 'Нет объектов для новой корректировки'
                : 'Добавить корректировку'}
            >
              + Добавить корректировку
            </button>
          ) : (
            <div
              style={{
                border: '1px solid var(--border, #e5e7eb)',
                borderRadius: 6,
                padding: 8,
                background: 'var(--surface)',
              }}
            >
              <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>Что добавить?</div>
              {availableForAdd.length === 0 && (
                <div style={{ color: 'var(--text-secondary, #5b6573)', fontSize: 12, marginBottom: 6 }}>
                  Все объекты сотрудника уже скорректированы.
                </div>
              )}
              {availableForAdd.map(entry => (
                <button
                  key={entry.object_key}
                  type="button"
                  className="ts-btn"
                  style={{ display: 'block', width: '100%', marginBottom: 4, textAlign: 'left' }}
                  onClick={() => openAddObject(entry)}
                >
                  {entry.object_name}
                </button>
              ))}
              {onZeroOutDay && (
                <button
                  type="button"
                  className="ts-btn"
                  style={{ display: 'block', width: '100%', marginBottom: 4, textAlign: 'left' }}
                  onClick={openZeroOut}
                >
                  Обнулить день целиком
                </button>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <button type="button" className="ts-btn" onClick={() => setAddMenuOpen(false)}>
                  Закрыть
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {planned != null && (
        <div
          style={{
            marginTop: 4,
            padding: '6px 10px',
            borderRadius: 6,
            background: exceedsPlanned ? 'var(--warning-bg, #fff7ed)' : 'var(--bg-tertiary, #f5f6f8)',
            color: exceedsPlanned ? 'var(--warning, #c2410c)' : 'var(--text-secondary, #5b6573)',
            fontSize: 13,
          }}
        >
          {exceedsPlanned ? '⚠ ' : '✓ '}
          Σ корректировок = {formatHM(totalHours)} / план {formatHM(planned)}
          {exceedsPlanned && ' — превышение, согласующий увидит'}
        </div>
      )}
    </div>
  );
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
  dayStatusContext,
  infoBanner,
  objectEntries,
  plannedHours,
  hasDayLevelCorrection,
  onSaveObject,
  onDeleteObject,
  onZeroOutDay,
  preselectedObjectKey,
  initialMode,
}) => {
  const hasObjectsBlock = Array.isArray(objectEntries) && objectEntries.length > 0 && !!onSaveObject && !!onDeleteObject;
  const dayHasObjectAdjustments = hasObjectsBlock && objectEntries!.some(entry => entry.is_correction && entry.adjustment_id != null);
  // Save «День» при наличии объектных корректировок предупреждает: бэк их снимет.
  const wrappedOnSave: ICorrectionModalProps['onSave'] = (status, hours, notes) => {
    if (dayHasObjectAdjustments && !window.confirm(
      'Сохранение общей корректировки дня снимет все корректировки по объектам. Продолжить?',
    )) return;
    onSave(status, hours, notes);
  };
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

  // Чип со статусом дня — рисуется только если родитель передал dayStatusContext.
  // Логика и палитра общие с табелем и боковой панелью (см. utils/dayStatus.ts).
  const statusChip = dayStatusContext ? (() => {
    const status = getDayStatus(timesheetEntry ?? null, {
      showActualHours: dayStatusContext.showActualHours,
      fullDayThresholdHours: dayStatusContext.fullDayThresholdHours,
      isScheduledDayOff: dayStatusContext.isScheduledDayOff,
    });
    return (
      <span className={`ts-modal-status-chip ${STATUS_TO_DETAIL_HOURS_CLASS[status]}`}>
        {STATUS_LABEL_RU[status]}
        {dayStatusContext.isPreHoliday && (
          <span className="ts-modal-status-chip__pre">• −1ч</span>
        )}
      </span>
    );
  })() : null;

  if (customContent) {
    return (
      <div className="ts-modal" onClick={e => e.stopPropagation()}>
        <div className="ts-modal-header">
          <h3 className="ts-modal-title">
            {headerTitle}
            {statusChip}
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

  // Двухколоночный layout: и СКУД, и корректировка одновременно (когда есть данные).
  // На <1024 CSS схлопывает grid в одну колонку и табы возвращаются.
  const useTwoColumnLayout = Boolean(showEventsTab && showCorrectionTab && employeeId && workDate);
  const adjustmentId = correctionInfo?.adjustment_id ?? null;
  // Прикреплять файлы в модалке разрешено только при явном edit-режиме
  // (например, из «✏ Скорректировать» на странице корректировок). При обычном
  // просмотре существующей корректировки — только список файлов без кнопки
  // «Прикрепить». Popover из TimesheetCorrectionsList — всегда только просмотр.
  const attachmentsCanEdit = Boolean(correctionInfo?.is_correction && adjustmentId && initialMode === 'edit');

  // Плашка «автор последней корректировки + время» — раньше висела sticky под
  // шапкой модалки. Перенесена в правую колонку, чтобы не сдвигать шапку и
  // быть рядом с самим списком корректировок.
  const correctionAuthorBlock = correctionInfo?.is_correction
    && (correctionInfo.corrected_by_name || correctionInfo.corrected_at) ? (
      <div className="ts-correction-info ts-correction-info--inline">
        <span className="ts-correction-info-icon">✎</span>
        {correctionInfo.corrected_by_name}
        {correctionInfo.corrected_by_name && correctionInfo.corrected_at && ', '}
        {correctionInfo.corrected_at && formatCorrectionDate(correctionInfo.corrected_at)}
      </div>
    ) : null;

  const correctionPanel = showCorrectionTab ? (
    <>
      {correctionAuthorBlock}
      {!hasObjectsBlock && (
        <CorrectionTab
          onClose={onClose}
          onSave={wrappedOnSave}
          onDelete={onDelete}
          initialStatus={initialStatus}
          initialHours={initialHours ?? 8}
          initialNotes={initialNotes}
          confirmLabel={confirmLabel}
          deleteLabel={deleteLabel}
          allowedStatuses={allowedStatuses}
          maxHours={maxHours}
          correctionInfo={correctionInfo}
          initialMode={initialMode}
        />
      )}
      {hasObjectsBlock && (
        <ObjectCorrectionsList
          objectEntries={objectEntries!}
          hasDayLevelCorrection={!!hasDayLevelCorrection}
          dayLevelSummary={hasDayLevelCorrection && timesheetEntry ? {
            hours: Number(timesheetEntry.display_hours_worked ?? timesheetEntry.hours_worked ?? 0),
            notes: timesheetEntry.notes ?? '',
          } : null}
          onDeleteDayLevel={hasDayLevelCorrection ? onDelete : undefined}
          plannedHours={plannedHours ?? null}
          onSaveObject={onSaveObject!}
          onDeleteObject={onDeleteObject!}
          onZeroOutDay={onZeroOutDay}
          preselectedObjectKey={preselectedObjectKey}
          initialMode={initialMode}
        />
      )}
      {adjustmentId && (
        <div style={{ padding: useTwoColumnLayout ? '0' : '12px 20px 20px' }}>
          <CorrectionAttachments
            adjustmentId={adjustmentId}
            variant="modal"
            canEdit={attachmentsCanEdit}
          />
        </div>
      )}
    </>
  ) : null;

  return (
    <div className={`ts-modal${useTwoColumnLayout ? ' ts-modal--two-col' : ''}`} onClick={e => e.stopPropagation()}>
      <div className="ts-modal-header">
        <h3 className="ts-modal-title">
          {headerTitle}
          {statusChip}
          <CorrectionApprovalBadge
            approvedAt={correctionInfo?.approved_at ?? null}
            approverName={correctionInfo?.approved_by_name ?? null}
            approvalComment={correctionInfo?.approval_comment ?? null}
          />
          {headerSubtitle && <div className="ts-modal-subtitle">{headerSubtitle}</div>}
        </h3>
        <button className="ts-panel-close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      {infoBanner && (
        <div className="ts-correction-info ts-correction-info--notice">
          <span className="ts-correction-info-icon">ℹ</span>
          <span>{infoBanner}</span>
        </div>
      )}

      {useTwoColumnLayout ? (
        <div className="ts-modal-body ts-modal-body--grid">
          <div className="ts-corr-col ts-corr-col--left">
            <EventsTab
              employeeId={employeeId!}
              workDate={workDate!}
              allowAccessPointMap={allowAccessPointMap}
              timesheetEntry={timesheetEntry}
            />
          </div>
          <div className="ts-corr-col ts-corr-col--right">
            {correctionPanel}
          </div>
        </div>
      ) : (
        <>
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
          ) : correctionPanel}
        </>
      )}
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
