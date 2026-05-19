import { type FC, useState, useMemo, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X, RotateCcw, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import type { TimesheetEntry, TimesheetEmployee } from '../../types';
import {
  timesheetApprovalService,
  APPROVAL_STATUS_LABELS,
  type TimesheetApprovalStatus,
  type IApprovalReviewItem,
} from '../../services/timesheetApprovalService';
import {
  correctionApprovalService,
  type ICorrectionDepartmentGroup,
  type ICorrectionPendingItem,
  type IBulkResult,
} from '../../services/correctionApprovalService';
import { timesheetService } from '../../services/timesheetService';
import { TimesheetGrid } from '../../components/timesheet/TimesheetGrid';
import { ApprovalCommentModal } from './ApprovalCommentModal';
const TimesheetCorrectionModal = lazy(() => import('../../components/timesheet/TimesheetCorrectionModal').then(module => ({
  default: module.TimesheetCorrectionModal,
})));
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  getMonthBounds,
  listDatesInRange,
  getHalfRange,
  formatHalfLabel,
  getCurrentHalf,
  type TimesheetHalf,
  type ITimesheetDateRange,
} from '../../utils/timesheetApprovalPeriod';
import { getMonthLabel } from '../../utils/calendarUtils';
import './ApprovalsPage.css';

type Tab = 'corrections' | 'timesheets';

const TIMESHEET_STATUS_TABS: Array<{ code: TimesheetApprovalStatus; label: string }> = [
  { code: 'submitted', label: 'На проверке' },
  { code: 'approved', label: 'Утверждённые' },
  { code: 'rejected', label: 'Отклонённые / на доработке' },
];

const STATUS_LABELS: Record<string, string> = {
  work: 'Присутствие',
  remote: 'Удалёнка',
  sick: 'Больничный',
  vacation: 'Отпуск',
  absent: 'Неявка',
  manual: 'Ручная корр.',
  dayoff: 'Отгул',
  unpaid: 'За свой счёт',
  educational_leave: 'Учебный отпуск',
};

const STATUS_ICONS: Record<string, string> = {
  work: '✔',
  remote: '🏠',
  sick: '🏥',
  vacation: '🏖',
  absent: '❌',
  manual: '✏️',
  dayoff: '📅',
  unpaid: '💸',
  educational_leave: '🎓',
};

const formatDate = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const WEEKDAY_SHORT_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTH_GENITIVE_SHORT_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const formatDateWithWeekday = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00');
  return `${formatDate(iso)} (${WEEKDAY_SHORT_RU[d.getDay()]})`;
};

const formatDateCompact = (iso: string): { day: string; weekday: string } => {
  const d = new Date(iso + 'T00:00:00');
  return {
    day: `${d.getDate()} ${MONTH_GENITIVE_SHORT_RU[d.getMonth()]}`,
    weekday: WEEKDAY_SHORT_RU[d.getDay()].toLowerCase(),
  };
};

