import { type FC, type ReactNode, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, LogIn, LogOut, Timer, Pencil, Trash2, Check, XCircle } from 'lucide-react';
import type { TimesheetEntry, TimesheetObjectEntry, TimesheetStatus, SkudEvent, SkudEventFailure } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useAccessPointMapViewer } from '../../hooks/useAccessPointMapViewer';
import { skudService } from '../../services/skudService';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import { CorrectionApprovalBadge } from './CorrectionApprovalBadge';
import { TravelSegmentsPanel } from './TravelSegmentsPanel';
import { CorrectionAttachments } from './CorrectionAttachments';
import { StagedCorrectionAttachments } from './StagedCorrectionAttachments';
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
import { PresenceTimeline } from '../skud/PresenceTimeline';
import { getDayStatus, STATUS_LABEL_RU, STATUS_TO_DETAIL_HOURS_CLASS } from '../../utils/dayStatus';
import { CREATABLE_STATUS_META, getStatusMeta, HOURS_EDITABLE_STATUSES } from '../../utils/correctionStatus';

interface ICorrectionModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (status: TimesheetStatus, hours: number | null, notes: string, files?: File[]) => void;
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
    approval_status?: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
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
  // Роль с запретом объектных правок (corrections_disable_object_entries, миграция 179):
  // в режиме «По сотрудникам» прячем объектный список и рендерим дневную форму CorrectionTab.
  disableObjectEntries?: boolean;
  // План часов дня по графику — для суммирующего чипа (Σ корректировок / план).
  plannedHours?: number | null;
  // Есть ли активная day-level корректировка — используется для confirm-диалога:
  // сохранение по-объектной корректировки её снимет (по правилу взаимоисключения на бэке).
  hasDayLevelCorrection?: boolean;
  // Сохранение/удаление корректировки по конкретному объекту.
  onSaveObject?: (target: { object_key: string; object_id: string | null; object_name: string }, hours: number, notes: string) => void;
  onDeleteObject?: (target: { object_key: string; object_id: string | null; object_name: string }) => void;
  // Явное обнуление дня (status='manual', hours=0) — единственная точка входа к day-level
  // корректировке, когда CorrectionTab скрыт из-за объектных СКУД-записей.
  onZeroOutDay?: (notes: string) => void;
  // Стартовый режим внутреннего CorrectionTab/ObjectCorrectionsList. 'edit' принудительно
  // открывает форму редактирования; по умолчанию — 'view' для существующих корректировок,
  // 'edit' для новых. Используется из TimesheetCorrectionsList («✏ Скорректировать»).
  initialMode?: 'view' | 'edit';
  // Разрешить прикреплять файлы прямо в форме СОЗДАНИЯ корректировки (staged →
  // загрузка после создания). Включает родитель, чей onSave умеет грузить файлы
  // (табель). По умолчанию false — ЛК/массовая корректировка без picker'а.
  allowAttachmentsOnCreate?: boolean;
  // Показать верхнюю вкладку «Передвижения» (есть превышение лимита/непривязанная точка).
  // Если true — модалка открывается на вкладке «Передвижения», рядом вкладка «Корректировки»
  // с обычным содержимым. Размер модалки при переключении не меняется.
  showTravelTab?: boolean;
  // Сосуществование «работа в выходной» + «удалёнка» (см. план): companion-карточка,
  // кнопка «+ Удалёнка» (отдельная remote-строка через create) и дефолт её часов.
  companionWorkRequest?: {
    id: number;
    approval_status: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
    approved_at: string | null;
    approved_by_name: string | null;
    reason: string | null;
  } | null;
  canAddRemote?: boolean;
  remoteDefaultHours?: number;
  onAddRemote?: (hours: number, notes: string, files?: File[]) => void;
  // День заперт согласованием периода (submitted/approved) — модалка открывается
  // в режиме «только просмотр»: скрыты все кнопки правки/удаления/добавления,
  // события СКУД и текст заявки остаются видны.
  readOnly?: boolean;
  // Разрешить точечную правку текста заявки «работа в выходной/праздник»
  // (initialNotes при initialStatus='work' и companionWorkRequest.reason),
  // не открывая полную форму редактирования корректировки.
  canEditReasonText?: boolean;
  onUpdateReason?: (id: number, reason: string) => Promise<void>;
}

type ModalTab = 'events' | 'correction';

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

// Источник опций статусов в пикерах — общий CREATABLE_STATUS_META (utils/correctionStatus).
const TYPE_OPTIONS = CREATABLE_STATUS_META;

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

