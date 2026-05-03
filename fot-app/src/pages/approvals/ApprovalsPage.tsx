import { type FC, useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X, RotateCcw, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, AlertTriangle, Pencil, UserX } from 'lucide-react';
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
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { getMonthBounds, listDatesInRange } from '../../utils/timesheetApprovalPeriod';
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

const formatDateWithWeekday = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00');
  return `${formatDate(iso)} (${WEEKDAY_SHORT_RU[d.getDay()]})`;
};

const formatHM = (decimal: number | null): string => {
  if (decimal == null) return '—';
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

function monthRange(year: number, month: number): { startDate: string; endDate: string } {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { startDate: fmt(start), endDate: fmt(end) };
}

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

const formatBulkToast = (verb: 'Утверждено' | 'Отклонено', data: IBulkResult): string => {
  const skipped = data.skipped_not_pending + data.skipped_no_access;
  if (skipped > 0) return `${verb}: ${data.processed_count} (пропущено: ${skipped})`;
  return `${verb}: ${data.processed_count}`;
};

const CorrectionsTab: FC = () => {
  const { hasPermission } = useAuth();
  const canReview = hasPermission('timesheet.workflow.review');
  const queryClient = useQueryClient();
  const toast = useToast();

  const now = useMemo(() => new Date(), []);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [period, setPeriod] = useState(() => monthRange(now.getFullYear(), now.getMonth() + 1));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    setPeriod(monthRange(year, month));
  }, [year, month]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [period.startDate, period.endDate]);

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  const query = useQuery({
    queryKey: ['correction-approvals', period.startDate, period.endDate],
    queryFn: () => correctionApprovalService.getPendingByDepartment(period.startDate, period.endDate),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['correction-approvals'] });

  const approveMutation = useMutation({
    mutationFn: (id: number) => correctionApprovalService.approve(id),
    onSuccess: async () => { await invalidate(); toast.success?.('Корректировка утверждена'); },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка утверждения'),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: number) => correctionApprovalService.reject(id),
    onSuccess: async () => { await invalidate(); toast.success?.('Корректировка отклонена'); },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка отклонения'),
  });

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

  const bulkPending = bulkApproveSelectedMutation.isPending || bulkRejectSelectedMutation.isPending;

  return (
    <>
      <div className="approvals-toolbar">
        <div className="approvals-month-nav">
          <button type="button" className="approvals-month-btn" onClick={prevMonth} aria-label="Предыдущий месяц">
            <ChevronLeft size={16} />
          </button>
          <span className="approvals-month-label">{getMonthLabel(year, month)}</span>
          <button type="button" className="approvals-month-btn" onClick={nextMonth} aria-label="Следующий месяц">
            <ChevronRight size={16} />
          </button>
        </div>
        <label>
          С
          <input
            type="date"
            value={period.startDate}
            onChange={e => setPeriod(p => ({ ...p, startDate: e.target.value }))}
          />
        </label>
        <label>
          По
          <input
            type="date"
            value={period.endDate}
            onChange={e => setPeriod(p => ({ ...p, endDate: e.target.value }))}
          />
        </label>
      </div>

      {query.isLoading ? (
        <div className="approvals-empty">Загрузка…</div>
      ) : query.isError ? (
        <div className="approvals-empty">Ошибка загрузки</div>
      ) : groups.length === 0 ? (
        <div className="approvals-empty">Нет выходных дней на согласовании за период</div>
      ) : (
        <ul className="approvals-list">
          {groups.map(group => {
            const isOpen = !!expanded[group.department_id];
            return (
              <li key={group.department_id} className="cor-dept-card">
                <div className={`cor-dept-header${isOpen ? ' cor-dept-header--expanded' : ''}`}>
                  {canReview && (
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
                  >
                    {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    <span className="cor-dept-name">{group.department_name}</span>
                    <span className="cor-dept-stats">
                      Выходных дней: <b>{group.pending_count}</b> • Сотрудников: <b>{group.employees_count}</b>
                    </span>
                  </button>
                  {canReview && (
                    <button
                      type="button"
                      className="cor-dept-bulk"
                      onClick={() => bulkApproveSelectedMutation.mutate(group.items.map(item => item.id))}
                      disabled={bulkPending || group.items.length === 0}
                    >
                      <Check size={14} /> Утвердить все ({group.pending_count})
                    </button>
                  )}
                </div>

                {isOpen && (
                  <ul className="cor-items">
                    {group.items.map((item: ICorrectionPendingItem) => {
                      const trimmed = (item.notes ?? '').trim();
                      const isShort = trimmed.length > 0 && trimmed.length < 10;
                      const noNotes = trimmed.length === 0;
                      return (
                        <li key={item.id} className="cor-item">
                          {canReview && (
                            <input
                              type="checkbox"
                              className="cor-item-check"
                              checked={selectedIds.has(item.id)}
                              onChange={() => toggleId(item.id)}
                              aria-label={`Выбрать корректировку ${item.employee_name ?? item.employee_id} ${item.work_date}`}
                            />
                          )}
                          <span className="cor-item-date">{formatDateWithWeekday(item.work_date)}</span>
                          <span className="cor-item-employee">{item.employee_name ?? `#${item.employee_id}`}</span>
                          <span className="cor-item-status">
                            {STATUS_ICONS[item.status] ?? '•'} {STATUS_LABELS[item.status] ?? item.status}
                          </span>
                          <span className="cor-item-hours">{formatHM(item.hours_override)}</span>
                          <div className={`cor-item-notes${isShort || noNotes ? ' cor-item-notes--short' : ''}`}>
                            <span>{trimmed || <em>без комментария</em>}</span>
                            {item.created_by_name && (
                              <span className="cor-item-notes-author">— {item.created_by_name}</span>
                            )}
                          </div>
                          {canReview && (
                            <div className="cor-item-actions">
                              <button
                                type="button"
                                className="cor-item-btn cor-item-btn--approve"
                                onClick={() => approveMutation.mutate(item.id)}
                                disabled={approveMutation.isPending}
                              >
                                <Check size={12} /> Утв.
                              </button>
                              <button
                                type="button"
                                className="cor-item-btn cor-item-btn--reject"
                                onClick={() => rejectMutation.mutate(item.id)}
                                disabled={rejectMutation.isPending}
                              >
                                <X size={12} /> Откл.
                              </button>
                            </div>
                          )}
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

      {canReview && selectedIds.size > 0 && (
        <div className="cor-bulk-bar">
          <span className="cor-bulk-count">Выбрано: <b>{selectedIds.size}</b></span>
          <button
            type="button"
            className="cor-bulk-btn cor-bulk-btn--approve"
            onClick={() => bulkApproveSelectedMutation.mutate([...selectedIds])}
            disabled={bulkPending}
          >
            <Check size={14} /> Утвердить выбранные
          </button>
          <button
            type="button"
            className="cor-bulk-btn cor-bulk-btn--reject"
            onClick={() => bulkRejectSelectedMutation.mutate([...selectedIds])}
            disabled={bulkPending}
          >
            <X size={14} /> Отклонить выбранные
          </button>
          <button
            type="button"
            className="cor-bulk-btn cor-bulk-btn--reset"
            onClick={() => setSelectedIds(new Set())}
            disabled={bulkPending}
          >
            Сбросить
          </button>
        </div>
      )}
    </>
  );
};

type ReviewItem =
  | {
      kind: 'correction';
      date: string;
      employee: TimesheetEmployee;
      hoursBefore: number | null;
      hoursAfter: number | null;
      author: string | null;
      correctedAt: string | null;
      notes: string | null;
      exceedsSkud: boolean;
    }
  | {
      kind: 'absent';
      date: string;
      employee: TimesheetEmployee;
    };

const parseTimeToHours = (value: string | null | undefined): number | null => {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = m[3] ? Number(m[3]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h + min / 60 + s / 3600;
};

const computeSkudHours = (entry: TimesheetEntry): number | null => {
  const start = parseTimeToHours(entry.first_entry);
  const end = parseTimeToHours(entry.last_exit);
  if (start == null || end == null) return null;
  const diff = end - start;
  return diff > 0 ? Math.round(diff * 100) / 100 : 0;
};

const formatHHMM = (decimal: number | null): string => {
  if (decimal == null) return '—';
  const totalMinutes = Math.round(decimal * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const buildReviewItems = (
  entries: TimesheetEntry[],
  employees: TimesheetEmployee[],
  outOfPeriodDates: Set<string>,
  rangeStart: string,
  rangeEnd: string,
): ReviewItem[] => {
  const empMap = new Map<number, TimesheetEmployee>(employees.map(e => [e.id, e]));
  const items: ReviewItem[] = [];
  for (const entry of entries) {
    if (outOfPeriodDates.has(entry.work_date)) continue;
    if (entry.work_date < rangeStart || entry.work_date > rangeEnd) continue;
    const employee = empMap.get(entry.employee_id);
    if (!employee) continue;
    if (entry.is_correction) {
      const hoursBefore = computeSkudHours(entry);
      const hoursAfter = entry.display_hours_worked ?? entry.hours_worked ?? null;
      const exceedsSkud = hoursBefore != null && hoursAfter != null && hoursAfter > hoursBefore + 0.0167;
      items.push({
        kind: 'correction',
        date: entry.work_date,
        employee,
        hoursBefore,
        hoursAfter,
        author: entry.corrected_by_name ?? null,
        correctedAt: entry.corrected_at ?? null,
        notes: entry.notes ?? null,
        exceedsSkud,
      });
    } else if (entry.status === 'absent') {
      items.push({ kind: 'absent', date: entry.work_date, employee });
    }
  }
  items.sort((a, b) => {
    const sevA = a.kind === 'correction' ? (a.exceedsSkud ? 0 : 1) : 2;
    const sevB = b.kind === 'correction' ? (b.exceedsSkud ? 0 : 1) : 2;
    if (sevA !== sevB) return sevA - sevB;
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.employee.full_name.localeCompare(b.employee.full_name, 'ru');
  });
  return items;
};

const formatCorrectedAt = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

interface IReviewChecklistProps {
  items: ReviewItem[];
  onJump: (employeeId: number, date: string) => void;
}

const ReviewChecklist: FC<IReviewChecklistProps> = ({ items, onJump }) => {
  if (items.length === 0) {
    return (
      <div className="approvals-checklist approvals-checklist--empty">
        <Check size={14} /> Без замечаний — табель чистый
      </div>
    );
  }
  return (
    <div className="approvals-checklist">
      <div className="approvals-checklist-head">
        К проверке <span className="approvals-checklist-count">{items.length}</span>
      </div>
      <ul className="approvals-checklist-list">
        {items.map((item, idx) => {
          if (item.kind === 'correction') {
            const cls = `approvals-checklist-item approvals-checklist-item--${item.exceedsSkud ? 'exceeds' : 'correction'}`;
            return (
              <li
                key={`${item.kind}-${item.employee.id}-${item.date}-${idx}`}
                className={cls}
                onClick={() => onJump(item.employee.id, item.date)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onJump(item.employee.id, item.date); } }}
              >
                <span className="approvals-checklist-icon" aria-hidden>
                  {item.exceedsSkud ? <AlertTriangle size={14} /> : <Pencil size={14} />}
                </span>
                <span className="approvals-checklist-date">{formatDateWithWeekday(item.date)}</span>
                <span className="approvals-checklist-employee">{item.employee.full_name}</span>
                <span className="approvals-checklist-diff">
                  <span className="approvals-checklist-diff-label">СКУД</span>
                  <span className="approvals-checklist-diff-before">{formatHHMM(item.hoursBefore)}</span>
                  <span className="approvals-checklist-diff-arrow">→</span>
                  <span className="approvals-checklist-diff-after">{formatHHMM(item.hoursAfter)}</span>
                  {item.exceedsSkud && (
                    <span className="approvals-checklist-tag">&gt; СКУД</span>
                  )}
                </span>
                <span className="approvals-checklist-meta">
                  {item.author && <span className="approvals-checklist-author">{item.author}</span>}
                  {item.correctedAt && <span className="approvals-checklist-time">{formatCorrectedAt(item.correctedAt)}</span>}
                  {item.notes && <span className="approvals-checklist-notes" title={item.notes}>«{item.notes}»</span>}
                </span>
              </li>
            );
          }
          return (
            <li
              key={`${item.kind}-${item.employee.id}-${item.date}-${idx}`}
              className="approvals-checklist-item approvals-checklist-item--absent"
              onClick={() => onJump(item.employee.id, item.date)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onJump(item.employee.id, item.date); } }}
            >
              <span className="approvals-checklist-icon" aria-hidden>
                <UserX size={14} />
              </span>
              <span className="approvals-checklist-date">{formatDateWithWeekday(item.date)}</span>
              <span className="approvals-checklist-employee">{item.employee.full_name}</span>
              <span className="approvals-checklist-diff approvals-checklist-diff--absent">отсутствие</span>
              <span className="approvals-checklist-meta" />
            </li>
          );
        })}
      </ul>
    </div>
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
    for (const d of row.weekend_work_dates) yellow.add(d);
    for (const e of tsQuery.data?.entries ?? []) {
      if (outOfPeriodDates.has(e.work_date)) continue;
      if (e.is_correction || e.status === 'absent') yellow.add(e.work_date);
    }
    return { yellow };
  }, [row.weekend_work_dates, tsQuery.data?.entries, outOfPeriodDates]);

  const reviewItems = useMemo<ReviewItem[]>(() => {
    if (!tsQuery.data) return [];
    return buildReviewItems(
      tsQuery.data.entries,
      tsQuery.data.employees,
      outOfPeriodDates,
      row.start_date,
      row.end_date,
    );
  }, [tsQuery.data, outOfPeriodDates, row.start_date, row.end_date]);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const [highlightedCell, setHighlightedCell] = useState<{ employeeId: number; date: string } | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
  }, []);

  const handleJump = (employeeId: number, date: string) => {
    const frame = frameRef.current;
    if (frame) {
      const cell = frame.querySelector<HTMLElement>(`td[data-employee="${employeeId}"][data-date="${date}"]`);
      if (cell) {
        cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      }
    }
    setHighlightedCell({ employeeId, date });
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setHighlightedCell(null), 1600);
  };

  return (
    <div className="approvals-card-body">
      {(row.problem_flags.correction_exceeds_skud || row.weekend_work_dates.length > 0) && (
        <div className="approvals-flags">
          {row.problem_flags.correction_exceeds_skud && (
            <span className="approvals-flag approvals-flag--red">
              <AlertTriangle size={12} /> Есть корректировки больше факта СКУД
            </span>
          )}
          {row.weekend_work_dates.length > 0 && (
            <span className="approvals-flag approvals-flag--info">
              Выходные с работой: {row.weekend_work_dates.join(', ')}
            </span>
          )}
        </div>
      )}

      {row.review_comment && (
        <div className="approvals-comment">Комментарий: {row.review_comment}</div>
      )}

      {tsQuery.data && <ReviewChecklist items={reviewItems} onJump={handleJump} />}

      <div className="approvals-timesheet-frame" ref={frameRef}>
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
            problemDates={problemDates}
            outOfPeriodDates={outOfPeriodDates}
            highlightedCell={highlightedCell}
            onEmployeeClick={() => {}}
            onDayClick={() => {}}
            onObjectDayClick={() => {}}
          />
        ) : null}
      </div>

      {canReview && (
        <div className="approvals-actions">
          {row.status === 'submitted' && (
            <>
              <button
                type="button"
                className="approvals-action-btn approvals-action-btn--approve"
                onClick={onApprove}
                disabled={isApproving}
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

const TimesheetsTab: FC = () => {
  const { hasPermission } = useAuth();
  const canReview = hasPermission('timesheet.workflow.review');
  const queryClient = useQueryClient();
  const toast = useToast();

  const [status, setStatus] = useState<TimesheetApprovalStatus>('submitted');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [commentModal, setCommentModal] = useState<{ row: IApprovalReviewItem; mode: 'rework' | 'return' } | null>(null);

  const query = useQuery({
    queryKey: ['approvals-review-list', status],
    queryFn: () => timesheetApprovalService.getReviewList(status),
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
                  <span className="approvals-card-submitted">
                    {row.submitted_by_name ?? '—'}{row.submitted_at ? `, ${formatDate(row.submitted_at.slice(0, 10))}` : ''}
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

  return (
    <div className="approvals-page">
      <header className="approvals-header">
        <h1>Согласования</h1>
        <p className="approvals-subtitle">Корректировки в выходные дни и подачи табелей</p>
      </header>

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

      {tab === 'corrections' ? <CorrectionsTab /> : <TimesheetsTab />}
    </div>
  );
};