const formatDateTimeShort = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getDate();
  const m = MONTH_GENITIVE_SHORT_RU[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${m}, ${hh}:${mm}`;
};

const formatHM = (decimal: number | null): string => {
  if (decimal == null) return '—';
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

interface IGroupCheckboxProps {
  state: 'none' | 'partial' | 'all';
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}

const GroupCheckbox: FC<IGroupCheckboxProps> = ({ state, onChange, ariaLabel }) => {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'partial';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="cor-dept-check"
      checked={state === 'all'}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={ariaLabel}
    />
  );
};

const formatBulkToast = (verb: 'Утверждено' | 'Отклонено' | 'Возвращено', data: IBulkResult): string => {
  const skipped = data.skipped_not_pending + data.skipped_no_access;
  if (skipped > 0) return `${verb}: ${data.processed_count} (пропущено: ${skipped})`;
  return `${verb}: ${data.processed_count}`;
};

interface ICorrectionsTabProps {
  period: ITimesheetDateRange;
}

const CorrectionsTab: FC<ICorrectionsTabProps> = ({ period }) => {
  const { hasPermission } = useAuth();
  const canReview = hasPermission('timesheet.workflow.review');
  const queryClient = useQueryClient();
  const toast = useToast();

  const [view, setView] = useState<'pending' | 'history'>('pending');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const toggleNotes = (id: number) => {
    setExpandedNotes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    queueMicrotask(() => setSelectedIds(new Set()));
  }, [period.startDate, period.endDate]);

  const query = useQuery({
    queryKey: ['correction-approvals', view, period.startDate, period.endDate],
    queryFn: () => view === 'pending'
      ? correctionApprovalService.getPendingByDepartment(period.startDate, period.endDate)
      : correctionApprovalService.getHistoryByDepartment(period.startDate, period.endDate),
  });

  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['correction-approvals'] }),
    queryClient.invalidateQueries({ queryKey: ['approval-timesheet'] }),
    queryClient.invalidateQueries({ queryKey: ['approvals-review-list'] }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
  ]);

  const clearProcessedIds = (ids: number[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  };

  const bulkApproveSelectedMutation = useMutation({
    mutationFn: (ids: number[]) => correctionApprovalService.bulkApproveByIds(ids),
    onSuccess: async (data, variables) => {
      await invalidate();
      toast.success?.(formatBulkToast('Утверждено', data));
      clearProcessedIds(variables);
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка массового согласования'),
  });

  const bulkRejectSelectedMutation = useMutation({
    mutationFn: (ids: number[]) => correctionApprovalService.bulkRejectByIds(ids),
    onSuccess: async (data, variables) => {
      await invalidate();
      toast.success?.(formatBulkToast('Отклонено', data));
      clearProcessedIds(variables);
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка массового отклонения'),
  });

  const bulkRevertSelectedMutation = useMutation({
    mutationFn: (ids: number[]) => correctionApprovalService.bulkRevertByIds(ids),
    onSuccess: async (data, variables) => {
      await invalidate();
      toast.success?.(formatBulkToast('Возвращено', data));
      clearProcessedIds(variables);
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка массового отката'),
  });

  const groups: ICorrectionDepartmentGroup[] = useMemo(() => query.data ?? [], [query.data]);

  const toggleId = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (group: ICorrectionDepartmentGroup, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const item of group.items) {
        if (checked) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  };

  const groupSelectionState = (group: ICorrectionDepartmentGroup): 'none' | 'partial' | 'all' => {
    if (group.items.length === 0) return 'none';
    let count = 0;
    for (const item of group.items) {
      if (selectedIds.has(item.id)) count++;
    }
    if (count === 0) return 'none';
    if (count === group.items.length) return 'all';
    return 'partial';
  };

  const allItemIds = useMemo(() => {
    const ids: number[] = [];
    for (const g of groups) for (const it of g.items) ids.push(it.id);
    return ids;
  }, [groups]);

  const totalEmployees = useMemo(() => {
    const ids = new Set<number>();
    for (const g of groups) for (const it of g.items) ids.add(it.employee_id);
    return ids.size;
  }, [groups]);

  const allSelectionState: 'none' | 'partial' | 'all' = useMemo(() => {
    if (allItemIds.length === 0) return 'none';
    let count = 0;
    for (const id of allItemIds) if (selectedIds.has(id)) count++;
    if (count === 0) return 'none';
    if (count === allItemIds.length) return 'all';
    return 'partial';
  }, [allItemIds, selectedIds]);

  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(allItemIds) : new Set());
  };

  const bulkPending = bulkApproveSelectedMutation.isPending
    || bulkRejectSelectedMutation.isPending
    || bulkRevertSelectedMutation.isPending;
  const isHistory = view === 'history';
  const canSelect = canReview;

  return (
    <>
      <div className="approvals-toolbar cor-toolbar">
        <div className="cor-view-tabs" role="tablist" aria-label="Раздел согласования">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'pending'}
            className={`cor-view-tab${view === 'pending' ? ' is-active' : ''}`}
            onClick={() => { if (view !== 'pending') { setSelectedIds(new Set()); setView('pending'); } }}
          >
            На проверке
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'history'}
            className={`cor-view-tab${view === 'history' ? ' is-active' : ''}`}
            onClick={() => { if (view !== 'history') { setSelectedIds(new Set()); setView('history'); } }}
          >
            История
          </button>
        </div>

        {canSelect && groups.length > 0 && (
          <div className="cor-actionbar">
            <GroupCheckbox
              state={allSelectionState}
              onChange={toggleAll}
              ariaLabel="Выбрать все выходные дни во всех отделах"
            />
            <span className="cor-actionbar-summary">
              {selectedIds.size > 0 ? (
                <>Выбрано: <b>{selectedIds.size}</b></>
              ) : (
                <><b>{allItemIds.length}</b> в <b>{groups.length}</b> отд. · <b>{totalEmployees}</b> чел</>
              )}
            </span>
            <div className="cor-actionbar-btns">
              {!isHistory ? (
                <>
                  <button
                    type="button"
                    className="cor-actionbar-btn cor-actionbar-btn--approve"
                    onClick={() => bulkApproveSelectedMutation.mutate([...selectedIds])}
                    disabled={selectedIds.size === 0 || bulkPending}
                  >
                    <Check size={15} />
                    {selectedIds.size > 0 ? `Утвердить выбранные (${selectedIds.size})` : 'Утвердить выбранные'}
                  </button>
                  <button
                    type="button"
                    className="cor-actionbar-btn cor-actionbar-btn--reject"
                    onClick={() => bulkRejectSelectedMutation.mutate([...selectedIds])}
                    disabled={selectedIds.size === 0 || bulkPending}
                  >
                    <X size={15} />
                    {selectedIds.size > 0 ? `Отклонить выбранные (${selectedIds.size})` : 'Отклонить выбранные'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="cor-actionbar-btn cor-actionbar-btn--revert"
                  onClick={() => bulkRevertSelectedMutation.mutate([...selectedIds])}
                  disabled={selectedIds.size === 0 || bulkPending}
                >
                  <RotateCcw size={15} />
                  {selectedIds.size > 0 ? `Вернуть выбранные (${selectedIds.size})` : 'Вернуть выбранные'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {query.isLoading ? (
        <div className="approvals-empty">Загрузка…</div>
      ) : query.isError ? (
        <div className="approvals-empty">Ошибка загрузки</div>
      ) : groups.length === 0 ? (
        <div className="approvals-empty">
          {isHistory ? 'В истории за период ничего нет' : 'Нет выходных дней на согласовании за период'}
        </div>
      ) : (
        <ul className="approvals-list">
          {groups.map(group => {
            const isOpen = !!expanded[group.department_id];
            return (
              <li key={group.department_id} className="cor-dept-card">
                <div className={`cor-dept-header${isOpen ? ' cor-dept-header--expanded' : ''}`}>
                  {canSelect && (
                    <GroupCheckbox
                      state={groupSelectionState(group)}
                      onChange={(checked) => toggleGroup(group, checked)}
                      ariaLabel={`Выбрать все в отделе ${group.department_name}`}
                    />
                  )}
                  <button
                    type="button"
                    className="cor-dept-toggle"
                    onClick={() => setExpanded(s => ({ ...s, [group.department_id]: !isOpen }))}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    <span className="cor-dept-name" title={group.department_name}>{group.department_name}</span>
                  </button>
                  <span
                    className="cor-dept-stats"
                    title={`Записей: ${group.pending_count} · Сотрудников: ${group.employees_count}`}
                  >
                    {group.pending_count} · {group.employees_count}&thinsp;чел
                  </span>
                </div>

                {isOpen && (
                  <ul className="cor-items">
                    {group.items.map((item: ICorrectionPendingItem) => {
                      const trimmed = (item.notes ?? '').trim();
                      const isShort = trimmed.length > 0 && trimmed.length < 10;
                      const noNotes = trimmed.length === 0;
                      const decisionMod = isHistory && item.approval_status === 'approved'
                        ? ' cor-item--decided-approved'
                        : isHistory && item.approval_status === 'rejected'
                          ? ' cor-item--decided-rejected'
                          : '';
                      const warningMod = !isHistory
                        ? (noNotes ? ' cor-item--no-notes' : isShort ? ' cor-item--short-notes' : '')
                        : '';
                      const itemMods = `${warningMod}${decisionMod}`;
                      const notesExpanded = expandedNotes.has(item.id);
                      const hours = formatHM(item.hours_override);
                      const dateParts = formatDateCompact(item.work_date);
                      const showAuthor = !!item.created_by_name && item.created_by_name !== item.employee_name;
                      const decisionLabel = item.approval_status === 'approved' ? 'Утв.' : item.approval_status === 'rejected' ? 'Откл.' : '';
                      return (
                        <li key={item.id} className={`cor-item${itemMods}`}>
                          {canSelect && (
                            <input
                              type="checkbox"
                              className="cor-item-check"
                              checked={selectedIds.has(item.id)}
                              onChange={() => toggleId(item.id)}
                              aria-label={`Выбрать корректировку ${item.employee_name ?? item.employee_id} ${item.work_date}`}
                            />
                          )}
                          <span className="cor-item-date" data-hours={hours}>
                            <span className="cor-item-date-day">{dateParts.day}</span>
                            <span className="cor-item-date-wd">{dateParts.weekday}</span>
                          </span>
                          <span className="cor-item-employee">{item.employee_name ?? `#${item.employee_id}`}</span>
                          <div className="cor-item-task">
                            <span className="cor-item-task-caption">Формат</span>
                            <span className={`cor-item-status cor-item-status--${item.status}`}>
                              <span className="cor-item-status-icon" aria-hidden="true">{STATUS_ICONS[item.status] ?? '•'}</span>
                              <span className="cor-item-status-label">{STATUS_LABELS[item.status] ?? item.status}</span>
                            </span>
                          </div>
                          <span className="cor-item-hours">{hours}</span>
                          <div
                            className={`cor-item-notes${noNotes ? ' cor-item-notes--empty' : ''}${isShort && !isHistory ? ' cor-item-notes--short' : ''}${notesExpanded ? ' cor-item-notes--expanded' : ''}`}
                            onClick={() => toggleNotes(item.id)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleNotes(item.id); } }}
                          >
                            <span className="cor-item-notes-caption">Задача</span>
                            {noNotes ? (
                              <span className="cor-item-notes-placeholder">Без комментария</span>
                            ) : (
                              <span className="cor-item-notes-text">{trimmed}</span>
                            )}
                            {showAuthor && (
                              <span className="cor-item-notes-author">— {item.created_by_name}</span>
                            )}
                            {isHistory && (item.approved_by_name || item.approved_at) && (
                              <span className={`cor-item-decision cor-item-decision--${item.approval_status}`}>
                                {item.approval_status === 'approved' ? <Check size={11} /> : <X size={11} />}
                                <span className="cor-item-decision-label">{decisionLabel}</span>
                                {item.approved_by_name && <span className="cor-item-decision-by">{item.approved_by_name}</span>}
                                {item.approved_at && <span className="cor-item-decision-at">· {formatDateTimeShort(item.approved_at)}</span>}
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
};

interface IApprovalCardBodyProps {
  row: IApprovalReviewItem;
  canReview: boolean;
  isApproving: boolean;
  isRejecting: boolean;
  isReturning: boolean;
  onApprove: () => void;
  onSendToRework: () => void;
  onReturnApproved: () => void;
}

const ApprovalCardBody: FC<IApprovalCardBodyProps> = ({
  row,
  canReview,
  isApproving,
  isRejecting,
  isReturning,
  onApprove,
  onSendToRework,
  onReturnApproved,
}) => {
  const isMobile = useIsMobile(768);
  const startDate = useMemo(() => new Date(row.start_date + 'T00:00:00'), [row.start_date]);
  const year = startDate.getFullYear();
  const month = startDate.getMonth() + 1;
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const monthBounds = useMemo(() => getMonthBounds(monthStr), [monthStr]);

  const tsQuery = useQuery({
    queryKey: ['approval-timesheet', row.id],
    queryFn: () => timesheetService.getAll({
      month: monthStr,
      department_id: row.department_id,
      from: monthBounds?.firstDate ?? row.start_date,
      to: monthBounds?.lastDate ?? row.end_date,
      include_objects: true,
      schedule_payload: 'compact',
    }),
    staleTime: 30_000,
  });

  const outOfPeriodDates = useMemo(() => {
    const set = new Set<string>();
    if (!monthBounds) return set;
    for (const d of listDatesInRange(monthBounds.firstDate, monthBounds.lastDate)) {
      if (d < row.start_date || d > row.end_date) set.add(d);
    }
    return set;
  }, [monthBounds, row.start_date, row.end_date]);

  const problemDates = useMemo(() => {
    const yellow = new Set<string>();
    const red = new Set<string>();
    const pendingWeekendSet = new Set(row.pending_weekend_dates);
    const approvedWeekendSet = new Set(row.approved_weekend_dates);
    const largeCorrSet = new Set(row.large_correction_dates);
    for (const e of tsQuery.data?.entries ?? []) {
      if (outOfPeriodDates.has(e.work_date)) continue;
      if (!e.is_correction) continue;
      const key = `${e.employee_id}_${e.work_date}`;
      if (pendingWeekendSet.has(e.work_date) && e.approval_status === 'pending') {
        red.add(key);
      } else if (approvedWeekendSet.has(e.work_date) && e.approval_status === 'approved') {
        yellow.add(key);
      } else if (largeCorrSet.has(e.work_date)) {
        yellow.add(key);
      }
    }
    return { yellow, red };
  }, [row.pending_weekend_dates, row.approved_weekend_dates, row.large_correction_dates, tsQuery.data?.entries, outOfPeriodDates]);

  const [dayModal, setDayModal] = useState<{
    employee: TimesheetEmployee;
    day: number;
    entry: TimesheetEntry | null;
  } | null>(null);

  const dayModalDate = dayModal
    ? `${year}-${String(month).padStart(2, '0')}-${String(dayModal.day).padStart(2, '0')}`
    : null;

  const hasPendingWeekend = row.pending_weekend_dates.length > 0;

  return (
    <div className="approvals-card-body">
      {hasPendingWeekend && (
        <div className="approvals-flags">
          <span className="approvals-flag approvals-flag--yellow">
            <Clock size={12} /> На рассмотрении (выходные/праздники): {row.pending_weekend_dates.map(formatDate).join(', ')}
          </span>
        </div>
      )}

      {row.review_comment && (
        <div className="approvals-comment">Комментарий: {row.review_comment}</div>
      )}

      <div className="approvals-timesheet-frame">
        {tsQuery.isLoading ? (
          <div className="approvals-timesheet-loading">Загрузка табеля…</div>
        ) : tsQuery.isError ? (
          <div className="approvals-timesheet-error">
            Не удалось загрузить табель: {tsQuery.error instanceof Error ? tsQuery.error.message : 'ошибка'}
          </div>
        ) : tsQuery.data ? (
          <TimesheetGrid
            employees={tsQuery.data.employees}
            entries={tsQuery.data.entries}
            objectEntries={tsQuery.data.object_entries}
            employeeStats={tsQuery.data.employee_stats}
            year={year}
            month={month}
            schedules={tsQuery.data.schedules}
            dailySchedules={tsQuery.data.daily_schedules}
            calendar={tsQuery.data.calendar}
            compact={isMobile}
            problemDates={problemDates}
            outOfPeriodDates={outOfPeriodDates}
            highlightedCell={null}
            onEmployeeClick={() => {}}
            onDayClick={(emp, day, entry) => setDayModal({ employee: emp, day, entry })}
            onObjectDayClick={() => {}}
          />
        ) : null}
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
          dayLabel={dayModalDate ? formatDateWithWeekday(dayModalDate) : undefined}
          timesheetEntry={dayModal?.entry ?? null}
          allowAccessPointMap={false}
        />
      </Suspense>

      {canReview && (
        <div className="approvals-actions">
          {row.status === 'submitted' && (
            <>
              <button
                type="button"
                className="approvals-action-btn approvals-action-btn--approve"
                onClick={onApprove}
                disabled={isApproving || hasPendingWeekend}
                title={hasPendingWeekend ? 'Корректировки на выходных/праздниках на рассмотрении — попросите второго админа согласовать' : undefined}
              >
                <Check size={16} /> Утвердить
              </button>
              <button
                type="button"
                className="approvals-action-btn approvals-action-btn--rework"
                onClick={onSendToRework}
                disabled={isRejecting}
              >
                <RotateCcw size={16} /> На доработку
              </button>
            </>
          )}
          {row.status === 'approved' && (
            <button
              type="button"
              className="approvals-action-btn approvals-action-btn--rework"
              onClick={onReturnApproved}
              disabled={isReturning}
            >
              <RotateCcw size={16} /> Вернуть на доработку
            </button>
          )}
        </div>
      )}
    </div>
  );
};

interface ITimesheetsTabProps {
  period: ITimesheetDateRange;
}

const TimesheetsTab: FC<ITimesheetsTabProps> = ({ period }) => {
  const { hasPermission } = useAuth();
  const canReview = hasPermission('timesheet.workflow.review');
  const queryClient = useQueryClient();
  const toast = useToast();

  const [status, setStatus] = useState<TimesheetApprovalStatus>('submitted');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [commentModal, setCommentModal] = useState<{ row: IApprovalReviewItem; mode: 'rework' | 'return' } | null>(null);

  // Сброс раскрытой строки при смене периода — паттерн «состояние из
  // прошлого рендера» вместо setState-в-effect (react.dev «You Might Not
  // Need an Effect»).
  const periodKey = `${period.startDate}|${period.endDate}`;
  const [prevPeriodKey, setPrevPeriodKey] = useState(periodKey);
  if (prevPeriodKey !== periodKey) {
    setPrevPeriodKey(periodKey);
    setExpandedId(null);
  }

  const query = useQuery({
    queryKey: ['approvals-review-list', status, period.startDate, period.endDate],
    queryFn: () => timesheetApprovalService.getReviewList(status, period.startDate, period.endDate),
  });

  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['approvals-review-list'] }),
    queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] }),
  ]);

  const approveMutation = useMutation({
    mutationFn: (id: number) => timesheetApprovalService.approve(id),
    onSuccess: async () => { await invalidate(); toast.success?.('Табель утверждён'); },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка утверждения'),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) => timesheetApprovalService.reject(id, comment),
    onSuccess: async () => {
      await invalidate();
      toast.success?.('Табель отправлен на доработку');
      setCommentModal(null);
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка отправки на доработку'),
  });

  const returnMutation = useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) => timesheetApprovalService.returnToRework(id, comment),
    onSuccess: async () => {
      await invalidate();
      toast.success?.('Возвращено на доработку');
      setCommentModal(null);
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка возврата'),
  });

  const rows: IApprovalReviewItem[] = useMemo(() => query.data ?? [], [query.data]);

  const handleConfirmComment = (comment: string) => {
    if (!commentModal) return;
    if (commentModal.mode === 'rework') {
      rejectMutation.mutate({ id: commentModal.row.id, comment });
    } else {
      returnMutation.mutate({ id: commentModal.row.id, comment });
    }
  };

  const severity = (row: IApprovalReviewItem): 'red' | 'yellow' | 'green' => {
    if (row.problem_flags.correction_exceeds_skud) return 'red';
    if (row.problem_flags.any_correction || row.problem_flags.absent_days) return 'yellow';
    return 'green';
  };

  return (
    <>
      <div className="approvals-tabs">
        {TIMESHEET_STATUS_TABS.map(tab => (
          <button
            key={tab.code}
            type="button"
            className={`approvals-tab${status === tab.code ? ' approvals-tab--active' : ''}`}
            onClick={() => setStatus(tab.code)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <div className="approvals-empty">Загрузка…</div>
      ) : query.isError ? (
        <div className="approvals-empty">Ошибка загрузки</div>
      ) : rows.length === 0 ? (
        <div className="approvals-empty">Нет подач в этом статусе</div>
      ) : (
        <ul className="approvals-list">
          {rows.map(row => {
            const sev = severity(row);
            const expanded = expandedId === row.id;
            return (
              <li key={row.id} className={`approvals-card approvals-card--${sev}`}>
                <button
                  type="button"
                  className="approvals-card-header"
                  onClick={() => setExpandedId(expanded ? null : row.id)}
                >
                  <span className="approvals-card-badge" aria-label={`Серьёзность: ${sev}`} />
                  <div className="approvals-card-info">
                    <strong>{row.department_name ?? row.department_id}</strong>
                    <span className="approvals-card-range">{formatDate(row.start_date)} — {formatDate(row.end_date)}</span>
                  </div>
                  <span className="approvals-card-status">{APPROVAL_STATUS_LABELS[row.status]}</span>
                  {row.status === 'approved' && canReview && (
                    <span
                      className="approvals-card-return-hint"
                      title="Можно вернуть на доработку — раскройте карточку"
                      aria-label="Можно вернуть на доработку"
                    >
                      <RotateCcw size={14} />
                    </span>
                  )}
                  <span className="approvals-card-submitted">
                    {row.status === 'submitted'
                      ? `${row.submitted_by_name ?? '—'}${row.submitted_at ? `, ${formatDate(row.submitted_at.slice(0, 10))}` : ''}`
                      : `${row.reviewed_by_name ?? row.submitted_by_name ?? '—'}${row.reviewed_at ? `, ${formatDate(row.reviewed_at.slice(0, 10))}` : ''}`}
                  </span>
                  {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>

                {expanded && (
                  <ApprovalCardBody
                    row={row}
                    canReview={canReview}
                    isApproving={approveMutation.isPending}
                    isRejecting={rejectMutation.isPending}
                    isReturning={returnMutation.isPending}
                    onApprove={() => approveMutation.mutate(row.id)}
                    onSendToRework={() => setCommentModal({ row, mode: 'rework' })}
                    onReturnApproved={() => setCommentModal({ row, mode: 'return' })}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ApprovalCommentModal
        open={commentModal !== null}
        title={commentModal?.mode === 'return' ? 'Вернуть на доработку' : 'Отправить на доработку'}
        label={commentModal?.mode === 'return' ? 'Комментарий (причина возврата):' : 'Комментарий (что нужно доработать):'}
        pending={rejectMutation.isPending || returnMutation.isPending}
        onClose={() => setCommentModal(null)}
        onConfirm={handleConfirmComment}
      />
    </>
  );
};

export const ApprovalsPage: FC = () => {
  const [tab, setTab] = useState<Tab>('corrections');

  const initial = useMemo(() => getCurrentHalf(new Date()), []);
  const [year, setYear] = useState<number>(initial.year);
  const [month, setMonth] = useState<number>(initial.month);
  const [half, setHalf] = useState<TimesheetHalf>(initial.half);

  const period = useMemo(() => getHalfRange(year, month, half), [year, month, half]);
  const correctionsPeriod = useMemo(() => getHalfRange(year, month, 'FULL'), [year, month]);

  const goPrevMonth = useCallback(() => {
    if (month === 1) {
      setYear(y => y - 1);
      setMonth(12);
    } else {
      setMonth(m => m - 1);
    }
  }, [month]);

  const goNextMonth = useCallback(() => {
    if (month === 12) {
      setYear(y => y + 1);
      setMonth(1);
    } else {
      setMonth(m => m + 1);
    }
  }, [month]);

  return (
    <div className="approvals-page">
      <div className="approvals-tabs">
        <button
          type="button"
          className={`approvals-tab${tab === 'corrections' ? ' approvals-tab--active' : ''}`}
          onClick={() => setTab('corrections')}
        >
          Выходные дни
        </button>
        <button
          type="button"
          className={`approvals-tab${tab === 'timesheets' ? ' approvals-tab--active' : ''}`}
          onClick={() => setTab('timesheets')}
        >
          Табели
        </button>
      </div>

      <div className="approvals-period">
        <div className="approvals-period-month-nav" role="group" aria-label="Месяц">
          <button
            type="button"
            className="approvals-period-month-btn"
            onClick={goPrevMonth}
            aria-label="Предыдущий месяц"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="approvals-period-month-label">{getMonthLabel(year, month)}</span>
          <button
            type="button"
            className="approvals-period-month-btn"
            onClick={goNextMonth}
            aria-label="Следующий месяц"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        {tab === 'timesheets' && (
          <section className="approvals-period-half-toggle" aria-label="Период согласования">
            <button
              type="button"
              className={`approvals-period-half-chip${half === 'H1' ? ' approvals-period-half-chip--active' : ''}`}
              onClick={() => setHalf('H1')}
            >
              {formatHalfLabel(year, month, 'H1')}
            </button>
            <button
              type="button"
              className={`approvals-period-half-chip${half === 'H2' ? ' approvals-period-half-chip--active' : ''}`}
              onClick={() => setHalf('H2')}
            >
              {formatHalfLabel(year, month, 'H2')}
            </button>
            <button
              type="button"
              className={`approvals-period-half-chip${half === 'FULL' ? ' approvals-period-half-chip--active' : ''}`}
              onClick={() => setHalf('FULL')}
            >
              {formatHalfLabel(year, month, 'FULL')}
            </button>
          </section>
        )}
      </div>

      {tab === 'corrections'
        ? <CorrectionsTab period={correctionsPeriod} />
        : <TimesheetsTab period={period} />}
    </div>
  );
};