// Точечная инлайн-правка текста заявки «работа в выходной/праздник» — без открытия
// полной формы редактирования корректировки (та меняет ещё и статус/часы).
const EditableReasonLine: FC<{
  id: number;
  text: string;
  onUpdateReason: (id: number, reason: string) => Promise<void>;
}> = ({ id, text, onUpdateReason }) => {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <div className="ts-correction-view-comment ts-correction-view-comment--editable">
        <span>{text}</span>
        <button
          type="button"
          className="ts-corrections-btn"
          onClick={() => { setValue(text); setEditing(true); }}
          aria-label="Изменить текст заявления"
          title="Изменить текст"
        >
          <Pencil size={13} />
        </button>
      </div>
    );
  }

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onUpdateReason(id, trimmed);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ts-correction-view-comment" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <textarea
        className="ts-form-textarea"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={500}
        rows={3}
        disabled={saving}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="ts-btn ts-btn--primary" disabled={saving || !value.trim()} onClick={() => void handleSave()}>
          Сохранить
        </button>
        <button type="button" className="ts-btn" disabled={saving} onClick={() => setEditing(false)}>
          Отмена
        </button>
      </div>
    </div>
  );
};

const CorrectionTab: FC<{
  onClose: () => void;
  onSave: (status: TimesheetStatus, hours: number | null, notes: string, files?: File[]) => void;
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
  // Блок «Файлы корректировки» — рендерится перед футером (#1: «Сохранить» в самом низу).
  attachmentsSlot?: ReactNode;
  // Разрешить staged-picker файлов в форме создания (файлы уйдут 4-м аргументом onSave).
  allowAttachmentsOnCreate?: boolean;
  // Согласованный выход в выходной (leave_request/work), поверх которого лежит ведущая
  // корректировка «Удалёнка» — рисуем второй read-only карточкой.
  companionWorkRequest?: {
    id: number;
    approval_status: 'auto_approved' | 'pending' | 'approved' | 'rejected' | null;
    approved_at: string | null;
    approved_by_name: string | null;
    reason: string | null;
  } | null;
  // День — согласованная заявка «работа в выходной» без удалёнки: можно ДОБАВИТЬ remote
  // отдельной строкой (кнопка), не редактируя саму заявку.
  canAddRemote?: boolean;
  // Дефолт часов для формы «+ Удалёнка» (полный день по графику).
  remoteDefaultHours?: number;
  // Создаёт ОТДЕЛЬНУЮ remote-корректировку (через create, не update заявки).
  onAddRemote?: (hours: number, notes: string, files?: File[]) => void;
  readOnly?: boolean;
  canEditReasonText?: boolean;
  onUpdateReason?: (id: number, reason: string) => Promise<void>;
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
  attachmentsSlot,
  allowAttachmentsOnCreate,
  companionWorkRequest,
  canAddRemote,
  remoteDefaultHours,
  onAddRemote,
  readOnly,
  canEditReasonText,
  onUpdateReason,
}) => {
  const [addingRemote, setAddingRemote] = useState(false);
  const [remoteHours, setRemoteHours] = useState<number>(remoteDefaultHours || 8);
  const [remoteNotes, setRemoteNotes] = useState('');
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
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const showStatusPicker = statusOptions.length > 1;
  // Picker файлов — только при создании новой корректировки (у существующей файлы
  // уже грузятся через attachmentsSlot → реальный CorrectionAttachments).
  const showStagedPicker = Boolean(allowAttachmentsOnCreate && !hasExistingCorrection);

  const trimmedNotes = notes.trim();
  const needsHoursForStatus = HOURS_EDITABLE_STATUSES.has(selectedStatus);
  const exceedsMax = needsHoursForStatus && maxHours != null && hours > maxHours;
  const canSave = trimmedNotes.length > 0 && !exceedsMax;

  const handleSave = () => {
    if (!canSave) return;
    onSave(selectedStatus, needsHoursForStatus ? hours : null, trimmedNotes, stagedFiles);
  };

  // Период заперт согласованием — редактирование недоступно. Если корректировки за
  // день ещё нет, форму создания не показываем (её всё равно нельзя сохранить).
  if (readOnly && !hasExistingCorrection) {
    return (
      <div className="ts-modal-body">
        <div className="ts-correction-view-comment">Нет корректировки за этот день. Период закрыт для редактирования.</div>
      </div>
    );
  }

  const effectiveMode = readOnly ? 'view' : mode;

  if (effectiveMode === 'view' && hasExistingCorrection) {
    const statusMeta = getStatusMeta(initialStatus);
    const statusLabel = statusMeta?.label ?? initialStatus;
    const statusIcon = statusMeta?.icon ?? '✎';
    // У удалёнки часы не редактируются вручную, но проставляются автоматически
    // (полный день по графику) — показываем их, а не прочерк.
    const hoursLabel = HOURS_EDITABLE_STATUSES.has(initialStatus) || initialStatus === 'remote'
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
    // «Только заявка work, удалёнки ещё нет»: карандаш прячем (не даём конвертировать
    // заявку через update), основной путь добавления часов — кнопка «+ Удалёнка».
    const isWorkOnlyAddRemote = Boolean(canAddRemote && onAddRemote && initialStatus === 'work');
    const showEditPencil = !isWorkOnlyAddRemote && !readOnly;
    // Точечная правка текста заявки (без открытия полной формы): только на самой
    // «work»-записи, у которой обычный карандаш скрыт (isWorkOnlyAddRemote).
    const canEditThisReasonText = Boolean(canEditReasonText && onUpdateReason && !readOnly && isWorkOnlyAddRemote);
    const canEditCompanionReasonText = Boolean(canEditReasonText && onUpdateReason && !readOnly);
    const companionApprovedBy = companionWorkRequest?.approved_by_name
      ? ` (${companionWorkRequest.approved_by_name})`
      : '';
    return (
      <>
        <div className="ts-modal-body">
          <div className="ts-correction-view-row" title={tooltip}>
            <span className="ts-correction-view-row__icon">{statusIcon}</span>
            <span className="ts-correction-view-row__text">
              {statusLabel} · <b>{hoursLabel}</b>
            </span>
            <span className="ts-correction-view-row__actions">
              {showEditPencil && (
                <button
                  type="button"
                  className="ts-corrections-btn"
                  onClick={() => setMode('edit')}
                  aria-label="Изменить корректировку"
                  title="Изменить"
                >
                  <Pencil size={14} />
                </button>
              )}
              {onDelete && !readOnly && (
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
            canEditThisReasonText && correctionInfo?.adjustment_id != null ? (
              <EditableReasonLine
                id={correctionInfo.adjustment_id}
                text={trimmedInitialNotes}
                onUpdateReason={onUpdateReason!}
              />
            ) : (
              <div className="ts-correction-view-comment">{trimmedInitialNotes}</div>
            )
          )}

          {/* Companion: согласованный выход в выходной (read-only), поверх которого лежит удалёнка. */}
          {companionWorkRequest && (
            <>
              <div className="ts-correction-view-row" title="Выход в выходной согласован">
                <span className="ts-correction-view-row__icon">✔</span>
                <span className="ts-correction-view-row__text">
                  Работа в выходной/праздник <span style={{ color: 'var(--success)' }}>· выход согласован{companionApprovedBy}</span>
                </span>
              </div>
              {companionWorkRequest.reason?.trim() && (
                canEditCompanionReasonText ? (
                  <EditableReasonLine
                    id={companionWorkRequest.id}
                    text={companionWorkRequest.reason.trim()}
                    onUpdateReason={onUpdateReason!}
                  />
                ) : (
                  <div className="ts-correction-view-comment">{companionWorkRequest.reason}</div>
                )
              )}
            </>
          )}

          {/* Добавление отдельной remote-корректировки поверх согласованного выхода. */}
          {isWorkOnlyAddRemote && !readOnly && !addingRemote && (
            <button
              type="button"
              className="ts-btn ts-btn--primary"
              style={{ marginTop: 8 }}
              onClick={() => { setRemoteHours(remoteDefaultHours || 8); setRemoteNotes(''); setAddingRemote(true); }}
            >
              + Добавить корректировку (Удалёнка)
            </button>
          )}
          {isWorkOnlyAddRemote && !readOnly && addingRemote && (() => {
            const wholeHours = Math.floor(remoteHours);
            const minutes = Math.round((remoteHours - wholeHours) * 60);
            const applyHM = (h: number, m: number) => {
              const clampedM = Math.max(0, Math.min(59, m));
              setRemoteHours(Math.max(0, h) + clampedM / 60);
            };
            const remoteCanSave = remoteNotes.trim().length > 0 && remoteHours > 0;
            return (
              <div className="ts-form-group" style={{ marginTop: 8 }}>
                <label className="ts-form-label">Удалёнка — часы</label>
                <div className="ts-hours-inputs">
                  <input type="number" className="ts-form-input ts-form-input--hm" value={wholeHours}
                    onChange={e => applyHM(parseInt(e.target.value, 10) || 0, minutes)} min={0} max={24} />
                  <span className="ts-hours-separator">ч</span>
                  <input type="number" className="ts-form-input ts-form-input--hm" value={minutes}
                    onChange={e => applyHM(wholeHours, parseInt(e.target.value, 10) || 0)} min={0} max={59} />
                  <span className="ts-hours-separator">м</span>
                </div>
                <label className="ts-form-label" style={{ marginTop: 8 }}>Комментарий <span className="ts-form-required">*</span></label>
                <input type="text" className="ts-form-input" value={remoteNotes}
                  onChange={e => setRemoteNotes(e.target.value)} placeholder="Причина (удалённая работа)..." />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                  <button type="button" className="ts-btn" onClick={() => setAddingRemote(false)}>Отмена</button>
                  <button type="button" className="ts-btn ts-btn--primary" disabled={!remoteCanSave}
                    onClick={() => { onAddRemote?.(remoteHours, remoteNotes.trim()); setAddingRemote(false); }}>
                    Сохранить
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
        {attachmentsSlot}
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
          <div className="ts-hours-hint">По умолчанию полный день по графику — при необходимости измените часы.</div>
        )}

        {selectedStatus === 'work' && (
          <div className="ts-hours-hint">Время рассчитается автоматически по событиям СКУД.</div>
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
      {attachmentsSlot}
      {showStagedPicker && (
        <div style={{ padding: '12px 20px 0' }}>
          <StagedCorrectionAttachments files={stagedFiles} onChange={setStagedFiles} />
        </div>
      )}
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
  dayLevelStatus?: TimesheetStatus | null;
  onDeleteDayLevel?: () => void;
  plannedHours?: number | null;
  onSaveObject: (target: { object_key: string; object_id: string | null; object_name: string }, hours: number, notes: string) => void;
  onDeleteObject: (target: { object_key: string; object_id: string | null; object_name: string }) => void;
  // Сохранение дневной (не объектной) корректировки: статус Удалёнка/Отпуск/… или
  // «Работа» с часами. Бэк по правилу взаимоисключения снимет объектные правки дня.
  onSaveDayLevel?: (status: TimesheetStatus, hours: number | null, notes: string) => void;
  // Когда day-level корректировки нет, но у дня есть объектные СКУД-записи —
  // даём явный путь «не работал»: создаёт day-level 0ч (бэк снимет manual_object).
  onZeroOutDay?: (notes: string) => void;
  // Открытие из «По объектам» — этот ключ сразу раскрыт в edit-режиме (если
  // корректировка по нему уже есть) либо открывает форму создания для него.
  preselectedObjectKey?: string | null;
  // Из TimesheetCorrectionsList («Скорректировать»): открыть preselected
  // сразу в редактируемом режиме.
  initialMode?: 'view' | 'edit';
  // Ограничение статусов в форме добавления (#6): на дне с присутствием/работой —
  // только «Корректировка табеля» (manual).
  allowedStatuses?: TimesheetStatus[];
  readOnly?: boolean;
}

// Серая скруглённая карточка для inline-форм (единый стиль с «День целиком»/«Удалёнка»).
const FORM_CARD_STYLE = {
  background: 'var(--bg-tertiary, #f5f6f8)',
  padding: 10,
  borderRadius: 8,
  marginBottom: 10,
};

const ObjectCorrectionsList: FC<IObjectCorrectionsListProps> = ({
  objectEntries,
  hasDayLevelCorrection,
  dayLevelSummary,
  dayLevelStatus,
  onDeleteDayLevel,
  plannedHours,
  onSaveObject,
  onDeleteObject,
  onSaveDayLevel,
  onZeroOutDay,
  preselectedObjectKey,
  initialMode,
  allowedStatuses,
  readOnly,
}) => {
  const addStatusOptions = useMemo(
    () => CREATABLE_STATUS_META.filter(meta => !allowedStatuses || allowedStatuses.includes(meta.status)),
    [allowedStatuses],
  );
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

  // Базовое (насчитанное по СКУД) время объекта — дефолт для «Корректировки табеля» (#5.2).
  const baseHoursForObject = useCallback((objectKey: string): number => {
    const e = objectEntries.find(x => x.object_key === objectKey);
    return Number(e?.base_hours_worked ?? e?.display_hours_worked ?? e?.hours_worked ?? 0);
  }, [objectEntries]);

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

  // ── Форма добавления: статус → (для «Корректировки табеля» — объект + часы) ──
  const [adding, setAdding] = useState(false);
  const [addStatus, setAddStatus] = useState<TimesheetStatus>('manual');
  const [addObjectKey, setAddObjectKey] = useState<string>('');
  const [addHours, setAddHours] = useState<number>(0);
  const [addNotes, setAddNotes] = useState('');

  const openAdd = useCallback((presetObjectKey?: string) => {
    const objKey = presetObjectKey ?? availableForAdd[0]?.object_key ?? '';
    setAddStatus('manual');
    setAddObjectKey(objKey);
    setAddHours(objKey ? baseHoursForObject(objKey) : 0);
    setAddNotes('');
    setAdding(true);
  }, [availableForAdd, baseHoursForObject]);
  const cancelAdd = () => {
    setAdding(false);
    setAddNotes('');
  };

  // Открытие из «По объектам» по объекту без корректировки — сразу форма добавления.
  useEffect(() => {
    if (!preselectedObjectKey) return;
    if (correctedEntries.some(e => e.object_key === preselectedObjectKey)) return;
    if (!objectEntries.some(e => e.object_key === preselectedObjectKey)) return;
    openAdd(preselectedObjectKey);
  }, [preselectedObjectKey, correctedEntries, objectEntries, openAdd]);

  const changeAddObject = (key: string) => {
    setAddObjectKey(key);
    setAddHours(key ? baseHoursForObject(key) : 0); // #5.2: подставляем базовое время
  };
  const changeAddStatus = (status: TimesheetStatus) => {
    setAddStatus(status);
    if (status === 'manual') {
      const key = addObjectKey || availableForAdd[0]?.object_key || '';
      setAddObjectKey(key);
      setAddHours(key ? baseHoursForObject(key) : 0);
    } else if (status === 'remote') {
      // Удалёнка: дефолт — полный день по графику (в выходной plannedHours=0 → 8).
      setAddHours((plannedHours ?? 0) || 8);
    }
  };

  const addIsManual = addStatus === 'manual';
  const addHoursEditable = HOURS_EDITABLE_STATUSES.has(addStatus);
  const addCanSave = addNotes.trim().length > 0
    && (!addIsManual || (Boolean(addObjectKey) && addHours > 0))
    && (addStatus !== 'remote' || addHours > 0);

  const saveAdd = () => {
    const notes = addNotes.trim();
    if (notes.length === 0) return;
    if (addIsManual) {
      if (!addObjectKey || addHours <= 0) return;
      const obj = objectEntries.find(e => e.object_key === addObjectKey);
      if (!obj) return;
      if (hasDayLevelCorrection && !window.confirm(
        'Сохранение корректировки по объекту снимет общую корректировку дня. Продолжить?',
      )) return;
      onSaveObject(
        { object_key: obj.object_key, object_id: obj.object_id, object_name: obj.object_name },
        addHours,
        notes,
      );
    } else {
      if (!onSaveDayLevel) return;
      if (correctedEntries.length > 0 && !window.confirm(
        'Дневная корректировка снимет все корректировки по объектам за этот день. Продолжить?',
      )) return;
      const hoursForLevel = addStatus === 'work'
        ? (addHours > 0 ? addHours : null)
        : (addHoursEditable ? addHours : null);
      onSaveDayLevel(addStatus, hoursForLevel, notes);
    }
    cancelAdd();
  };

  // Σ — учитываем сохранённые + форму добавления (только для manual).
  const totalHours = correctedEntries.reduce(
    (sum, e) => sum + Number(e.display_hours_worked ?? e.hours_worked ?? 0),
    0,
  ) + (adding && addIsManual ? (addHours || 0) : 0);
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
  const handleDelete = (entry: TimesheetObjectEntry) => {
    if (!window.confirm(`Удалить корректировку по объекту «${entry.object_name}»?`)) return;
    onDeleteObject({
      object_key: entry.object_key,
      object_id: entry.object_id,
      object_name: entry.object_name,
    });
  };

  // Поля «часы (ч/м)» — единый рендер для форм редактирования и добавления.
  const renderHoursInputs = (value: number, onChange: (next: number) => void) => {
    const whole = Math.floor(value);
    const minutes = Math.round((value - whole) * 60);
    const applyHM = (h: number, m: number) => {
      const cm = Math.max(0, Math.min(59, m));
      const ch = Math.max(0, h);
      onChange(ch + cm / 60);
    };
    return (
      <div className="ts-hours-inputs" style={{ marginBottom: 6 }}>
        <input
          type="number"
          className="ts-form-input ts-form-input--hm"
          value={whole}
          onChange={e => applyHM(parseInt(e.target.value, 10) || 0, minutes)}
          min={0}
          max={24}
        />
        <span className="ts-hours-separator">ч</span>
        <input
          type="number"
          className="ts-form-input ts-form-input--hm"
          value={minutes}
          onChange={e => applyHM(whole, parseInt(e.target.value, 10) || 0)}
          min={0}
          max={59}
        />
        <span className="ts-hours-separator">м</span>
      </div>
    );
  };

  const canAdd = availableForAdd.length > 0 || Boolean(onSaveDayLevel);
  const dayLevelMeta = dayLevelStatus ? getStatusMeta(dayLevelStatus) : null;

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
      {/* Шапка блока: «Обнулить день» (слева) + «Добавить корректировку» вверху справа (#2/#4) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>Корректировки по объектам</div>
        {!readOnly && !adding && !hasDayLevelCorrection && expanded.size === 0 && onZeroOutDay && (
          <button
            type="button"
            className="ts-btn"
            onClick={() => {
              const notes = window.prompt('Причина обнуления дня (обязательно):')?.trim();
              if (!notes) return;
              if (correctedEntries.length > 0 && !window.confirm(
                'Обнуление дня снимет все корректировки по объектам за этот день. Продолжить?',
              )) return;
              onZeroOutDay(notes);
            }}
            title="Поставить 0 часов на весь день (снимет корректировки по объектам)"
          >
            Обнулить день
          </button>
        )}
        {!readOnly && !adding && !hasDayLevelCorrection && expanded.size === 0 && (
          <button
            type="button"
            className="ts-btn ts-btn--primary"
            onClick={() => openAdd()}
            disabled={!canAdd}
            title={canAdd ? 'Добавить корректировку' : 'Нет объектов для новой корректировки'}
          >
            + Добавить корректировку
          </button>
        )}
      </div>

      {hasDayLevelCorrection && dayLevelSummary && (
        <div className="ts-correction-view-row" style={{ marginBottom: 10 }}>
          <span className="ts-correction-view-row__icon">{dayLevelMeta?.icon ?? '📝'}</span>
          <span className="ts-correction-view-row__text">
            {dayLevelMeta?.label ?? 'День целиком'} · <b>{formatHM(dayLevelSummary.hours)}</b>
            {dayLevelSummary.notes.trim() && ` · «${dayLevelSummary.notes.trim()}»`}
          </span>
          {onDeleteDayLevel && !readOnly && (
            <span className="ts-correction-view-row__actions">
              <button
                type="button"
                className="ts-corrections-btn ts-corrections-btn--danger"
                onClick={() => {
                  if (window.confirm('Снять общую корректировку дня?')) onDeleteDayLevel();
                }}
                title="Снять корректировку дня"
              >
                <Trash2 size={14} />
              </button>
            </span>
          )}
        </div>
      )}

      {correctedEntries.length === 0 && !adding && !hasDayLevelCorrection && (
        <div style={{ color: 'var(--text-secondary, #5b6573)', fontSize: 13, marginBottom: 10 }}>
          Корректировок по объектам пока нет.
        </div>
      )}

      {correctedEntries.map(entry => {
        const state = rowState[entry.object_key] ?? { hours: 0, notes: '' };
        const hasExisting = entry.adjustment_id != null && entry.is_correction;
        const isExpanded = !readOnly && expanded.has(entry.object_key);

        // Сводный режим: единый стиль карточки (#2) — иконка + «объект · часы» + комментарий.
        if (hasExisting && !isExpanded) {
          const baseHours = Number(entry.display_hours_worked ?? entry.hours_worked ?? 0);
          const trimmedNotes = (entry.notes ?? '').trim();
          return (
            <div key={entry.object_key} style={{ marginBottom: 10 }}>
              <div className="ts-correction-view-row">
                <span className="ts-correction-view-row__icon">📝</span>
                <span className="ts-correction-view-row__text">
                  {entry.object_name} · <b>{formatHM(baseHours)}</b>
                </span>
                {!readOnly && (
                  <span className="ts-correction-view-row__actions">
                    <button
                      type="button"
                      className="ts-corrections-btn"
                      onClick={() => toggleExpanded(entry.object_key)}
                      title="Изменить часы"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="ts-corrections-btn ts-corrections-btn--danger"
                      onClick={() => handleDelete(entry)}
                      title="Снять корректировку"
                    >
                      <Trash2 size={14} />
                    </button>
                  </span>
                )}
              </div>
              {trimmedNotes && (
                <div className="ts-correction-view-comment">{trimmedNotes}</div>
              )}
              {(entry.corrected_by_name || entry.corrected_at) && (
                <div className="ts-correction-view-author">
                  ✎ {entry.corrected_by_name}
                  {entry.corrected_by_name && entry.corrected_at && ', '}
                  {entry.corrected_at && formatCorrectionDate(entry.corrected_at)}
                </div>
              )}
            </div>
          );
        }

        // Редактируемый ряд (нажали «Изменить»).
        const trimmedNotes = state.notes.trim();
        const isZero = state.hours <= 0;
        const canSave = isZero ? hasExisting : trimmedNotes.length > 0;
        const saveLabel = isZero ? 'Снять корректировку' : 'Сохранить объект';
        const saveTitle = isZero
          ? (hasExisting ? '0 часов — корректировка будет снята' : 'Нечего сохранять: 0 часов')
          : (canSave ? undefined : 'Укажите комментарий');
        return (
          <div key={entry.object_key} style={FORM_CARD_STYLE}>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>{entry.object_name}</div>
            {renderHoursInputs(state.hours, h => handleHoursChange(entry.object_key, h))}
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
                <button
                  type="button"
                  className="ts-btn"
                  onClick={() => toggleExpanded(entry.object_key)}
                  title="Свернуть"
                >
                  Отмена
                </button>
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

      {/* Форма добавления: статус → объект (#5/#5.1/#5.2) */}
      {adding && !readOnly && (
        <div style={FORM_CARD_STYLE}>
          <div className="ts-form-group">
            <label className="ts-form-label">Тип записи</label>
            <select
              className="ts-form-select"
              value={addStatus}
              onChange={e => changeAddStatus(e.target.value as TimesheetStatus)}
            >
              {addStatusOptions.map(meta => (
                <option key={meta.status} value={meta.status}>{meta.icon} {meta.label}</option>
              ))}
            </select>
          </div>

          {addIsManual && (
            <div className="ts-form-group">
              <label className="ts-form-label">Объект</label>
              {availableForAdd.length === 0 ? (
                <div className="ts-form-hint ts-form-hint--error">
                  Все объекты сотрудника уже скорректированы.
                </div>
              ) : (
                <select
                  className="ts-form-select"
                  value={addObjectKey}
                  onChange={e => changeAddObject(e.target.value)}
                >
                  {availableForAdd.map(entry => (
                    <option key={entry.object_key} value={entry.object_key}>{entry.object_name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {addStatus === 'remote' && (
            <div className="ts-hours-hint">По умолчанию полный день по графику — при необходимости измените часы.</div>
          )}

          {addStatus === 'work' && (
            <div className="ts-hours-hint">Время рассчитается автоматически по событиям СКУД, или укажите часы вручную (0 = авто).</div>
          )}

          {(addHoursEditable || addStatus === 'work') && (!addIsManual || availableForAdd.length > 0) && (
            <div className="ts-form-group">
              <label className="ts-form-label">Часы {addStatus !== 'work' && <span className="ts-form-required">*</span>}</label>
              {renderHoursInputs(addHours, setAddHours)}
            </div>
          )}

          <div className="ts-form-group">
            <label className="ts-form-label">Комментарий <span className="ts-form-required">*</span></label>
            <input
              type="text"
              className="ts-form-input"
              value={addNotes}
              onChange={e => setAddNotes(e.target.value)}
              placeholder="Причина корректировки..."
            />
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="ts-btn" onClick={cancelAdd}>Отмена</button>
            <button
              type="button"
              className="ts-btn ts-btn--primary"
              onClick={saveAdd}
              disabled={!addCanSave}
              title={addCanSave ? undefined : 'Заполните поля и комментарий'}
            >
              Сохранить
            </button>
          </div>
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
  disableObjectEntries,
  plannedHours,
  hasDayLevelCorrection,
  onSaveObject,
  onDeleteObject,
  onZeroOutDay,
  preselectedObjectKey,
  initialMode,
  allowAttachmentsOnCreate,
  showTravelTab,
  companionWorkRequest,
  canAddRemote,
  remoteDefaultHours,
  onAddRemote,
  readOnly,
  canEditReasonText,
  onUpdateReason,
}) => {
  const hasObjectsBlock = !disableObjectEntries
    && Array.isArray(objectEntries) && objectEntries.length > 0 && !!onSaveObject && !!onDeleteObject;
  const dayHasObjectAdjustments = hasObjectsBlock && objectEntries!.some(entry => entry.is_correction && entry.adjustment_id != null);
  // Save «День» при наличии объектных корректировок предупреждает: бэк их снимет.
  const wrappedOnSave: ICorrectionModalProps['onSave'] = (status, hours, notes, files) => {
    if (dayHasObjectAdjustments && !window.confirm(
      'Сохранение общей корректировки дня снимет все корректировки по объектам. Продолжить?',
    )) return;
    onSave(status, hours, notes, files);
  };
  const showEventsTab = !hideSkudTab;
  const showCorrectionTab = !hideCorrectionTab;
  const [tab, setTab] = useState<ModalTab>(() => {
    if (!showEventsTab && showCorrectionTab) return 'correction';
    if (showCorrectionTab && correctionInfo?.is_correction) return 'correction';
    return 'events';
  });
  // Верхний уровень вкладок: «Передвижения» (если есть проблемы) ⇄ «Корректировки».
  // По умолчанию открываем «Передвижения». Контейнер модалки от topTab не зависит,
  // поэтому размер при переключении не меняется.
  const [topTab, setTopTab] = useState<'travel' | 'correction'>(showTravelTab ? 'travel' : 'correction');
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
  // Файлы прикрепляются ТОЛЬКО в форме создания корректировки (staged-picker, #5).
  // У уже сохранённой корректировки блок лишь отображает вложения — без кнопки
  // «Прикрепить»; при отсутствии файлов CorrectionAttachments вернёт null (блок скрыт).
  const attachmentsCanEdit = false;

  // Плашка «автор последней корректировки + время» — раньше висела sticky под
  // шапкой модалки. Перенесена в правую колонку, чтобы не сдвигать шапку и
  // быть рядом с самим списком корректировок.
  const correctionAuthorBlock = correctionInfo?.is_correction
    && (correctionInfo.corrected_by_name || correctionInfo.corrected_at) ? (
      <div className="ts-corr-card__author">
        <span className="ts-corr-card__author-avatar" aria-hidden>
          {(correctionInfo.corrected_by_name?.trim()?.[0] ?? '✎').toUpperCase()}
        </span>
        <span className="ts-corr-card__author-text">
          <span className="ts-corr-card__author-name">
            {correctionInfo.corrected_by_name || 'Корректировка'}
          </span>
          {correctionInfo.corrected_at && (
            <span className="ts-corr-card__author-date">{formatCorrectionDate(correctionInfo.corrected_at)}</span>
          )}
        </span>
      </div>
    ) : null;

  // Блок файлов корректировки. Для day-level формы передаётся слотом в CorrectionTab
  // (рендерится перед футером → «Сохранить» в самом низу, #1). Для objects-блока —
  // рендерится отдельно после списка.
  const attachmentsNode = adjustmentId ? (
    <CorrectionAttachments
      adjustmentId={adjustmentId}
      variant="modal"
      canEdit={attachmentsCanEdit}
    />
  ) : null;

  // Плашка согласования времени внизу модалки (#6).
  const approvalStatus = correctionInfo?.approval_status ?? null;
  const approvalMeta = [
    correctionInfo?.approved_by_name ?? null,
    correctionInfo?.approved_at ? formatCorrectionDate(correctionInfo.approved_at) : null,
  ].filter(Boolean).join(' • ');
  const approvalBanner = correctionInfo?.is_correction && approvalStatus ? (() => {
    if (approvalStatus === 'approved') {
      return (
        <div className="ts-corr-approval ts-corr-approval--approved">
          <span className="ts-corr-approval__icon">✓</span>
          <span>
            Время согласовано и зачтено в табель
            {approvalMeta && <span className="ts-corr-approval__meta">{approvalMeta}</span>}
          </span>
        </div>
      );
    }
    if (approvalStatus === 'auto_approved') {
      return (
        <div className="ts-corr-approval ts-corr-approval--approved">
          <span className="ts-corr-approval__icon">✓</span>
          <span>Время зачтено в табель</span>
        </div>
      );
    }
    if (approvalStatus === 'pending') {
      return (
        <div className="ts-corr-approval ts-corr-approval--pending">
          <span className="ts-corr-approval__icon">⏳</span>
          <span>Время на согласовании администратора</span>
        </div>
      );
    }
    if (approvalStatus === 'rejected') {
      return (
        <div className="ts-corr-approval ts-corr-approval--rejected">
          <span className="ts-corr-approval__icon">✗</span>
          <span>
            Корректировка отклонена
            {correctionInfo?.approval_comment && (
              <span className="ts-corr-approval__meta">{correctionInfo.approval_comment}</span>
            )}
          </span>
        </div>
      );
    }
    return null;
  })() : null;

  const correctionPanel = showCorrectionTab ? (
    <div className="ts-corr-card">
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
          attachmentsSlot={attachmentsNode}
          allowAttachmentsOnCreate={allowAttachmentsOnCreate}
          companionWorkRequest={companionWorkRequest}
          canAddRemote={canAddRemote}
          remoteDefaultHours={remoteDefaultHours}
          onAddRemote={onAddRemote}
          readOnly={readOnly}
          canEditReasonText={canEditReasonText}
          onUpdateReason={onUpdateReason}
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
          dayLevelStatus={timesheetEntry?.status ?? null}
          onDeleteDayLevel={hasDayLevelCorrection ? onDelete : undefined}
          plannedHours={plannedHours ?? null}
          onSaveObject={onSaveObject!}
          onDeleteObject={onDeleteObject!}
          onSaveDayLevel={onSave}
          onZeroOutDay={onZeroOutDay}
          preselectedObjectKey={preselectedObjectKey}
          initialMode={initialMode}
          allowedStatuses={allowedStatuses}
          readOnly={readOnly}
        />
      )}
      {hasObjectsBlock && attachmentsNode}
      {approvalBanner}
    </div>
  ) : null;

  // Содержимое вкладки «Корректировки» — обычное тело модалки (плашка + две колонки
  // либо под-вкладки События/Корректировка). Вынесено в переменную, чтобы при
  // showTravelTab рендерить ОБЕ панели одновременно (см. ts-modal-pane-stack).
  const correctionContent = (
      <>
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
                type="button"
                className={`ts-modal-tab ${tab === 'events' ? 'ts-modal-tab--active' : ''}`}
                onClick={() => setTab('events')}
              >
                События СКУД
              </button>
              <button
                type="button"
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
      </>
  );

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

      {employeeId && workDate && (
        <PresenceTimeline employeeId={employeeId} date={workDate} className="ts-modal-presence" />
      )}

      {showTravelTab && (
        <div className="ts-modal-tabs">
          <button
            type="button"
            className={`ts-modal-tab ${topTab === 'travel' ? 'ts-modal-tab--active' : ''}`}
            onClick={() => setTopTab('travel')}
          >
            Передвижения
          </button>
          <button
            type="button"
            className={`ts-modal-tab ${topTab === 'correction' ? 'ts-modal-tab--active' : ''}`}
            onClick={() => setTopTab('correction')}
          >
            Корректировки
          </button>
        </div>
      )}

      {showTravelTab ? (
        // Обе панели смонтированы в одной grid-ячейке: контейнер держит высоту большей,
        // неактивная скрыта visibility (без ремоунта). Переключение вкладок не меняет
        // размер модалки и не промаргивает контент.
        <div className="ts-modal-pane-stack">
          <div className={`ts-modal-pane${topTab === 'travel' ? '' : ' ts-modal-pane--hidden'}`}>
            <div className="ts-modal-body ts-modal-body--travel">
              <TravelSegmentsPanel employeeId={employeeId ?? null} workDate={workDate ?? null} />
            </div>
          </div>
          <div className={`ts-modal-pane${topTab === 'correction' ? '' : ' ts-modal-pane--hidden'}`}>
            {correctionContent}
          </div>
        </div>
      ) : correctionContent}
    </div>
  );
};

export const TimesheetCorrectionModal: FC<ICorrectionModalProps> = ({ open, ...rest }) => {
  const overlayMouseDownRef = useRef(false);
  if (!open) return null;
  return (
    <div
      className={`ts-modal-overlay ts-modal-overlay--open${rest.showTravelTab ? ' ts-modal-overlay--top' : ''}`}
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
