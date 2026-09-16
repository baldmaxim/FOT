import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef, memo, type FC, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Pencil, ArrowRightLeft, History, Upload, UserPlus, Calendar, UserRoundX, ShieldCheck, CheckSquare, CalendarX, X, CalendarCog, Download, Filter } from 'lucide-react';
import { SearchInput } from '../components/ui/SearchInput';
import { employeeService } from '../services/employeeService';
import { hrProfileService } from '../services/hrProfileService';
import { sigurAdminService } from '../services/sigurAdminService';
import type { SigurEmployeeSummary, SigurDepartmentNode } from '../types';
import { timesheetService } from '../services/timesheetService';
import { ApiError } from '../api/client';
import { scheduleService } from '../services/scheduleService';
import type {
  IWorkSchedule,
  IEmployeeScheduleAssignment,
} from '../types/schedule';
import { useIsMobile } from '../hooks/useIsMobile';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useStaffData } from '../hooks/useStaffData';
import { useStructureTree } from '../hooks/useStructure';
import { useManagedDepartments } from '../hooks/useManagedDepartments';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { DepartmentTreeSelect } from '../components/staff/DepartmentTreeSelect';
import { useHeaderAddon } from '../components/layout/HeaderAddonContext';
import {
  BulkBrigadeScheduleModal,
  BulkMoveDepartmentModal,
  BulkScheduleModal,
  type IBrigadeOption,
} from '../components/staff/BulkOperationModals';
import { OverflowMenu, type IOverflowMenuItem } from '../components/staff/OverflowMenu';
import { StaffMainObjectCell } from '../components/staff/StaffMainObjectCell';
import { StaffCommentCell } from '../components/staff/StaffCommentCell';
import { StaffSignBadge } from '../components/staff/StaffSignBadge';
import { StaffSectionSelect } from '../components/staff/StaffSectionSelect';
import { StaffSortHeader } from '../components/staff/StaffSortHeader';
import { STAFF_SORT_OPTIONS, isStaffSortKey } from '../components/staff/staffSort';
import { StaffMonthMovement } from '../components/staff/StaffMonthMovement';
import { StaffColumnFilterPopover } from '../components/staff/StaffColumnFilterPopover';
import { StaffColumnFilterSheet } from '../components/staff/StaffColumnFilterSheet';
import {
  countActiveColumnFilters,
  EMPTY_COLUMN_FILTERS,
  isColumnFilterActive,
  parseColumnFilters,
  serializeColumnFilters,
  setColumnFilter,
  type IColumnFilterValue,
  type IStaffColumnFilters,
  type StaffFilterColumn,
} from '../utils/staffColumnFilters';
import { STAFF_SECTION_OPTIONS, isStaffSection, type StaffSection } from '../components/staff/staffSections';
import { STAFF_MAIN_OBJECTS_QUERY_KEY, useStaffMainObjects } from '../hooks/useStaffMainObjects';
import { useStaffMonthMovement } from '../hooks/useStaffMonthMovement';
import type { IStaffCommentSaved, StaffPeriod, StaffSortDir, StaffSortKey } from '../services/employeeService';
import { affectsActiveFilters, affectsActiveSort, type StaffRowChange } from '../utils/staffRowUpdate';
import { useStaffSectionDepartments } from '../hooks/useStaffSectionDepartments';
import { useStaffScheduleAssignments, STAFF_SCHEDULE_ASSIGNMENTS_QUERY_KEY } from '../hooks/useStaffScheduleAssignments';
import { chunkCellState, type ChunkCellState, type IChunkReadiness } from '../utils/staffInfiniteList';
import { isHeaderDeptAllowed, resolveHeaderDeptFilter } from '../utils/staffDeptFilter';
import { buildScheduleViews } from '../utils/staffScheduleViews';
import { refreshStaffChunksFor } from '../utils/staffChunkInvalidation';
import { formatDate } from '../utils/formatMoney';
import type { Employee, EmployeeHistoryEvent, EnrichPreview, ContactsEnrichPreview } from '../types';
import { structureApi } from '../api/structure';
import type { OrgDepartmentNode } from '../types/organization';
import { filterDepartmentTreeByIds, getTreeFlatDepartments } from '../utils/departmentUtils';
import { triggerBlobDownload } from '../utils/download';
import '../styles/StaffControlPage.css';

const HistoryPanel = lazy(() => import('../components/staff/HistoryPanel').then(m => ({ default: m.HistoryPanel })));
const StaffTimesheetModeModal = lazy(() => import('../components/staff/StaffTimesheetModeModal').then(m => ({ default: m.StaffTimesheetModeModal })));
const StaffCommentModal = lazy(() => import('../components/staff/StaffCommentModal').then(m => ({ default: m.StaffCommentModal })));
const ImportModal = lazy(() => import('../components/employees/ImportModal').then(m => ({ default: m.ImportModal })));
const EnrichPreviewModal = lazy(() => import('../components/employees/EnrichPreviewModal').then(m => ({ default: m.EnrichPreviewModal })));

import {
  EMPTY_SCHEDULE_TEMPLATES,
  addIsoDays,
  getLocalISODate,
  getMoscowISODate,
  handleMiddleClickMouseDown,
  openEmployeeInNewTab,
  SCHEDULE_SOURCE_LABELS,
  type IAddEmployeeForm,
  type IEmployeeScheduleView,
  type ModalType,
  type StaffStatusFilter,
} from './staffControlPage.helpers';

const EMPTY_DEPT_TREE: OrgDepartmentNode[] = [];

/* ───────── Memoized table row ───────── */

/**
 * Данные ячеек, догружаемые порциями отдельно от списка. Готовность — по порции:
 * загружается → скелетон, порция упала → приглушённое «—», готово → значение или «—».
 */
interface IStaffSideData {
  scheduleViews: Map<number, IEmployeeScheduleView>;
  scheduleReadiness: IChunkReadiness;
  mainObjects: Record<string, string>;
  mainReadiness: IChunkReadiness;
}

/** Значение «Объект» для ячейки: undefined — грузится. */
const sideValue = (map: Record<string, string>, id: number, state: ChunkCellState): string | null | undefined =>
  (state === 'ready' ? (map[String(id)] ?? null) : undefined);

const StaffScheduleName: FC<{ view: IEmployeeScheduleView | undefined; state: ChunkCellState; withDefaultBadge: boolean }> = ({ view, state, withDefaultBadge }) => {
  if (state === 'loading') return <span className="sc-skeleton" aria-label="Загрузка" />;
  if (state === 'error') return <span className="sc-muted" title="Не удалось загрузить">—</span>;
  return (
    <>
      <span className="sc-schedule-name">{view?.scheduleName || '—'}</span>
      {view && (withDefaultBadge || view.source !== 'default') && (
        <span className={`sc-schedule-badge ${view.source}`}>{SCHEDULE_SOURCE_LABELS[view.source]}</span>
      )}
    </>
  );
};

interface IStaffRowProps {
  emp: Employee;
  index: number;
  /** Измерение фактической высоты строки virtualizer'ом (отдел/должность переносятся). */
  measureRef: (element: HTMLTableRowElement | null) => void;
  sideData: IStaffSideData;
  selectedIds: Set<number>;
  selectionMode: boolean;
  canManage: boolean;
  canEditDept: boolean;
  canEditPos: boolean;
  canEditSch: boolean;
  canOpenCard: boolean;
  onNavigate: (emp: Employee) => void;
  onToggleSelect: (empId: number) => void;
  onOpenModal: (emp: Employee, type: ModalType) => void;
  onOpenHistory: (emp: Employee) => void;
  onRehire?: (emp: Employee) => void;
  onFire?: (emp: Employee) => void;
  onCancelDismissal?: (emp: Employee) => void;
  onReturn?: (emp: Employee) => void;
  onEditComment?: (emp: Employee) => void;
}

const StaffRow: FC<IStaffRowProps> = memo(({ emp, index, measureRef, sideData, selectedIds, selectionMode, canManage, canEditDept, canEditPos, canEditSch, canOpenCard, onNavigate, onToggleSelect, onOpenModal, onOpenHistory, onRehire, onFire, onCancelDismissal, onReturn, onEditComment }) => {
  const scheduleView = sideData.scheduleViews.get(emp.id);
  const scheduleState = chunkCellState(emp.id, sideData.scheduleReadiness);
  const mainState = chunkCellState(emp.id, sideData.mainReadiness);
  const isSelected = selectedIds.has(emp.id);

  const handleAuxClick = (e: ReactMouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      openEmployeeInNewTab(emp.id);
    }
  };

  const handleRowClick = canOpenCard ? () => onNavigate(emp) : undefined;
  const rowStyle = canOpenCard ? undefined : { cursor: 'default' as const };

  return (
    <tr
      ref={measureRef}
      data-index={index}
      className={`sc-row${isSelected ? ' sc-row--selected' : ''}`}
      style={rowStyle}
      onClick={handleRowClick}
      onAuxClick={canOpenCard ? handleAuxClick : undefined}
      onMouseDown={canOpenCard ? handleMiddleClickMouseDown : undefined}
    >
      {selectionMode && (
        <td className="sc-td-check" onClick={e => e.stopPropagation()}>
          <input
            className="sc-check"
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect(emp.id)}
            aria-label={`Выбрать ${emp.full_name}`}
          />
        </td>
      )}
      <td className="sc-td-num">{index + 1}</td>
      <td className="sc-td-name" title={emp.full_name}>
        {/* ФИО — до двух строк; clamp на внутреннем элементе, ячейка остаётся табличной (sticky). */}
        <span className="sc-name-text" aria-label={emp.full_name}>{emp.full_name}</span>
        {/* Бейдж = employees.excluded_from_timesheet. Независим от employment_status='fired'. */}
        {emp.excluded_from_timesheet && (
          <span className="sc-excluded-badge" title={emp.excluded_from_timesheet_at ? `Исключён из табеля: ${new Date(emp.excluded_from_timesheet_at).toLocaleString('ru-RU')}` : 'Исключён из табеля'}>
            Исключён
          </span>
        )}
      </td>
      <td title={emp.department || ''}>
        <span className="sc-cell-with-btn">
          {emp.department || '—'}
          {canEditDept && (
            <button className="sc-inline-btn" title="Сменить отдел" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'department'); }}>
              <ArrowRightLeft size={12} />
            </button>
          )}
        </span>
      </td>
      <td>
        <span className="sc-cell-with-btn">
          {canEditPos && (
            <button className="sc-inline-btn" title="Сменить должность" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'position'); }}>
              <Pencil size={12} />
            </button>
          )}
          {emp.position_name || '—'}
        </span>
      </td>
      <td className="sc-td-date">{formatDate(emp.hire_date)}</td>
      <td className="sc-td-date">{formatDate(emp.birth_date)}</td>
      <td>
        <span className="sc-cell-with-btn">
          {canEditSch && (
            <button className="sc-inline-btn" title="Назначить график" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'schedule'); }}>
              <Calendar size={12} />
            </button>
          )}
          <span className="sc-schedule-cell">
            <StaffScheduleName view={scheduleView} state={scheduleState} withDefaultBadge={false} />
          </span>
        </span>
      </td>
      <td className="sc-td-main-object">
        <StaffMainObjectCell name={sideValue(sideData.mainObjects, emp.id, mainState)} failed={mainState === 'error'} />
      </td>
      <td className="sc-td-comment" onClick={onEditComment ? e => e.stopPropagation() : undefined}>
        <StaffCommentCell employee={emp} onEdit={onEditComment} />
      </td>
      <td className="sc-td-sign"><StaffSignBadge sign={emp.sign} /></td>
      <td className="sc-td-hist" onClick={e => e.stopPropagation()}>
        {onReturn && emp.excluded_from_timesheet ? (
          <button className="sc-btn apply" style={{ fontSize: 11, padding: '2px 8px' }} title="Вернуть сотрудника в табель" onClick={() => onReturn(emp)}>
            Вернуть в табель
          </button>
        ) : onRehire && emp.employment_status === 'fired' ? (
          <button className="sc-btn secondary" style={{ fontSize: 11, padding: '2px 8px' }} title="Восстановить сотрудника" onClick={() => onRehire(emp)}>
            Восстановить
          </button>
        ) : onCancelDismissal && emp.employment_status === 'active' && emp.dismissal_date ? (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span title={`Уволится ${emp.dismissal_date}`} style={{ fontSize: 11, color: '#dc2626', whiteSpace: 'nowrap' }}>
              <CalendarX size={12} style={{ verticalAlign: 'text-bottom', marginRight: 2 }} />
              {emp.dismissal_date}
            </span>
            <button
              className="sc-btn-icon"
              title="Отменить запланированное увольнение"
              onClick={() => onCancelDismissal(emp)}
            >
              <X size={14} />
            </button>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            {onFire && emp.employment_status !== 'fired' && (
              <button
                className="sc-btn-icon"
                style={{ color: '#dc2626' }}
                title="Уволить"
                onClick={() => onFire(emp)}
              >
                <UserRoundX size={14} />
              </button>
            )}
            {canManage && (
              <button className="sc-btn-icon" title="История" onClick={() => onOpenHistory(emp)}>
                <History size={14} />
              </button>
            )}
          </span>
        )}
      </td>
    </tr>
  );
});

/* ───────── Modals (isolated from table renders) ───────── */

interface IStaffModalsProps {
  modalType: ModalType | null;
  modalEmp: Employee | null;
  deptTree: OrgDepartmentNode[];
  templates: IWorkSchedule[];
  scheduleViews: Map<number, IEmployeeScheduleView>;
  baseScheduleViews: Map<number, IEmployeeScheduleView>;
  onClose: () => void;
  onSavePosition: (empId: number, val: string, reason?: string, date?: string) => Promise<void>;
  onSaveDepartment: (empId: number, deptId: string, effectiveDate?: string, reason?: string) => Promise<void>;
  onSaveSchedule: (empId: number, scheduleId: string | null, effectiveFrom: string, anchorDate: string | null, mergeIntoNext?: boolean) => Promise<void>;
  onFixAssignment: (empId: number, data: { assignment_id: string; effective_from?: string; anchor_date?: string | null }) => Promise<void>;
  onDeleteAssignmentRow: (empId: number, assignmentId: string) => Promise<void>;
}

const StaffModals: FC<IStaffModalsProps> = memo(({
  modalType,
  modalEmp,
  deptTree,
  templates,
  scheduleViews,
  baseScheduleViews,
  onClose,
  onSavePosition,
  onSaveDepartment,
  onSaveSchedule,
  onFixAssignment,
  onDeleteAssignmentRow,
}) => {
  const currentSchedule = modalEmp ? scheduleViews.get(modalEmp.id) : undefined;
  const [positionVal, setPositionVal] = useState('');
  const [positionDate, setPositionDate] = useState(() => getLocalISODate());
  const [positionReason, setPositionReason] = useState('');
  const [deptVal, setDeptVal] = useState(() => modalEmp?.org_department_id || '');
  const [deptDate, setDeptDate] = useState(() => {
    // Возврат в табель: старт = эффективная дата исключения (excluded_from_timesheet_date),
    // а не время выполнения операции (excluded_from_timesheet_at), иначе новый сегмент
    // назначения не состыкуется с закрытым при исключении и в истории появится разрыв.
    if (modalEmp?.excluded_from_timesheet) {
      return (
        modalEmp.excluded_from_timesheet_date
        ?? (modalEmp.excluded_from_timesheet_at
          ? new Date(modalEmp.excluded_from_timesheet_at).toLocaleDateString('en-CA')
          : null)
        ?? getLocalISODate()
      );
    }
    return getLocalISODate();
  });
  const [deptReason, setDeptReason] = useState('');
  const [scheduleVal, setScheduleVal] = useState(() => currentSchedule?.source === 'employee' ? currentSchedule.scheduleId || '' : '');
  const [scheduleDate, setScheduleDate] = useState(() => currentSchedule?.source === 'employee' ? currentSchedule.effectiveFrom || getLocalISODate() : getLocalISODate());
  const [scheduleAnchor, setScheduleAnchor] = useState(() => currentSchedule?.assignmentAnchorDate ?? '');
  const hasFixableAssignment = currentSchedule?.source === 'employee' && !!currentSchedule.assignmentId;
  const [scheduleTab, setScheduleTab] = useState<'fix' | 'new'>(() => (hasFixableAssignment ? 'fix' : 'new'));
  const [fixFrom, setFixFrom] = useState(() => currentSchedule?.effectiveFrom || '');
  const [fixAnchor, setFixAnchor] = useState(() => currentSchedule?.assignmentAnchorDate ?? '');
  // Fix-таб по умолчанию работает с активной (employee-source) записью. Когда
  // пользователь нажимает ✎ на конкретной строке в «Истории назначений» — сюда
  // кладётся её id, и handleFix отправляет PATCH именно ей. null = активная.
  const [fixTargetId, setFixTargetId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // История всех назначений сотрудника — для блока «История назначений».
  const historyQuery = useQuery({
    queryKey: ['schedules', 'employee-history', modalEmp?.id],
    queryFn: () => scheduleService.listEmployeeHistory(modalEmp!.id),
    enabled: modalType === 'schedule' && !!modalEmp?.id,
    staleTime: 30_000,
  });
  const history = historyQuery.data ?? [];
  // Когда пользователь выбрал в «Новое назначение» ту же запись графика, что и
  // активная сейчас, но с более ранней датой — серверная case-2-логика молча
  // сдвинула бы effective_from текущей записи назад. Показываем явное
  // подтверждение и оставляем выбор за пользователем (см. план 2-glowing-pixel).
  const [pendingMergeChoice, setPendingMergeChoice] = useState(false);
  const selectedScheduleTemplate = scheduleVal ? templates.find(t => t.id === scheduleVal) ?? null : null;
  const isCycleTemplate = selectedScheduleTemplate?.pattern_type === 'cycle';

  if (!modalType || !modalEmp) return null;

  const handlePosition = async () => {
    if (!positionVal) return;
    setSaving(true);
    await onSavePosition(modalEmp.id, positionVal, positionReason || undefined, positionDate || undefined);
    setSaving(false);
  };

  const handleDepartment = async () => {
    if (!deptVal) return;
    setSaving(true);
    try {
      await onSaveDepartment(modalEmp.id, deptVal, deptDate || undefined, deptReason.trim() || undefined);
    } catch {
      // ошибка уже показана в верхнем хендлере через toast
    } finally {
      setSaving(false);
    }
  };

  // Детектор серверной ветки case 2 (assignEmployeeSchedule): тот же график,
  // что у текущей employee-записи, но более ранняя дата → бэк бы молча
  // сдвинул effective_from существующей записи назад. Пользователь должен
  // явно выбрать поведение.
  const wouldTriggerSilentMerge = (
    currentSchedule?.source === 'employee'
    && !!currentSchedule.effectiveFrom
    && scheduleVal !== ''
    && scheduleVal === currentSchedule.scheduleId
    && !!scheduleDate
    && scheduleDate < currentSchedule.effectiveFrom
  );

  const submitSchedule = async (mergeIntoNext?: boolean) => {
    setSaving(true);
    const value = scheduleVal === '' ? null : scheduleVal;
    const anchor = isCycleTemplate && scheduleAnchor.trim() ? scheduleAnchor : null;
    try {
      await onSaveSchedule(modalEmp.id, value, scheduleDate, anchor, mergeIntoNext);
    } finally {
      setSaving(false);
      setPendingMergeChoice(false);
    }
  };

  const handleSchedule = async () => {
    if (wouldTriggerSilentMerge && !pendingMergeChoice) {
      setPendingMergeChoice(true);
      return;
    }
    await submitSchedule();
  };

  const handleFix = async () => {
    // Если включён режим «правим конкретную строку из истории» — используем её id
    // и её исходные даты. Иначе — активная employee-запись (currentSchedule).
    const targetRow = fixTargetId ? history.find(r => r.id === fixTargetId) ?? null : null;
    const assignmentId = targetRow?.id ?? currentSchedule?.assignmentId;
    if (!assignmentId) return;
    const baseEffectiveFrom = targetRow ? targetRow.effective_from : (currentSchedule?.effectiveFrom || '');
    const baseAnchor = targetRow ? (targetRow.anchor_date ?? null) : (currentSchedule?.assignmentAnchorDate ?? null);
    const isCycleRow = targetRow
      ? targetRow.work_schedules?.pattern_type === 'cycle'
      : currentSchedule?.templatePatternType === 'cycle';

    const payload: { assignment_id: string; effective_from?: string; anchor_date?: string | null } = {
      assignment_id: assignmentId,
    };
    if (fixFrom && fixFrom !== baseEffectiveFrom) payload.effective_from = fixFrom;
    if (isCycleRow) {
      const norm = fixAnchor.trim() ? fixAnchor : null;
      if (norm !== baseAnchor) payload.anchor_date = norm;
    }
    if (payload.effective_from === undefined && !('anchor_date' in payload)) return;
    setSaving(true);
    try {
      await onFixAssignment(modalEmp.id, payload);
      // Сбрасываем выбранную «строку из истории» — следующее открытие fix-таба
      // снова будет работать с активной записью.
      setFixTargetId(null);
    } finally {
      setSaving(false);
    }
  };

  const handleEditHistoryRow = (row: IEmployeeScheduleAssignment) => {
    setFixTargetId(row.id);
    setFixFrom(row.effective_from);
    setFixAnchor(row.anchor_date ?? '');
    setScheduleTab('fix');
  };

  const handleDeleteHistoryRow = async (row: IEmployeeScheduleAssignment) => {
    const schedName = row.work_schedules?.name ?? '—';
    const eto = row.effective_to ?? 'открыто';
    if (!window.confirm(`Удалить запись «${schedName}» с ${row.effective_from} по ${eto}? Действие необратимо.`)) return;
    setDeletingId(row.id);
    try {
      await onDeleteAssignmentRow(modalEmp.id, row.id);
      if (fixTargetId === row.id) {
        setFixTargetId(null);
        setFixFrom(currentSchedule?.effectiveFrom || '');
        setFixAnchor(currentSchedule?.assignmentAnchorDate ?? '');
      }
      await historyQuery.refetch();
    } finally {
      setDeletingId(null);
    }
  };

  if (modalType === 'position') {
    return (
      <div className="sc-overlay" onClick={onClose}>
        <div className="sc-modal" onClick={e => e.stopPropagation()}>
          <div className="sc-modal-header">
            <h3>Сменить должность — {modalEmp.full_name}</h3>
            <button className="sc-modal-close" onClick={onClose}>&times;</button>
          </div>
          <div className="sc-modal-body">
            <div className="sc-field">
              <label>Должность</label>
              <input value={positionVal} onChange={e => setPositionVal(e.target.value)} placeholder="Название должности" autoFocus />
            </div>
            <div className="sc-field">
              <label>Дата вступления в силу</label>
              <input type="date" value={positionDate} onChange={e => setPositionDate(e.target.value)} />
            </div>
            <div className="sc-field">
              <label>Причина</label>
              <input value={positionReason} onChange={e => setPositionReason(e.target.value)} placeholder="Повышение, перевод..." />
            </div>
          </div>
          <div className="sc-modal-footer">
            <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
            <button className="sc-btn apply" onClick={handlePosition} disabled={!positionVal || saving}>
              {saving ? 'Сохранение...' : 'Применить'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (modalType === 'schedule') {
    const effectiveSchedule = scheduleViews.get(modalEmp.id);
    const baseSchedule = baseScheduleViews.get(modalEmp.id);
    const defaultScheduleLabel = templates.find(t => t.is_default)?.name || '—';
    const hasEmployeeOverride = effectiveSchedule?.source === 'employee';
    const currentEmployeeScheduleId = effectiveSchedule?.source === 'employee' ? effectiveSchedule.scheduleId || '' : '';
    const currentEmployeeScheduleDate = effectiveSchedule?.source === 'employee' ? effectiveSchedule.effectiveFrom || getLocalISODate() : getLocalISODate();
    const currentEmployeeAnchor = effectiveSchedule?.assignmentAnchorDate ?? '';
    const anchorChanged = (scheduleAnchor || '') !== currentEmployeeAnchor;
    const isUnchanged = (scheduleVal || '') === currentEmployeeScheduleId
      && scheduleDate === currentEmployeeScheduleDate
      && !anchorChanged;

    // ── Вкладка «Исправить назначение» ──────────────────────────────────────
    // Если из истории выбрана конкретная строка для правки — используем её
    // данные, иначе — текущая активная employee-запись.
    const fixTargetRow = fixTargetId ? history.find(r => r.id === fixTargetId) ?? null : null;
    const baseFixFrom = fixTargetRow ? fixTargetRow.effective_from : (effectiveSchedule?.effectiveFrom || '');
    const baseFixAnchor = fixTargetRow ? (fixTargetRow.anchor_date ?? null) : (effectiveSchedule?.assignmentAnchorDate ?? null);
    const fixTargetIsCycle = fixTargetRow
      ? fixTargetRow.work_schedules?.pattern_type === 'cycle'
      : (effectiveSchedule?.templatePatternType === 'cycle');
    const fixTargetScheduleName = fixTargetRow?.work_schedules?.name ?? effectiveSchedule?.scheduleName ?? '—';
    const fixTargetTemplate = fixTargetRow
      ? templates.find(t => t.id === fixTargetRow.schedule_id) ?? null
      : templates.find(t => t.id === effectiveSchedule?.scheduleId) ?? null;
    const fixAnchorNorm = fixAnchor.trim() ? fixAnchor : null;
    const fixFromChanged = !!fixFrom && fixFrom !== baseFixFrom;
    const fixAnchorChanged = fixTargetIsCycle && fixAnchorNorm !== baseFixAnchor;
    const fixAssignmentId = fixTargetRow?.id ?? effectiveSchedule?.assignmentId ?? null;
    const fixDisabled = saving || !fixAssignmentId || !fixFrom || (!fixFromChanged && !fixAnchorChanged);
    const hasAnyAssignment = history.length > 0 || hasFixableAssignment;
    const onFixTab = scheduleTab === 'fix' && hasAnyAssignment;
    // Алиасы для совместимости с дальнейшей разметкой (которая раньше читала
    // currentTemplate / isCurrentCycle от текущей активной записи).
    const currentTemplate = fixTargetTemplate;
    const isCurrentCycle = fixTargetIsCycle;

    return (
      <div className="sc-overlay" onClick={onClose}>
        <div className="sc-modal" onClick={e => e.stopPropagation()}>
          <div className="sc-modal-header">
            <h3>График работы — {modalEmp.full_name}</h3>
            <button className="sc-modal-close" onClick={onClose}>&times;</button>
          </div>
          <div className="sc-modal-body">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
              <div className="sc-segmented" role="tablist" aria-label="Режим">
                <button
                  type="button"
                  role="tab"
                  aria-selected={onFixTab}
                  disabled={!hasFixableAssignment}
                  title={hasFixableAssignment ? '' : 'У сотрудника нет персонального назначения'}
                  className={`sc-seg-btn${onFixTab ? ' is-active' : ''}`}
                  onClick={() => setScheduleTab('fix')}
                >
                  Исправить назначение
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!onFixTab}
                  className={`sc-seg-btn${!onFixTab ? ' is-active' : ''}`}
                  onClick={() => setScheduleTab('new')}
                >
                  Новое назначение
                </button>
              </div>
            </div>

            {onFixTab ? (
              <>
                <div className="sc-schedule-help" style={{ marginBottom: 14 }}>
                  {fixTargetRow ? (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <span><strong>Правим запись из истории:</strong> {fixTargetScheduleName}</span>
                        <button
                          type="button"
                          className="sc-btn cancel"
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          onClick={() => {
                            setFixTargetId(null);
                            setFixFrom(effectiveSchedule?.effectiveFrom || '');
                            setFixAnchor(effectiveSchedule?.assignmentAnchorDate ?? '');
                          }}
                        >
                          Вернуться к активной
                        </button>
                      </div>
                      <div><strong>Исходная дата вступления:</strong> {fixTargetRow.effective_from}</div>
                      {fixTargetIsCycle && (
                        <div><strong>Якорь назначения:</strong> {fixTargetRow.anchor_date || `— (якорь паттерна ${fixTargetTemplate?.anchor_date || '—'})`}</div>
                      )}
                    </>
                  ) : (
                    <>
                      <div><strong>Текущий график:</strong> {effectiveSchedule?.scheduleName || '—'}</div>
                      <div><strong>Дата вступления:</strong> {effectiveSchedule?.effectiveFrom || '—'}</div>
                      {isCurrentCycle && (
                        <div><strong>Якорь назначения:</strong> {effectiveSchedule?.assignmentAnchorDate || `— (якорь паттерна ${currentTemplate?.anchor_date || '—'})`}</div>
                      )}
                    </>
                  )}
                </div>
                <div className="sc-field">
                  <label>Дата вступления в силу</label>
                  <input type="date" value={fixFrom} onChange={e => setFixFrom(e.target.value)} autoFocus />
                </div>
                {isCurrentCycle && (
                  <div className="sc-field">
                    <label title="Пусто = использовать якорь паттерна графика.">Якорь цикла (override)</label>
                    <input
                      type="date"
                      value={fixAnchor}
                      onChange={e => setFixAnchor(e.target.value)}
                      placeholder={currentTemplate?.anchor_date || ''}
                    />
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      Якорь паттерна: <strong>{currentTemplate?.anchor_date || '—'}</strong>. Пусто — сбросить override и считать цикл от якоря паттерна.
                    </div>
                  </div>
                )}
                <div className="sc-schedule-help">
                  <div>Правка исправляет текущую запись назначения на месте — без создания новой. История графиков сохраняется.</div>
                </div>
              </>
            ) : (
              <>
                <div className="sc-field">
                  <label>Персональный график</label>
                  <select value={scheduleVal} onChange={e => setScheduleVal(e.target.value)} autoFocus>
                    <option value="">— {defaultScheduleLabel} —</option>
                    {templates.filter(tpl => !tpl.is_default).map(tpl => (
                      <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                    ))}
                  </select>
                </div>
                <div className="sc-field">
                  <label>{scheduleVal ? 'Дата вступления в силу' : 'Дата снятия персонального графика'}</label>
                  <input type="date" value={scheduleDate} onChange={e => setScheduleDate(e.target.value)} />
                </div>
                {isCycleTemplate && (
                  <div className="sc-field">
                    <label title="Опционально перебивает дату-якорь паттерна для этого назначения. Пусто = использовать якорь паттерна.">
                      Якорь цикла (override)
                    </label>
                    <input
                      type="date"
                      value={scheduleAnchor}
                      onChange={e => setScheduleAnchor(e.target.value)}
                      placeholder={selectedScheduleTemplate?.anchor_date || ''}
                    />
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      Якорь паттерна: <strong>{selectedScheduleTemplate?.anchor_date || '—'}</strong>
                      {scheduleAnchor && scheduleAnchor !== selectedScheduleTemplate?.anchor_date
                        ? ' · цикл сдвинется для этого сотрудника'
                        : ''}
                    </div>
                  </div>
                )}
                <div className="sc-schedule-help">
                  <div><strong>Сейчас действует:</strong> {effectiveSchedule?.scheduleName || '—'}{effectiveSchedule && effectiveSchedule.source !== 'default' ? ` (${SCHEDULE_SOURCE_LABELS[effectiveSchedule.source]})` : ''}</div>
                  <div><strong>Базовый график:</strong> {baseSchedule?.scheduleName || defaultScheduleLabel}</div>
                  <div>Если оставить пусто, с выбранной даты сотрудник вернётся к графику {defaultScheduleLabel}. Создаётся новая датированная запись.</div>
                </div>
                {pendingMergeChoice && (
                  <div className="sc-schedule-help" style={{ borderTop: '1px solid var(--border-light)', marginTop: 12, paddingTop: 12 }}>
                    <div style={{ marginBottom: 8 }}>
                      <strong>Уточните действие.</strong> Тот же график «{effectiveSchedule?.scheduleName}» уже действует у сотрудника с <strong>{effectiveSchedule?.effectiveFrom}</strong>. Вы выбрали более раннюю дату <strong>{scheduleDate}</strong>. Что сделать?
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <button
                        type="button"
                        className="sc-btn apply"
                        onClick={() => submitSchedule(true)}
                        disabled={saving}
                      >
                        Сдвинуть дату начала текущей записи с {effectiveSchedule?.effectiveFrom} на {scheduleDate}
                      </button>
                      <button
                        type="button"
                        className="sc-btn apply"
                        onClick={() => submitSchedule(false)}
                        disabled={saving}
                      >
                        Создать новый исторический фрагмент с {scheduleDate} (текущая запись не меняется)
                      </button>
                      <button
                        type="button"
                        className="sc-btn cancel"
                        onClick={() => setPendingMergeChoice(false)}
                        disabled={saving}
                      >
                        Отмена выбора
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ── История назначений ─────────────────────────────────── */}
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-light)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong>История назначений</strong>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {historyQuery.isLoading ? 'Загрузка…' : `${history.length} ${history.length === 1 ? 'запись' : history.length < 5 && history.length > 1 ? 'записи' : 'записей'}`}
                </span>
              </div>
              {!historyQuery.isLoading && history.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Персональных назначений нет — сотрудник на графике {defaultScheduleLabel}.
                </div>
              )}
              {history.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {history.map(row => {
                    const isOpen = row.effective_to === null;
                    const today = getLocalISODate();
                    const isFuture = row.effective_from > today;
                    const isClosed = !isOpen && (row.effective_to ?? '') < today;
                    const badge = isOpen ? 'открыта' : isFuture ? 'будущая' : isClosed ? 'закрыта' : 'активна';
                    const badgeColor = isOpen ? 'var(--success)' : isFuture ? 'var(--accent)' : 'var(--text-tertiary)';
                    const isBeingEdited = fixTargetId === row.id;
                    const isDeleting = deletingId === row.id;
                    return (
                      <div
                        key={row.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 10px',
                          background: isBeingEdited ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
                          border: `1px solid ${isBeingEdited ? 'var(--accent)' : 'var(--border-light)'}`,
                          borderRadius: 6,
                          fontSize: 13,
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {row.work_schedules?.name ?? '—'}
                            </strong>
                            <span style={{ fontSize: 11, color: badgeColor, border: `1px solid ${badgeColor}`, padding: '0 6px', borderRadius: 4 }}>
                              {badge}
                            </span>
                          </div>
                          <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                            с {row.effective_from} {row.effective_to ? `по ${row.effective_to}` : '— открыта'}
                            {row.anchor_date ? ` · якорь ${row.anchor_date}` : ''}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button
                            type="button"
                            className="sc-btn cancel"
                            style={{ padding: '4px 10px', fontSize: 12 }}
                            disabled={saving || isDeleting}
                            onClick={() => handleEditHistoryRow(row)}
                            title="Изменить даты этой записи"
                          >
                            ✎ Изменить
                          </button>
                          <button
                            type="button"
                            className="sc-history-delete"
                            disabled={saving || isDeleting}
                            onClick={() => handleDeleteHistoryRow(row)}
                            title="Удалить запись полностью"
                            aria-label="Удалить запись"
                          >
                            {isDeleting ? '…' : '🗑 Удалить'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="sc-modal-footer">
            <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
            {onFixTab ? (
              <button className="sc-btn apply" onClick={handleFix} disabled={fixDisabled}>
                {saving ? 'Сохранение...' : 'Исправить даты'}
              </button>
            ) : (
              !pendingMergeChoice && (
                <button
                  className="sc-btn apply"
                  onClick={handleSchedule}
                  disabled={saving || !scheduleDate || (!hasEmployeeOverride && scheduleVal === '') || isUnchanged}
                >
                  {saving ? 'Сохранение...' : 'Применить'}
                </button>
              )
            )}
          </div>
        </div>
      </div>
    );
  }

  if (modalType !== 'department') return null;

  return (
    <div className="sc-overlay" onClick={onClose}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Сменить отдел — {modalEmp.full_name}</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          {modalEmp.excluded_from_timesheet && modalEmp.excluded_from_timesheet_at && (
            <div className="sc-modal-note">
              Исключён из табеля: <strong>{new Date(modalEmp.excluded_from_timesheet_at).toLocaleDateString('ru-RU')}</strong>
            </div>
          )}
          <div className="sc-field">
            <label>Отдел</label>
            <DepartmentTreeSelect
              departments={deptTree}
              value={deptVal}
              onChange={setDeptVal}
              showAllOption={false}
              emptyLabel="Выберите отдел"
              disableUnassignable
            />
          </div>
          <div className="sc-field">
            <label>Дата перевода</label>
            <input type="date" value={deptDate} onChange={e => setDeptDate(e.target.value)} />
          </div>
          <div className="sc-field">
            <label>Причина (необязательно)</label>
            <input value={deptReason} onChange={e => setDeptReason(e.target.value)} placeholder="Реорганизация, перевод..." />
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
          <button className="sc-btn apply" onClick={handleDepartment} disabled={!deptVal || (!modalEmp.excluded_from_timesheet && deptVal === modalEmp.org_department_id) || !deptDate || saving}>
            {saving ? 'Сохранение...' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  );
});

/* ───────── Virtualized Table ───────── */

interface IVirtualListLoadProps {
  /** Последний отрисованный индекс → решение о догрузке (guard и стоп-условия — у вызывающего). */
  onLoadMore: (lastVisibleIndex: number) => void;
  /** Меняется только при смене фильтров: прокрутка к началу. Догрузка порций ключ не меняет. */
  resetKey: string;
}

interface IVirtualTableProps extends IVirtualListLoadProps {
  filtered: Employee[];
  sideData: IStaffSideData;
  selectedIds: Set<number>;
  selectionMode: boolean;
  canManage: boolean;
  canEditDept: boolean;
  canEditPos: boolean;
  canEditSch: boolean;
  canOpenCard: boolean;
  /** Подсказка заголовка «Объект» с периодом расчёта. */
  mainObjectTitle: string;
  onNavigate: (emp: Employee) => void;
  onToggleSelect: (empId: number) => void;
  onToggleSelectAll: () => void;
  allSelected: boolean;
  onOpenModal: (emp: Employee, type: ModalType) => void;
  onOpenHistory: (emp: Employee) => void;
  onRehire?: (emp: Employee) => void;
  onFire?: (emp: Employee) => void;
  onCancelDismissal?: (emp: Employee) => void;
  onReturn?: (emp: Employee) => void;
  onEditComment?: (emp: Employee) => void;
  sort: StaffSortKey;
  dir: StaffSortDir;
  onSort: (key: StaffSortKey) => void;
  columnFilters: IStaffColumnFilters;
  onOpenFilter: (key: StaffSortKey, anchor: HTMLElement) => void;
}

/** Оценка до измерения: строка в одну линию ≈ 36 px, частые переносы отдела/должности — выше. */
const ROW_ESTIMATE = 44;

/** Классы заголовков: ФИО закреплено слева, даты переносятся на две строки. */
const HEADER_CLASS_BY_KEY: Partial<Record<StaffSortKey, string>> = {
  name: 'sc-th-name',
  hire_date: 'sc-th-date',
  birth_date: 'sc-th-date',
};

/**
 * Догрузка у конца списка и сброс прокрутки при смене фильтров — общие для таблицы и карточек.
 * lastVisibleIndex меняется только при прокрутке/росте списка, поэтому эффект не крутится вхолостую.
 */
const useVirtualListLoading = (
  scrollRef: { current: HTMLDivElement | null },
  lastVisibleIndex: number,
  { onLoadMore, resetKey }: IVirtualListLoadProps,
): void => {
  useEffect(() => {
    onLoadMore(lastVisibleIndex);
  }, [lastVisibleIndex, onLoadMore]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [resetKey, scrollRef]);
};

const VirtualTable: FC<IVirtualTableProps> = memo(({
  filtered,
  sideData,
  selectedIds,
  selectionMode,
  canManage,
  canEditDept,
  canEditPos,
  canEditSch,
  canOpenCard,
  onLoadMore,
  resetKey,
  mainObjectTitle,
  onNavigate,
  onToggleSelect,
  onToggleSelectAll,
  allSelected,
  onOpenModal,
  onOpenHistory,
  onRehire,
  onFire,
  onCancelDismissal,
  onReturn,
  onEditComment,
  sort,
  dir,
  onSort,
  columnFilters,
  onOpenFilter,
}) => {
  // №, ФИО, Отдел, Должность, Трудоустр., Рожд., График, Объект, Комментарий, Признак, действия.
  const totalCols = 11 + (selectionMode ? 1 : 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    // Строки измеряются: высота зависит от переносов, а постоянная оценка у низа накапливала
    // ошибку — нижний spacer пересчитывался и таблица дёргалась.
    getItemKey: index => filtered[index]?.id ?? index,
    overscan: 15,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  useVirtualListLoading(scrollRef, lastVisibleIndex, { onLoadMore, resetKey });

  return (
    <div className="sc-table-wrap" ref={scrollRef}>
      <table className={`sc-table sc-table--staff${selectionMode ? ' sc-table--selecting' : ''}`}>
        <colgroup>
          {selectionMode && <col className="sc-col-check" />}
          <col className="sc-col-num" />
          <col className="sc-col-name" />
          <col className="sc-col-dept" />
          <col className="sc-col-position" />
          <col className="sc-col-hire" />
          <col className="sc-col-birth" />
          <col className="sc-col-schedule" />
          <col className="sc-col-main-object" />
          <col className="sc-col-comment" />
          <col className="sc-col-sign" />
          <col className="sc-col-actions" />
        </colgroup>
        <thead>
          <tr>
            {selectionMode && (
              <th className="sc-th-check">
                <input
                  className="sc-check"
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleSelectAll}
                  aria-label="Выбрать всех загруженных сотрудников"
                />
              </th>
            )}
            <th className="sc-th-num">№</th>
            {STAFF_SORT_OPTIONS.map(option => (
              <StaffSortHeader
                key={option.key}
                sortKey={option.key}
                label={option.label}
                className={HEADER_CLASS_BY_KEY[option.key]}
                title={option.key === 'main_object' ? mainObjectTitle : undefined}
                activeKey={sort}
                dir={dir}
                onSort={onSort}
                onOpenFilter={onOpenFilter}
                filterActive={isColumnFilterActive(columnFilters, option.key)}
              />
            ))}
            <th className="sc-th-hist"></th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr><td colSpan={totalCols} className="sc-empty">Нет сотрудников</td></tr>
          ) : (
            <>
              {/* spacer top */}
              {virtualItems[0]?.start > 0 && (
                <tr aria-hidden="true"><td colSpan={totalCols} style={{ height: virtualItems[0].start, padding: 0, border: 'none' }} /></tr>
              )}
              {virtualItems.map(vRow => {
                const emp = filtered[vRow.index];
                return (
                  <StaffRow
                    key={emp.id}
                    emp={emp}
                    index={vRow.index}
                    measureRef={virtualizer.measureElement}
                    sideData={sideData}
                    selectedIds={selectedIds}
                    selectionMode={selectionMode}
                    canManage={canManage}
                    canEditDept={canEditDept}
                    canEditPos={canEditPos}
                    canEditSch={canEditSch}
                    canOpenCard={canOpenCard}
                    onNavigate={onNavigate}
                    onToggleSelect={onToggleSelect}
                    onOpenModal={onOpenModal}
                    onOpenHistory={onOpenHistory}
                    onRehire={onRehire}
                    onFire={onFire}
                    onCancelDismissal={onCancelDismissal}
                    onReturn={onReturn}
                    onEditComment={onEditComment}
                  />
                );
              })}
              {/* spacer bottom */}
              {(() => {
                const lastItem = virtualItems[virtualItems.length - 1];
                const remaining = lastItem ? virtualizer.getTotalSize() - lastItem.end : 0;
                return remaining > 0 ? <tr aria-hidden="true"><td colSpan={totalCols} style={{ height: remaining, padding: 0, border: 'none' }} /></tr> : null;
              })()}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
});

/* ───────── Virtualized Mobile Cards ───────── */

interface IVirtualCardsProps extends IVirtualListLoadProps {
  filtered: Employee[];
  sideData: IStaffSideData;
  selectedIds: Set<number>;
  selectionMode: boolean;
  canManage: boolean;
  canEditDept: boolean;
  canEditPos: boolean;
  canEditSch: boolean;
  canOpenCard: boolean;
  onNavigate: (emp: Employee) => void;
  onToggleSelect: (empId: number) => void;
  onOpenModal: (emp: Employee, type: ModalType) => void;
  onOpenHistory: (emp: Employee) => void;
  onRehire?: (emp: Employee) => void;
  onFire?: (emp: Employee) => void;
  onCancelDismissal?: (emp: Employee) => void;
  onReturn?: (emp: Employee) => void;
  onEditComment?: (emp: Employee) => void;
}

const CARD_ESTIMATE = 250;

const MobileCard: FC<{
  emp: Employee;
  sideData: IStaffSideData;
  selectedIds: Set<number>;
  selectionMode: boolean;
  canManage: boolean;
  canEditDept: boolean;
  canEditPos: boolean;
  canEditSch: boolean;
  canOpenCard: boolean;
  onNavigate: (emp: Employee) => void;
  onToggleSelect: (empId: number) => void;
  onOpenModal: (emp: Employee, type: ModalType) => void;
  onOpenHistory: (emp: Employee) => void;
  onRehire?: (emp: Employee) => void;
  onFire?: (emp: Employee) => void;
  onCancelDismissal?: (emp: Employee) => void;
  onReturn?: (emp: Employee) => void;
  onEditComment?: (emp: Employee) => void;
}> = memo(({ emp, sideData, selectedIds, selectionMode, canManage, canEditDept, canEditPos, canEditSch, canOpenCard, onNavigate, onToggleSelect, onOpenModal, onOpenHistory, onRehire, onFire, onCancelDismissal, onReturn, onEditComment }) => {
  const scheduleView = sideData.scheduleViews.get(emp.id);
  const scheduleState = chunkCellState(emp.id, sideData.scheduleReadiness);
  const mainState = chunkCellState(emp.id, sideData.mainReadiness);
  const isSelected = selectedIds.has(emp.id);
  const handleAuxClick = (e: ReactMouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      openEmployeeInNewTab(emp.id);
    }
  };
  return (
    <div
      className={`sc-card${isSelected ? ' sc-card--selected' : ''}`}
      style={canOpenCard ? undefined : { cursor: 'default' }}
      onClick={canOpenCard ? () => onNavigate(emp) : undefined}
      onAuxClick={canOpenCard ? handleAuxClick : undefined}
      onMouseDown={canOpenCard ? handleMiddleClickMouseDown : undefined}
    >
      <div className="sc-card-head">
        <div className="sc-card-name">
          {emp.full_name}
          {emp.excluded_from_timesheet && (
            <span className="sc-excluded-badge" title={emp.excluded_from_timesheet_at ? `Исключён из табеля: ${new Date(emp.excluded_from_timesheet_at).toLocaleString('ru-RU')}` : 'Исключён из табеля'}>
              Исключён
            </span>
          )}
          <StaffSignBadge sign={emp.sign} />
        </div>
        {selectionMode && (
          <div className="sc-card-check" onClick={e => e.stopPropagation()}>
            <input
              className="sc-check"
              type="checkbox"
              checked={isSelected}
              onChange={() => onToggleSelect(emp.id)}
              aria-label={`Выбрать ${emp.full_name}`}
            />
          </div>
        )}
      </div>
      <div className="sc-card-row">
        <span className="sc-card-label">Отдел</span>
        <span>{emp.department || '—'}</span>
      </div>
      <div className="sc-card-row">
        <span className="sc-card-label">Должность</span>
        <span>{emp.position_name || '—'}</span>
      </div>
      <div className="sc-card-row">
        <span className="sc-card-label">Дата трудоустройства</span>
        <span>{formatDate(emp.hire_date)}</span>
      </div>
      <div className="sc-card-row">
        <span className="sc-card-label">Дата рождения</span>
        <span>{formatDate(emp.birth_date)}</span>
      </div>
      <div className="sc-card-row">
        <span className="sc-card-label">График</span>
        <span className="sc-schedule-cell">
          <StaffScheduleName view={scheduleView} state={scheduleState} withDefaultBadge />
        </span>
      </div>
      <div className="sc-card-row">
        <span className="sc-card-label">Объект</span>
        <StaffMainObjectCell name={sideValue(sideData.mainObjects, emp.id, mainState)} failed={mainState === 'error'} />
      </div>
      <div className="sc-card-row" onClick={onEditComment ? e => e.stopPropagation() : undefined}>
        <span className="sc-card-label">Комментарий</span>
        <StaffCommentCell employee={emp} onEdit={onEditComment} variant="card" />
      </div>
      <div className="sc-card-actions">
        {onReturn && emp.excluded_from_timesheet ? (
          <button className="sc-btn apply" style={{ fontSize: 12, padding: '4px 10px' }} onClick={e => { e.stopPropagation(); onReturn(emp); }}>
            Вернуть в табель
          </button>
        ) : onRehire && emp.employment_status === 'fired' ? (
          <button className="sc-btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={e => { e.stopPropagation(); onRehire(emp); }}>
            Восстановить
          </button>
        ) : onCancelDismissal && emp.employment_status === 'active' && emp.dismissal_date ? (
          <>
            <span style={{ fontSize: 12, color: '#dc2626', whiteSpace: 'nowrap' }}>
              <CalendarX size={12} style={{ verticalAlign: 'text-bottom', marginRight: 2 }} />
              Уволится {emp.dismissal_date}
            </span>
            <button
              className="sc-btn-icon"
              title="Отменить запланированное увольнение"
              onClick={e => { e.stopPropagation(); onCancelDismissal(emp); }}
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            {onFire && emp.employment_status !== 'fired' && (
              <button
                className="sc-btn-icon"
                style={{ color: '#dc2626' }}
                title="Уволить"
                onClick={e => { e.stopPropagation(); onFire(emp); }}
              >
                <UserRoundX size={14} />
              </button>
            )}
            {canManage && (
              <button className="sc-btn-icon" title="История" onClick={e => { e.stopPropagation(); onOpenHistory(emp); }}>
                <History size={14} />
              </button>
            )}
            {canEditPos && (
              <button className="sc-btn-icon" title="Сменить должность" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'position'); }}>
                <Pencil size={14} />
              </button>
            )}
            {canEditSch && (
              <button className="sc-btn-icon" title="Назначить график" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'schedule'); }}>
                <Calendar size={14} />
              </button>
            )}
            {canEditDept && (
              <button className="sc-btn-icon" title="Сменить отдел" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'department'); }}>
                <ArrowRightLeft size={14} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
});

const VirtualCards: FC<IVirtualCardsProps> = memo(({ filtered, sideData, selectedIds, selectionMode, canManage, canEditDept, canEditPos, canEditSch, canOpenCard, onLoadMore, resetKey, onNavigate, onToggleSelect, onOpenModal, onOpenHistory, onRehire, onFire, onCancelDismissal, onReturn, onEditComment }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_ESTIMATE,
    getItemKey: index => filtered[index]?.id ?? index,
    overscan: 5,
    gap: 4,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  useVirtualListLoading(scrollRef, lastVisibleIndex, { onLoadMore, resetKey });

  return (
    <div className="sc-cards" ref={scrollRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map(vRow => {
          const emp = filtered[vRow.index];
          return (
            <div
              key={emp.id}
              ref={virtualizer.measureElement}
              data-index={vRow.index}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vRow.start}px)` }}
            >
              <MobileCard
                emp={emp}
                sideData={sideData}
                selectedIds={selectedIds}
                selectionMode={selectionMode}
                canManage={canManage}
                canEditDept={canEditDept}
                canEditPos={canEditPos}
                canEditSch={canEditSch}
                canOpenCard={canOpenCard}
                onNavigate={onNavigate}
                onToggleSelect={onToggleSelect}
                onOpenModal={onOpenModal}
                onOpenHistory={onOpenHistory}
                onRehire={onRehire}
                onFire={onFire}
                onCancelDismissal={onCancelDismissal}
                onReturn={onReturn}
                onEditComment={onEditComment}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});


/* ───────── Fire Employee Modal ───────── */

interface IFireEmployeeModalProps {
  emp: Employee;
  date: string;
  onChangeDate: (value: string) => void;
  inFlight: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const FireEmployeeModal: FC<IFireEmployeeModalProps> = ({ emp, date, onChangeDate, inFlight, onCancel, onConfirm }) => {
  const overlayHandlers = useOverlayDismiss(onCancel);
  // Классификация по МСК — как на бэкенде (иначе HR в другой TZ увидит другую ветку).
  const today = getMoscowISODate();
  const isFuture = date > today;
  const isToday = date === today;
  const minDate = emp.hire_date || undefined;

  return (
    <div className="sc-overlay" {...overlayHandlers}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>
            <UserRoundX size={16} style={{ verticalAlign: 'text-bottom', marginRight: 6, color: '#dc2626' }} />
            Уволить сотрудника
          </h3>
          <button className="sc-modal-close" onClick={onCancel} disabled={inFlight}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <div className="sc-field">
            <label>{emp.full_name}</label>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
              Последний рабочий день. Дни после этой даты не учитываются в табеле.
            </div>
            <input
              type="date"
              value={date}
              min={minDate}
              onChange={e => onChangeDate(e.target.value)}
              disabled={inFlight}
            />
            {isFuture && (
              <div style={{ fontSize: 12, color: '#b45309', marginTop: 8 }}>
                Увольнение запланировано на {date}. Сотрудник остаётся активным в Sigur и в табеле
                до 23:00 МСК выбранного дня — тогда увольнение применится автоматически.
              </div>
            )}
            {isToday && (
              <div style={{ fontSize: 12, color: '#b45309', marginTop: 8 }}>
                При выборе сегодняшней даты до 23:00 МСК увольнение откладывается: сотрудник дорабатывает
                день, перевод в папку «Уволенные» и блокировка карт пропуска — после 23:00 МСК.
                После 23:00 МСК увольнение применяется сразу.
              </div>
            )}
            {!isFuture && !isToday && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
                Сотрудник будет перемещён в папку «Уволенные» в Sigur, карты пропуска заблокированы.
              </div>
            )}
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onCancel} disabled={inFlight}>Отмена</button>
          <button
            className="sc-btn apply"
            style={{ background: '#dc2626' }}
            onClick={onConfirm}
            disabled={!date || inFlight}
          >
            {inFlight ? 'Увольняем...' : (isFuture ? 'Запланировать увольнение' : 'Уволить')}
          </button>
        </div>
      </div>
    </div>
  );
};


/* ───────── Main Page ───────── */

export const StaffControlPage: FC = () => {
  const navigate = useNavigate();
  const [urlParams, setUrlParams] = useSearchParams();
  const isMobile = useIsMobile(768);
  const [search, setSearch] = useState(() => urlParams.get('q') || '');
  const [deptId, setDeptId] = useState(() => urlParams.get('dept') || '');
  const [scheduleFilter, setScheduleFilter] = useState(() => urlParams.get('schedule') || '');
  // Раздел: явный валидный из URL сохраняется; иначе null — дефолт по скоупу ниже.
  const [sectionChoice, setSectionChoice] = useState<StaffSection | null>(() => {
    const fromUrl = urlParams.get('section');
    return isStaffSection(fromUrl) ? fromUrl : null;
  });
  const [statusFilter, setStatusFilter] = useState<StaffStatusFilter>(() => (urlParams.get('status') === 'fired' ? 'fired' : 'active'));
  const [sortKey, setSortKey] = useState<StaffSortKey>(() => {
    const fromUrl = urlParams.get('sort');
    return isStaffSortKey(fromUrl) ? fromUrl : 'name';
  });
  const [sortDir, setSortDir] = useState<StaffSortDir>(() => (urlParams.get('dir') === 'desc' ? 'desc' : 'asc'));
  // Период из URL допустим только со своим статусом (устроены — действующие, уволены — уволенные).
  const [period, setPeriod] = useState<StaffPeriod | null>(() => {
    const fromUrl = urlParams.get('period');
    const status = urlParams.get('status') === 'fired' ? 'fired' : 'active';
    if (fromUrl === 'hired_month' && status === 'active') return fromUrl;
    if (fromUrl === 'fired_month' && status === 'fired') return fromUrl;
    return null;
  });
  // Фильтры столбцов (воронки в заголовках); сериализованная форма — в URL, query key и запросы.
  const [columnFilters, setColumnFilters] = useState<IStaffColumnFilters>(() => parseColumnFilters(urlParams.get('cf')));
  const columnFiltersKey = useMemo(() => serializeColumnFilters(columnFilters), [columnFilters]);
  const activeColumnFilterCount = useMemo(() => countActiveColumnFilters(columnFilters), [columnFilters]);
  const [openFilter, setOpenFilter] = useState<{ column: StaffSortKey; anchor: HTMLElement | null } | null>(null);
  // Мобила: заголовков нет — список столбцов в нижнем листе, фильтр открывается на всю ширину.
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 300);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isAdmin, canEditPage, canViewPage, canManageAsHrAdmin, profile } = useAuth();
  // Приём, увольнение, восстановление и массовые операции исторически были зашиты
  // под is_admin. Право на них даёт edit «Управления кадрами» — сам по себе
  // all_departments_scope это только скоуп данных (см. canManageAsHrAdmin).
  const canManageStaff = canManageAsHrAdmin('/staff-control');
  // Экспорт — отдельно от canManageStaff: серверный guard у выгрузки view, и
  // руководителю отдела кнопка тоже нужна (canManageStaff даёт только админ/HR-админ).
  const canExportEmployees = isAdmin || canViewPage('/staff-control');
  const [isExporting, setIsExporting] = useState(false);
  const canEditDept = isAdmin || canEditPage('/staff-control/department');
  const canEditPos = isAdmin || canEditPage('/staff-control/position');
  const canEditSch = isAdmin || canEditPage('/staff-control/schedule');
  const canOpenCard = isAdmin || canViewPage('/employees');
  // Режим табелирования — отдельное право (миграция 249). В таблице его нет: смотрят и
  // меняют в окне «Режим табелирования» (вкладки отделы / бригады / сотрудники).
  const canEditTimesheetMode = isAdmin || canEditPage('/staff-control/timesheet-mode');
  const { isDepartmentScope, managedDepartmentIds, managedDepartmentNameById, mode: managedMode } = useManagedDepartments({ enabled: false });
  // Руководителям (`isDepartmentScope`) фильтруем всегда — даже при пустом списке
  // назначений (тогда дропдаун пуст). Без этого header без отделов видел все отделы.
  const restrictToManaged = isDepartmentScope;
  // Руководитель с одним отделом — фиксируем фильтр на этом отделе (без возможности
  // переключения). Делаем через эффект, потому что profile/managed_department_ids
  // приезжают асинхронно из useAuth.
  const isSingleManagedDept = isDepartmentScope && managedMode === 'single' && managedDepartmentIds.length === 1;
  const singleManagedDeptId = isSingleManagedDept ? managedDepartmentIds[0] : null;
  const singleManagedDeptName = singleManagedDeptId ? managedDepartmentNameById.get(singleManagedDeptId) ?? null : null;
  useEffect(() => {
    if (singleManagedDeptId && deptId !== singleManagedDeptId) {
      setDeptId(singleManagedDeptId);
    }
  }, [singleManagedDeptId, deptId]);

  // Дефолт раздела — только когда скоуп известен (profile загружен): руководителю отдела
  // «СУ-10» по умолчанию дал бы пустую таблицу, если его отделы в СМ, — ему «Все».
  const scopeKnown = profile != null;
  const section: StaffSection = sectionChoice ?? (isDepartmentScope ? 'all' : 'su10');

  const {
    employees,
    pageIdChunks,
    total,
    departments,
    countsByDepartment,
    loading,
    isFirstPageError,
    firstPageError,
    retryFirstPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loadMore,
    retryNextPage,
    totalActive,
    refresh,
    reloadFromStart,
    patchEmployee,
  } = useStaffData({
    search: debouncedSearch || undefined,
    departmentId: deptId || undefined,
    scheduleId: scheduleFilter || undefined,
    section,
    status: statusFilter,
    sort: sortKey,
    dir: sortDir,
    period: period ?? undefined,
    cf: columnFiltersKey,
    enabled: sectionChoice !== null || scopeKnown,
  });

  // Сортировка по объекту без ночного снимка недоступна (409): возвращаемся к ФИО.
  const sortUnavailable = firstPageError instanceof ApiError && firstPageError.code === 'SORT_UNAVAILABLE';
  useEffect(() => {
    if (!sortUnavailable) return;
    toast.info(firstPageError instanceof ApiError ? firstPageError.message : 'Сортировка недоступна');
    setSortKey('name');
    setSortDir('asc');
  }, [sortUnavailable, firstPageError, toast]);

  // Фильтр по объекту без ночного снимка недоступен (409): снимаем только его.
  const filterUnavailable = firstPageError instanceof ApiError && firstPageError.code === 'FILTER_UNAVAILABLE';
  useEffect(() => {
    if (!filterUnavailable) return;
    toast.info(firstPageError instanceof ApiError ? firstPageError.message : 'Фильтр недоступен');
    setColumnFilters(prev => setColumnFilter(prev, 'main_object', null));
  }, [filterUnavailable, firstPageError, toast]);

  const handleApplyColumnFilter = useCallback((column: StaffFilterColumn, value: IColumnFilterValue | null) => {
    setColumnFilters(prev => setColumnFilter(prev, column, value));
  }, []);

  const handleOpenFilter = useCallback((column: StaffSortKey, anchor: HTMLElement | null) => {
    setOpenFilter({ column, anchor });
  }, []);

  const closeFilter = useCallback(() => setOpenFilter(null), []);

  const resetColumnFilters = useCallback(() => setColumnFilters(EMPTY_COLUMN_FILTERS), []);

  const handleSort = useCallback((key: StaffSortKey) => {
    if (key === sortKey) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir('asc');
  }, [sortKey]);

  const handleStatusChange = useCallback((next: StaffStatusFilter) => {
    setStatusFilter(next);
    // Ручное переключение вкладки снимает фильтр «с начала месяца».
    setPeriod(null);
  }, []);

  const handlePeriodToggle = useCallback((next: StaffPeriod) => {
    if (period === next) {
      // Повторный клик снимает только период, вкладка остаётся.
      setPeriod(null);
      return;
    }
    setStatusFilter(next === 'hired_month' ? 'active' : 'fired');
    setPeriod(next);
  }, [period]);

  const monthMovement = useStaffMonthMovement({
    section,
    departmentId: deptId,
    search: debouncedSearch,
    scheduleId: scheduleFilter,
    cf: columnFiltersKey,
    enabled: (sectionChoice !== null || scopeKnown) && canManageStaff,
  });


  const structureTree = useStructureTree();
  const archiveDepartmentId = structureTree.data?.stats.archive_department_id ?? null;

  const today = getLocalISODate();
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<number[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkScheduleOpen, setBulkScheduleOpen] = useState(false);
  const [bulkFilterScheduleOpen, setBulkFilterScheduleOpen] = useState(false);
  const [bulkBrigadeScheduleOpen, setBulkBrigadeScheduleOpen] = useState(false);
  const [bulkMoveDeptOpen, setBulkMoveDeptOpen] = useState(false);
  const [bulkTsModeOpen, setBulkTsModeOpen] = useState(false);
  // «Объект», «Статья затрат», «График» — по одному запросу на порцию списка.
  const mainObjectsData = useStaffMainObjects(pageIdChunks);
  const mainObjectPeriod = mainObjectsData.period;
  const mainObjectTitle = mainObjectPeriod
    ? `Где больше всего часов по СКУД и корректировкам за ${formatDate(mainObjectPeriod.start)}–${formatDate(mainObjectPeriod.end)}. Пересчитывается ночью.`
    : 'Где больше всего часов по СКУД и корректировкам за последние 30 дней';
  const scheduleTemplatesQuery = useQuery({
    queryKey: ['schedules', 'templates'],
    queryFn: () => scheduleService.list(),
    staleTime: 5 * 60_000,
  });
  const scheduleAssignmentsData = useStaffScheduleAssignments(pageIdChunks);
  const scheduleTemplates = scheduleTemplatesQuery.data ?? EMPTY_SCHEDULE_TEMPLATES;

  const loadedEmployeeIds = useMemo(() => new Set(employees.map(emp => emp.id)), [employees]);
  const selectedEmployeeIdsVisible = useMemo(
    () => selectedEmployeeIds.filter(id => loadedEmployeeIds.has(id)),
    [selectedEmployeeIds, loadedEmployeeIds],
  );
  const selectedEmployeeIdSet = useMemo(() => new Set(selectedEmployeeIdsVisible), [selectedEmployeeIdsVisible]);

  const selectedEmployees = useMemo(
    () => employees.filter(emp => selectedEmployeeIdSet.has(emp.id)),
    [employees, selectedEmployeeIdSet],
  );

  const selectedEmployeesPreview = useMemo(() => {
    const names = selectedEmployees.slice(0, 3).map(emp => emp.full_name);
    const rest = Math.max(0, selectedEmployees.length - names.length);
    if (names.length === 0) return 'Нет выбранных сотрудников';
    return rest > 0 ? `${names.join(', ')} и ещё ${rest}` : names.join(', ');
  }, [selectedEmployees]);

  const allVisibleSelected = useMemo(
    () => employees.length > 0 && employees.every(emp => selectedEmployeeIdSet.has(emp.id)),
    [employees, selectedEmployeeIdSet],
  );

  // Шаблоны не загрузились — default-график неизвестен: вместо «—» оставляем загрузку/ошибку.
  const templatesReady = scheduleTemplatesQuery.isSuccess;
  const { scheduleViews, baseScheduleViews } = useMemo(() => buildScheduleViews({
    employeeIds: employees.map(emp => emp.id),
    assignments: scheduleAssignmentsData.assignments,
    templates: scheduleTemplates,
    templatesReady,
    readyIds: scheduleAssignmentsData.readyIds,
    today,
  }), [employees, scheduleAssignmentsData.assignments, scheduleAssignmentsData.readyIds, scheduleTemplates, templatesReady, today]);

  const scheduleReadiness = useMemo<IChunkReadiness>(() => {
    if (templatesReady) return { readyIds: scheduleAssignmentsData.readyIds, errorIds: scheduleAssignmentsData.errorIds };
    // Без шаблонов готовых строк нет; при ошибке шаблонов — все загруженные строки в ошибке.
    return {
      readyIds: new Set<number>(),
      errorIds: scheduleTemplatesQuery.isError ? loadedEmployeeIds : scheduleAssignmentsData.errorIds,
    };
  }, [templatesReady, scheduleAssignmentsData.readyIds, scheduleAssignmentsData.errorIds, scheduleTemplatesQuery.isError, loadedEmployeeIds]);

  const sideDataHasError = mainObjectsData.hasError || scheduleAssignmentsData.hasError || scheduleTemplatesQuery.isError;
  const { retryFailed: retryMainObjects } = mainObjectsData;
  const { retryFailed: retryScheduleAssignments } = scheduleAssignmentsData;
  const { refetch: refetchScheduleTemplates, isError: scheduleTemplatesFailed } = scheduleTemplatesQuery;
  const retrySideData = useCallback(() => {
    retryMainObjects();
    retryScheduleAssignments();
    if (scheduleTemplatesFailed) void refetchScheduleTemplates();
  }, [retryMainObjects, retryScheduleAssignments, scheduleTemplatesFailed, refetchScheduleTemplates]);

  const sideData = useMemo<IStaffSideData>(() => ({
    scheduleViews,
    scheduleReadiness,
    mainObjects: mainObjectsData.objects,
    mainReadiness: { readyIds: mainObjectsData.readyIds, errorIds: mainObjectsData.errorIds },
  }), [scheduleViews, scheduleReadiness, mainObjectsData.objects, mainObjectsData.readyIds, mainObjectsData.errorIds]);

  // URL пишется целиком из состояния: смена одного фильтра не стирает сортировку и период.
  useEffect(() => {
    const p = new URLSearchParams();
    if (deptId) p.set('dept', deptId);
    if (debouncedSearch) p.set('q', debouncedSearch);
    if (scheduleFilter) p.set('schedule', scheduleFilter);
    if (sectionChoice) p.set('section', sectionChoice);
    if (statusFilter !== 'active') p.set('status', statusFilter);
    if (sortKey !== 'name' || sortDir !== 'asc') {
      p.set('sort', sortKey);
      p.set('dir', sortDir);
    }
    if (period) p.set('period', period);
    if (columnFiltersKey) p.set('cf', columnFiltersKey);
    setUrlParams(p, { replace: true });
  }, [deptId, debouncedSearch, scheduleFilter, sectionChoice, statusFilter, sortKey, sortDir, period, columnFiltersKey, setUrlParams]);

  // history panel
  const [panelEmp, setPanelEmp] = useState<Employee | null>(null);
  const [panelHistory, setPanelHistory] = useState<EmployeeHistoryEvent[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);

  // modals
  const [modalType, setModalType] = useState<ModalType | null>(null);
  const [modalEmp, setModalEmp] = useState<Employee | null>(null);

  // import / add
  const [showImportModal, setShowImportModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  // Мастер со сканами живёт на вкладке «Новый сотрудник». Пока она доступна,
  // кнопку здесь не показываем — точка входа должна быть одна. Если модуль
  // выключен, каталог не ответил или нет прав, кнопка остаётся со старой модалкой
  // Sigur, чтобы «добавить негде» не случилось ни при каком раскладе.
  const canUseHrWizard = isAdmin || canEditPage('/staff-control/hr-profiles');
  const hrCatalogQuery = useQuery({
    queryKey: ['hr-catalog'],
    queryFn: () => hrProfileService.getCatalog(),
    enabled: canUseHrWizard,
    staleTime: 30 * 60_000,
    retry: false,
  });
  const hrTabAvailable = canUseHrWizard && hrCatalogQuery.data?.enabled === true;
  const [addForm, setAddForm] = useState<IAddEmployeeForm>({
    full_name: '',
    hire_date: getLocalISODate(),
    org_department_id: '',
    position_id: '',
    tab_number: '',
  });
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);
  const positionsQuery = useQuery({
    queryKey: ['structure', 'positions'],
    queryFn: async () => {
      const res = await structureApi.getPositions();
      if (res.error) throw new Error(res.error);
      return res.data || [];
    },
    enabled: showAddModal,
    staleTime: 5 * 60_000,
  });

  // ─── Sigur duplicate detection (live search by full_name) ───
  const sigurDuplicatesQueryDebounced = useDebouncedValue(
    showAddModal ? addForm.full_name.trim() : '',
    300,
  );
  const sigurDuplicatesEnabled = showAddModal && sigurDuplicatesQueryDebounced.length >= 2;
  const sigurDuplicatesResult = useQuery({
    queryKey: ['sigur-duplicates', sigurDuplicatesQueryDebounced],
    queryFn: () => sigurAdminService.getEmployees({
      search: sigurDuplicatesQueryDebounced,
      pageSize: 8,
    }),
    enabled: sigurDuplicatesEnabled,
    staleTime: 30_000,
  });
  const sigurDuplicates = sigurDuplicatesResult.data?.items || [];

  // ─── Sigur edit dialog state ───
  const [sigurEditDialog, setSigurEditDialog] = useState<{
    sigurEmployeeId: number;
    name: string;
    departmentId: string;
    positionId: string;
    tabId: string;
    description: string;
    blocked: boolean;
  } | null>(null);
  const [loadingSigurProfile, setLoadingSigurProfile] = useState(false);
  const [sigurEditSaving, setSigurEditSaving] = useState(false);
  const [sigurEditError, setSigurEditError] = useState<string | null>(null);

  const sigurDeptsQuery = useQuery({
    queryKey: ['sigur-admin', 'departments-tree'],
    queryFn: () => sigurAdminService.getDepartmentsTree(),
    enabled: sigurEditDialog !== null,
    staleTime: 5 * 60_000,
  });
  const sigurPositionsQuery = useQuery({
    queryKey: ['sigur-admin', 'positions'],
    queryFn: () => sigurAdminService.getPositions(),
    enabled: sigurEditDialog !== null,
    staleTime: 5 * 60_000,
  });

  const sigurDeptOptions = useMemo(() => {
    const flatten = (
      nodes: SigurDepartmentNode[],
      level = 0,
    ): Array<{ id: number; name: string; level: number }> =>
      nodes.flatMap(node => [
        { id: node.id, name: node.name, level },
        ...flatten(node.children || [], level + 1),
      ]);
    return flatten(sigurDeptsQuery.data || []);
  }, [sigurDeptsQuery.data]);
  const [enrichPreview, setEnrichPreview] = useState<EnrichPreview | null>(null);
  const [enrichFile, setEnrichFile] = useState<File | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [salaryEnrichPreview, setSalaryEnrichPreview] = useState<EnrichPreview | null>(null);
  const [salaryEnrichFile, setSalaryEnrichFile] = useState<File | null>(null);
  const [salaryEnrichLoading, setSalaryEnrichLoading] = useState(false);
  const [salaryHistoryPreview, setSalaryHistoryPreview] = useState<EnrichPreview | null>(null);
  const [salaryHistoryFile, setSalaryHistoryFile] = useState<File | null>(null);
  const [salaryHistoryLoading, setSalaryHistoryLoading] = useState(false);
  const [contactsPreview, setContactsPreview] = useState<ContactsEnrichPreview | null>(null);
  const [contactsFile, setContactsFile] = useState<File | null>(null);
  const [contactsLoading, setContactsLoading] = useState(false);

  /* ─── memoized computations ─── */

  // Бэкенд (`filterTreeByScope` в structure.controller.ts) уже отдаёт дерево,
  // обрезанное под scope пользователя, с пометкой `in_scope` на каждом узле.
  // Дополнительная фронт-фильтрация через `profile.managed_department_ids`
  // создавала рассинхрон: profile грузится один раз при логине, бэк отдаёт
  // свежий scope на каждый запрос — после изменения назначений руководителю
  // дропдаун показывал устаревший список (1 отдел вместо 3).
  // Доп. клиентский фильтр поверх scope, отданного бэком: страхует случай,
  // когда /api/structure отдаёт stale-кэш с отозванным отделом до инвалидации.
  const allDepts = useMemo(() => {
    if (!restrictToManaged) return getTreeFlatDepartments(departments);
    const filtered = filterDepartmentTreeByIds(departments, new Set(managedDepartmentIds));
    return getTreeFlatDepartments(filtered);
  }, [departments, restrictToManaged, managedDepartmentIds]);

  // Дерево в пределах scope пользователя: тот же фильтр, что и allDepts, но БЕЗ
  // расплющивания. Идёт в модалки (перевод, режим табелирования) — раздел шапки их не сужает.
  const scopeDeptTree = useMemo(
    () => (restrictToManaged
      ? filterDepartmentTreeByIds(departments, new Set(managedDepartmentIds))
      : departments),
    [departments, restrictToManaged, managedDepartmentIds],
  );

  // Каскад «Компания → Отделы»: только фильтр в шапке, модалки получают scopeDeptTree.
  // «Все компании» — только ветки компаний; служебные корни («Уволенные», «test») сервер
  // относит к «Прочим». Пока id разделов грузятся или не загрузились — дерево пустое,
  // иначе служебные корни мелькнули бы (или остались при ошибке).
  const sectionDepartmentsQuery = useStaffSectionDepartments();
  const headerDeptFilter = useMemo(
    () => resolveHeaderDeptFilter({ section, sectionIds: sectionDepartmentsQuery.data, restrictToManaged }),
    [section, sectionDepartmentsQuery.data, restrictToManaged],
  );
  const filterDeptTree = useMemo(() => {
    if (headerDeptFilter.kind === 'none') return scopeDeptTree;
    if (headerDeptFilter.kind === 'pending') return EMPTY_DEPT_TREE;
    return filterDepartmentTreeByIds(scopeDeptTree, new Set(headerDeptFilter.ids));
  }, [scopeDeptTree, headerDeptFilter]);
  const headerDeptPending = headerDeptFilter.kind === 'pending';

  // Отдел не из выбранной компании или служебный (из URL, «назад», восстановленные параметры)
  // дал бы неожиданную таблицу — сбрасываем. До загрузки id разделов не решаем.
  // Фиксированный отдел руководителя не трогаем.
  useEffect(() => {
    if (!deptId || singleManagedDeptId) return;
    if (isHeaderDeptAllowed(deptId, headerDeptFilter) !== false) return;
    setDeptId('');
  }, [deptId, headerDeptFilter, singleManagedDeptId]);

  // Если админ снял у руководителя один из отделов, бэкенд перестаёт включать его
  // в `allDepts` (в дереве флаг `in_scope=false` или отдел вырезан). В URL ещё может
  // висеть ?dept= снятого отдела — без сброса фронт продолжит слать его на бэк
  // (теперь это 403). Чистим тихо. Источник истины — `allDepts`, а не stale-profile.
  useEffect(() => {
    if (!restrictToManaged || !deptId) return;
    if (allDepts.length === 0) return; // дерево ещё не загружено
    if (allDepts.some(d => d.id === deptId && d.inScope)) return;
    setDeptId('');
  }, [restrictToManaged, deptId, allDepts]);
  const brigadeOptions = useMemo<IBrigadeOption[]>(
    () => allDepts
      .filter(department => department.kind === 'brigade' && (countsByDepartment[department.id] || 0) > 0)
      .map(department => ({
        ...department,
        employeeCount: countsByDepartment[department.id] || 0,
      })),
    [allDepts, countsByDepartment],
  );

  const currentFilterDescription = useMemo(() => {
    const parts: string[] = [];
    if (section !== 'all') {
      const sectionLabel = STAFF_SECTION_OPTIONS.find(option => option.value === section)?.label;
      if (sectionLabel) parts.push(`Компания: ${sectionLabel}`);
    }
    if (deptId) {
      const deptName = allDepts.find(dept => dept.id === deptId)?.name;
      if (deptName) parts.push(`Отдел: ${deptName}`);
    }
    if (scheduleFilter) {
      if (scheduleFilter === '__default__') {
        const defaultName = scheduleTemplates.find(t => t.is_default)?.name;
        parts.push(`График: ${defaultName || 'по умолчанию'}`);
      } else {
        const scheduleName = scheduleTemplates.find(t => t.id === scheduleFilter)?.name;
        if (scheduleName) parts.push(`График: ${scheduleName}`);
      }
    }
    if (debouncedSearch) {
      parts.push(`Поиск: "${debouncedSearch}"`);
    }
    if (period === 'hired_month') parts.push('Устроены с начала месяца');
    if (activeColumnFilterCount > 0) parts.push(`Фильтры столбцов: ${activeColumnFilterCount}`);
    if (parts.length === 0) return 'Все действующие сотрудники';
    return parts.join(' • ');
  }, [section, deptId, scheduleFilter, debouncedSearch, period, activeColumnFilterCount, allDepts, scheduleTemplates]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
  }, []);

  const handleDeptChange = useCallback((value: string) => {
    setDeptId(value);
  }, []);

  // Прокрутка к началу — только при смене фактических фильтров и сортировки, не при догрузке порций.
  const listResetKey = `${section}|${deptId}|${scheduleFilter}|${debouncedSearch}|${statusFilter}|${sortKey}|${sortDir}|${period ?? ''}|${columnFiltersKey}`;

  // «Уволенные» доступны только с правом управления кадрами: ?status=fired из чужой ссылки — сброс.
  useEffect(() => {
    if (!profile || canManageStaff || statusFilter === 'active') return;
    setStatusFilter('active');
    setPeriod(null);
  }, [profile, canManageStaff, statusFilter]);

  // Комментарий HR: правят те, у кого edit «Управления кадрами» (скоуп проверяет сервер).
  const canEditStaffComment = isAdmin || canEditPage('/staff-control');
  const [commentEmp, setCommentEmp] = useState<Employee | null>(null);
  const closeCommentModal = useCallback(() => setCommentEmp(null), []);
  const commentEditHandler = canEditStaffComment ? setCommentEmp : undefined;

  /**
   * Правка строки: затронут столбец активной сортировки или фильтра — перечитать список (строка
   * могла сменить место или выпасть из выдачи), иначе поправить на месте.
   */
  const applyRowChange = useCallback((empId: number, patch: Partial<Employee>, changes: readonly StaffRowChange[]) => {
    patchEmployee(empId, patch);
    if (affectsActiveSort(changes, sortKey)
      || affectsActiveFilters(changes, column => isColumnFilterActive(columnFilters, column))) {
      reloadFromStart();
    }
  }, [patchEmployee, reloadFromStart, sortKey, columnFilters]);

  const handleCommentSaved = useCallback((emp: Employee, saved: IStaffCommentSaved) => {
    applyRowChange(emp.id, {
      staff_comment: saved.comment,
      staff_comment_updated_at: saved.updated_at,
      staff_comment_updated_by_name: saved.updated_by_name,
    }, saved.changed ? ['comment'] : []);
  }, [applyRowChange]);

  const handleSectionChange = useCallback((value: StaffSection) => {
    setSectionChoice(value);
    // Отдел из другого раздела дал бы пустой список; фиксированный отдел руководителя не трогаем.
    if (!singleManagedDeptId) setDeptId('');
  }, [singleManagedDeptId]);

  const handleScheduleFilterChange = useCallback((value: string) => {
    setScheduleFilter(value);
  }, []);

  /* ─── stable callbacks for child components ─── */

  const handleNavigate = useCallback((emp: Employee) => {
    navigate(`/employees/${emp.id}`, { state: { label: 'Управление кадрами', from: `/staff-control?${urlParams.toString()}` } });
  }, [navigate, urlParams]);

  const openHistory = useCallback(async (emp: Employee) => {
    setPanelEmp(emp);
    setPanelLoading(true);
    const history = await employeeService.getHistory(emp.id);
    setPanelHistory(history);
    setPanelLoading(false);
  }, []);

  const closeHistory = useCallback(() => {
    setPanelEmp(null);
    setPanelHistory([]);
  }, []);

  const openModal = useCallback((emp: Employee, type: ModalType) => {
    setModalEmp(emp);
    setModalType(type);
  }, []);

  const closeModal = useCallback(() => {
    setModalType(null);
    setModalEmp(null);
  }, []);

  const toggleSelectEmployee = useCallback((empId: number) => {
    setSelectedEmployeeIds(prev => (
      prev.includes(empId)
        ? prev.filter(id => id !== empId)
        : [...prev, empId]
    ));
  }, []);

  const toggleSelectAllVisible = useCallback(() => {
    const visibleIds = employees.map(emp => emp.id);
    const visibleSet = new Set(visibleIds);

    setSelectedEmployeeIds(prev => {
      const everySelected = visibleIds.length > 0 && visibleIds.every(id => prev.includes(id));
      if (everySelected) return prev.filter(id => !visibleSet.has(id));
      const next = new Set(prev);
      visibleIds.forEach(id => next.add(id));
      return Array.from(next);
    });
  }, [employees]);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode(prev => {
      if (prev) setSelectedEmployeeIds([]);
      return !prev;
    });
  }, []);

  /* ─── modal save handlers ─── */

  const handleSavePosition = useCallback(async (empId: number, val: string, reason?: string, date?: string) => {
    await employeeService.changePosition(empId, val, reason, date);
    closeModal();
    applyRowChange(empId, { position_name: val }, ['position']);
  }, [closeModal, applyRowChange]);

  const handleSaveDepartment = useCallback(async (empId: number, newDeptId: string, effectiveDate?: string, reason?: string) => {
    try {
      const target = employees.find(emp => emp.id === empId);
      const isReturn = Boolean(target?.excluded_from_timesheet);
      if (isReturn) {
        await timesheetService.addEmployeeToDepartment({
          employee_id: empId,
          department_id: newDeptId,
          effective_from: effectiveDate || getLocalISODate(),
        });
      } else {
        await employeeService.moveDepartment(empId, newDeptId, effectiveDate, reason);
      }
      closeModal();
      const deptName = allDepts.find(d => d.id === newDeptId)?.name;
      applyRowChange(empId, {
        org_department_id: newDeptId,
        department: deptName,
        ...(isReturn ? { excluded_from_timesheet: false, excluded_from_timesheet_at: null } : {}),
      }, ['department']);
      if (isReturn) toast.success('Сотрудник возвращён в табель');
      // Отдел в строке обновлён сразу, а «Признак» (перенос в «Декрет» и обратно) считает
      // сервер — фоновым перезапросом страницы, без «Загрузка…» и сброса прокрутки.
      refresh();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Не удалось перенести сотрудника';
      toast.error(msg);
      throw e;
    }
  }, [closeModal, applyRowChange, allDepts, toast, employees, refresh]);

  const handleReturnToTimesheet = useCallback((emp: Employee) => {
    openModal(emp, 'department');
  }, [openModal]);

  const handleBulkMoveDepartment = useCallback(async (newDeptId: string, effectiveDate: string, reason?: string) => {
    if (selectedEmployeeIdsVisible.length === 0) return;
    try {
      const result = await employeeService.batchMove(selectedEmployeeIdsVisible, newDeptId, effectiveDate, reason);
      const parts = [`Переведено ${result.moved_count}`];
      if (result.skipped_count > 0) parts.push(`пропущено ${result.skipped_count}`);
      if (result.failed_count > 0) parts.push(`ошибок ${result.failed_count}`);
      const message = parts.join(', ');
      if (result.failed_count > 0) toast.error(message);
      else toast.success(message);
      setBulkMoveDeptOpen(false);
      setSelectionMode(false);
      setSelectedEmployeeIds([]);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Не удалось перевести сотрудников';
      toast.error(msg);
    }
  }, [selectedEmployeeIdsVisible, toast, refresh, queryClient]);

  /**
   * Обновление после правки сотрудников на этой странице. Порции графиков — только те, где есть
   * изменённые сотрудники (после правки одного человека при 10 тыс. строк — один POST, а не
   * по запросу на порцию). Порции списка перечитываются, только если список мог измениться:
   * увольнение/восстановление или активный фильтр по графику.
   */
  const refreshAfterEmployeeChange = useCallback(async (
    employeeIds: readonly number[] | 'all',
    { listChanged }: { listChanged: boolean },
  ): Promise<void> => {
    const tasks: Array<Promise<void>> = [
      // Прочие ключи графиков (история назначений в окне и т.п.) — целиком, они не порционные.
      queryClient.invalidateQueries({
        predicate: query => query.queryKey[0] === 'schedules' && query.queryKey[1] !== STAFF_SCHEDULE_ASSIGNMENTS_QUERY_KEY[1],
      }),
    ];
    if (listChanged) {
      tasks.push(queryClient.invalidateQueries({ queryKey: ['employees'] }));
      tasks.push(queryClient.invalidateQueries({ queryKey: ['structure'] }));
    }
    if (employeeIds === 'all') {
      tasks.push(queryClient.invalidateQueries({ queryKey: STAFF_SCHEDULE_ASSIGNMENTS_QUERY_KEY }));
    } else {
      for (const id of employeeIds) tasks.push(queryClient.invalidateQueries({ queryKey: ['employee', id] }));
      tasks.push(refreshStaffChunksFor(queryClient, STAFF_SCHEDULE_ASSIGNMENTS_QUERY_KEY, employeeIds));
    }
    await Promise.all(tasks);
  }, [queryClient]);

  // Состав списка при фильтре по графику и порядок при сортировке по графику зависят от назначений.
  const scheduleChangeAffectsList = Boolean(scheduleFilter)
    || affectsActiveSort(['schedule'], sortKey)
    || isColumnFilterActive(columnFilters, 'schedule');

  // Смена графика влияет на табель (норма/покраска/согласования считаются из
  // расписания). Сбрасываем кэш табеля, иначе пользователь видит старое.
  const invalidateTimesheetQueries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['timesheet-page'] });
    void queryClient.invalidateQueries({ queryKey: ['timesheet'] });
    void queryClient.invalidateQueries({ queryKey: ['timesheet-grid'] });
    void queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] });
    void queryClient.invalidateQueries({ queryKey: ['employee-timesheet'] });
  }, [queryClient]);

  const handleSaveSchedule = useCallback(async (empId: number, scheduleId: string | null, effectiveFrom: string, anchorDate: string | null, mergeIntoNext?: boolean) => {
    try {
      if (scheduleId) {
        await scheduleService.assignEmployee(empId, {
          schedule_id: scheduleId,
          effective_from: effectiveFrom,
          anchor_date: anchorDate,
          ...(mergeIntoNext !== undefined ? { merge_into_next: mergeIntoNext } : {}),
        });
      } else {
        await scheduleService.removeEmployeeAssignment(empId, effectiveFrom);
      }
      invalidateTimesheetQueries();
      // Дожидаемся свежей порции графиков сотрудника ДО закрытия модалки, чтобы строка
      // обновилась без перезагрузки страницы.
      await refreshAfterEmployeeChange([empId], { listChanged: scheduleChangeAffectsList });
      toast.success(scheduleId ? 'График назначен' : 'Персональный график снят');
      closeModal();
    } catch (e) {
      // Ошибку не глотаем (раньше — «тихо ничего», модалка закрывалась):
      // показываем тост, модалку оставляем открытой для повтора.
      toast.error(e instanceof ApiError ? e.message : 'Не удалось сохранить график');
    }
  }, [closeModal, refreshAfterEmployeeChange, scheduleChangeAffectsList, toast, invalidateTimesheetQueries]);

  const handleFixAssignment = useCallback(async (
    empId: number,
    data: { assignment_id: string; effective_from?: string; anchor_date?: string | null },
  ) => {
    try {
      await scheduleService.fixEmployeeAssignment(empId, data);
      invalidateTimesheetQueries();
      await refreshAfterEmployeeChange([empId], { listChanged: scheduleChangeAffectsList });
      toast.success('Даты назначения исправлены');
      closeModal();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Не удалось исправить даты назначения');
    }
  }, [closeModal, refreshAfterEmployeeChange, scheduleChangeAffectsList, toast, invalidateTimesheetQueries]);

  // Жёсткое удаление КОНКРЕТНОЙ строки из истории назначений (через кнопку 🗑
  // в блоке «История» внутри модалки). Модалку не закрываем — пользователь
  // продолжает чистить список или править оставшиеся записи.
  const handleDeleteAssignmentRow = useCallback(async (
    empId: number,
    assignmentId: string,
  ) => {
    try {
      await scheduleService.deleteEmployeeAssignment(empId, assignmentId);
      invalidateTimesheetQueries();
      await refreshAfterEmployeeChange([empId], { listChanged: scheduleChangeAffectsList });
      toast.success('Запись назначения удалена');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Не удалось удалить запись назначения');
    }
  }, [refreshAfterEmployeeChange, scheduleChangeAffectsList, toast, invalidateTimesheetQueries]);

  const applyScheduleToEmployees = useCallback(async (
    employeeIds: number[],
    scheduleId: string | null,
    effectiveFrom: string,
  ): Promise<{ ok: number; failed: number; sampleError?: string }> => {
    if (employeeIds.length === 0) return { ok: 0, failed: 0 };
    const CHUNK_SIZE = 20;
    let ok = 0;
    let failed = 0;
    let sampleError: string | undefined;

    // allSettled: один сбойный сотрудник не валит всю пачку — собираем сводку
    // и показываем её в тосте (раньше Promise.all → молчаливый reject).
    for (let i = 0; i < employeeIds.length; i += CHUNK_SIZE) {
      const chunk = employeeIds.slice(i, i + CHUNK_SIZE);
      const results = await Promise.allSettled(chunk.map(empId => scheduleId
        ? scheduleService.assignEmployee(empId, { schedule_id: scheduleId, effective_from: effectiveFrom })
        : scheduleService.removeEmployeeAssignment(empId, effectiveFrom)));
      for (const r of results) {
        if (r.status === 'fulfilled') {
          ok++;
        } else {
          failed++;
          if (!sampleError) sampleError = r.reason instanceof Error ? r.reason.message : String(r.reason);
        }
      }
    }
    return { ok, failed, sampleError };
  }, []);

  const handleBulkSaveSchedule = useCallback(async (scheduleId: string | null, effectiveFrom: string) => {
    const ids = selectedEmployees.map(employee => employee.id);
    const { ok, failed, sampleError } = await applyScheduleToEmployees(ids, scheduleId, effectiveFrom);
    void refreshAfterEmployeeChange(ids, { listChanged: scheduleChangeAffectsList });
    invalidateTimesheetQueries();
    setBulkScheduleOpen(false);
    setSelectedEmployeeIds([]);
    if (ids.length === 0) return;
    if (failed > 0) {
      toast.error(`Обновлено ${ok} из ${ids.length}, не удалось ${failed}.` + (sampleError ? ` Пример: ${sampleError}` : ''));
    } else {
      toast.success(`Сотрудников обновлено: ${ok}.`);
    }
  }, [applyScheduleToEmployees, refreshAfterEmployeeChange, scheduleChangeAffectsList, selectedEmployees, toast, invalidateTimesheetQueries]);

  const [rehireEmp, setRehireEmp] = useState<Employee | null>(null);
  const [rehireDeptId, setRehireDeptId] = useState('');
  // Дата восстановления намеренно пустая: «сегодня» по умолчанию давало неверный приём.
  const [rehireDate, setRehireDate] = useState('');
  const [rehireInFlight, setRehireInFlight] = useState(false);

  const resetRehireForm = useCallback(() => {
    setRehireEmp(null);
    setRehireDeptId('');
    setRehireDate('');
  }, []);

  const handleRehire = useCallback((emp: Employee) => {
    setRehireEmp(emp);
    setRehireDeptId('');
    setRehireDate('');
  }, []);

  const closeRehireModal = useCallback(() => {
    if (rehireInFlight) return;
    resetRehireForm();
  }, [rehireInFlight, resetRehireForm]);

  const rehireOverlayHandlers = useOverlayDismiss(closeRehireModal);

  const handleConfirmRehire = useCallback(async () => {
    if (!rehireEmp || !rehireDeptId || !rehireDate) return;
    setRehireInFlight(true);
    try {
      await employeeService.rehire(rehireEmp.id, rehireDeptId, rehireDate);
      const rehiredId = rehireEmp.id;
      resetRehireForm();
      void refreshAfterEmployeeChange([rehiredId], { listChanged: true });
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Ошибка восстановления сотрудника';
      toast.error(msg);
    } finally {
      setRehireInFlight(false);
    }
  }, [rehireEmp, rehireDeptId, rehireDate, resetRehireForm, refreshAfterEmployeeChange, toast]);

  const [fireEmp, setFireEmp] = useState<Employee | null>(null);
  const [fireDate, setFireDate] = useState<string>(() => getMoscowISODate());
  const [fireInFlight, setFireInFlight] = useState(false);

  const handleFire = useCallback((emp: Employee) => {
    setFireEmp(emp);
    setFireDate(getMoscowISODate());
  }, []);

  const closeFireModal = useCallback(() => {
    if (fireInFlight) return;
    setFireEmp(null);
  }, [fireInFlight]);

  const handleConfirmFire = useCallback(async () => {
    if (!fireEmp || !fireDate) return;
    setFireInFlight(true);
    try {
      await employeeService.fire(fireEmp.id, fireDate);
      const firedId = fireEmp.id;
      setFireEmp(null);
      void refreshAfterEmployeeChange([firedId], { listChanged: true });
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Ошибка увольнения сотрудника';
      toast.error(msg);
    } finally {
      setFireInFlight(false);
    }
  }, [fireEmp, fireDate, refreshAfterEmployeeChange, toast]);

  const handleCancelDismissal = useCallback(async (emp: Employee) => {
    if (!confirm(`Отменить запланированное увольнение ${emp.full_name} на ${emp.dismissal_date}?`)) return;
    try {
      await employeeService.cancelDismissal(emp.id);
      void refreshAfterEmployeeChange([emp.id], { listChanged: true });
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Не удалось отменить запланированное увольнение';
      toast.error(msg);
    }
  }, [refreshAfterEmployeeChange, toast]);

  const handleFilteredBulkSaveSchedule = useCallback(async (scheduleId: string | null, effectiveFrom: string) => {
    const employeeIds = await employeeService.getFilteredIds({
      search: debouncedSearch || undefined,
      departmentId: deptId || undefined,
      section,
      status: 'active',
      // Как в таблице: при чипе «Устроены» — только принятые с начала месяца.
      period: period === 'hired_month' ? period : undefined,
      cf: columnFiltersKey || undefined,
      view: 'list',
    });
    const { ok, failed, sampleError } = await applyScheduleToEmployees(employeeIds, scheduleId, effectiveFrom);
    void refreshAfterEmployeeChange(employeeIds, { listChanged: scheduleChangeAffectsList });
    invalidateTimesheetQueries();
    setBulkFilterScheduleOpen(false);
    if (employeeIds.length === 0) return;
    if (failed > 0) {
      toast.error(`Обновлено ${ok} из ${employeeIds.length}, не удалось ${failed}.` + (sampleError ? ` Пример: ${sampleError}` : ''));
    } else {
      toast.success(`Сотрудников обновлено: ${ok}.`);
    }
  }, [applyScheduleToEmployees, debouncedSearch, deptId, section, period, columnFiltersKey, refreshAfterEmployeeChange, scheduleChangeAffectsList, toast, invalidateTimesheetQueries]);

  const handleBrigadeBulkSaveSchedule = useCallback(async (
    departmentIds: string[],
    mode: 'assign' | 'reset' | 'shift_start',
    scheduleId: string | null,
    effectiveFrom: string,
  ) => {
    try {
      const result = await scheduleService.bulkApplyToBrigades({
        department_ids: departmentIds,
        action: mode,
        schedule_id: scheduleId || undefined,
        effective_date: effectiveFrom,
      });

      const base = `Обработано бригад: ${result.departments_processed}.`;
      const failed = result.employees_failed ?? 0;
      if (result.employees_matched === 0) {
        toast.info(`${base} ${result.note ?? 'Активных сотрудников в выбранных бригадах нет.'}`);
      } else if (failed > 0) {
        toast.error(
          `${base} Обновлено ${result.employees_updated} из ${result.employees_matched}, не удалось ${failed}.`
          + (result.sample_errors?.length ? ` Пример: ${result.sample_errors[0]}` : ''),
        );
      } else if (result.employees_updated > 0) {
        toast.success(`${base} Сотрудников обновлено: ${result.employees_updated} из ${result.employees_matched}.`);
      } else {
        toast.info(`${base} ${result.note ?? 'Активных изменений нет.'}`);
      }

      setBulkBrigadeScheduleOpen(false);
    } catch (error) {
      toast.error(error instanceof Error
        ? `${error.message}. Видимые графики на странице обновлены для проверки состояния.`
        : 'Не удалось массово назначить график по бригадам. Видимые графики на странице обновлены для проверки состояния.');
    } finally {
      // Затронутые сотрудники заранее неизвестны (все в выбранных бригадах) — порции графиков целиком.
      void refreshAfterEmployeeChange('all', { listChanged: scheduleChangeAffectsList });
      invalidateTimesheetQueries();
    }
  }, [refreshAfterEmployeeChange, scheduleChangeAffectsList, toast, invalidateTimesheetQueries]);

  /* ─── history panel data changed ─── */

  const handleHistoryDataChanged = useCallback(() => {
    if (panelEmp) openHistory(panelEmp);
  }, [panelEmp, openHistory]);

  /* ─── import handlers ─── */

  const handleEnrichFile = async (file: File) => {
    setShowImportModal(false);
    setEnrichLoading(true);
    try {
      const preview = await employeeService.enrichPreview(file);
      setEnrichPreview(preview);
      setEnrichFile(file);
    } catch { /* ignore */ }
    setEnrichLoading(false);
  };

  const handleEnrichApply = async (manualMatches: Array<{ fullName: string; employeeId: number }> = []) => {
    if (!enrichFile) return;
    setEnrichLoading(true);
    try {
      const r = await employeeService.enrichApply(enrichFile, manualMatches);
      alert(`Обновлено: ${r.updated} сотрудников`);
      refresh();
    } catch { /* ignore */ }
    setEnrichLoading(false);
    setEnrichPreview(null);
    setEnrichFile(null);
  };

  const handleSalaryFile = async (file: File) => {
    setShowImportModal(false);
    setSalaryEnrichLoading(true);
    try {
      const preview = await employeeService.salaryEnrichPreview(file);
      setSalaryEnrichPreview(preview);
      setSalaryEnrichFile(file);
    } catch { /* ignore */ }
    setSalaryEnrichLoading(false);
  };

  const handleSalaryApply = async (manualMatches: Array<{ fullName: string; employeeId: number }> = []) => {
    if (!salaryEnrichFile) return;
    setSalaryEnrichLoading(true);
    try {
      const r = await employeeService.salaryEnrichApply(salaryEnrichFile, manualMatches);
      alert(`Обновлено: ${r.updated} сотрудников`);
      refresh();
    } catch { /* ignore */ }
    setSalaryEnrichLoading(false);
    setSalaryEnrichPreview(null);
    setSalaryEnrichFile(null);
  };

  const handleSalaryHistoryFile = async (file: File) => {
    setShowImportModal(false);
    setSalaryHistoryLoading(true);
    try {
      const preview = await employeeService.salaryHistoryEnrichPreview(file);
      setSalaryHistoryPreview(preview);
      setSalaryHistoryFile(file);
    } catch { /* ignore */ }
    setSalaryHistoryLoading(false);
  };

  const handleSalaryHistoryApply = async (manualMatches: Array<{ fullName: string; employeeId: number }> = []) => {
    if (!salaryHistoryFile) return;
    setSalaryHistoryLoading(true);
    try {
      const r = await employeeService.salaryHistoryEnrichApply(salaryHistoryFile, manualMatches);
      alert(`Обновлено: ${r.updated} сотрудников`);
      refresh();
    } catch { /* ignore */ }
    setSalaryHistoryLoading(false);
    setSalaryHistoryPreview(null);
    setSalaryHistoryFile(null);
  };

  const handleContactsFile = async (file: File) => {
    setShowImportModal(false);
    setContactsLoading(true);
    try {
      const preview = await employeeService.contactsEnrichPreview(file);
      setContactsPreview(preview);
      setContactsFile(file);
    } catch { /* ignore */ }
    setContactsLoading(false);
  };

  const handleContactsApply = async (
    manualMatches: Array<{ fullName: string; employeeId: number }> = [],
    conflictResolutions?: Array<{ employeeId: number; overwrite: boolean }>,
  ) => {
    if (!contactsFile) return;
    setContactsLoading(true);
    try {
      const r = await employeeService.contactsEnrichApply(contactsFile, manualMatches, conflictResolutions);
      alert(`Обновлено: ${r.updated} сотрудников`);
      refresh();
    } catch { /* ignore */ }
    setContactsLoading(false);
    setContactsPreview(null);
    setContactsFile(null);
  };

  // Ключ идемпотентности создания: один на попытку, сбрасывается после успеха
  // и при закрытии формы — новый сотрудник получает новый ключ.
  const addOperationIdRef = useRef<string | null>(null);

  const resetAddForm = () => {
    setAddForm({
      full_name: '',
      hire_date: getLocalISODate(),
      org_department_id: '',
      position_id: '',
      tab_number: '',
    });
    setAddError(null);
    addOperationIdRef.current = null;
  };

  const closeAddModal = () => {
    if (addSaving) return;
    setShowAddModal(false);
    resetAddForm();
  };

  const handleAddEmployee = async () => {
    if (!addForm.full_name.trim() || !addForm.hire_date || !addForm.org_department_id || !addForm.position_id) {
      setAddError('Заполните обязательные поля');
      return;
    }
    setAddSaving(true);
    setAddError(null);
    // Ключ живёт до успеха: повтор после ошибки продолжает ту же операцию и не
    // создаёт второго сотрудника в Sigur.
    if (!addOperationIdRef.current) addOperationIdRef.current = crypto.randomUUID();
    try {
      await employeeService.create({
        full_name: addForm.full_name.trim(),
        hire_date: addForm.hire_date,
        org_department_id: addForm.org_department_id,
        position_id: addForm.position_id,
        tab_number: addForm.tab_number.trim() || null,
        operation_id: addOperationIdRef.current,
      });
      addOperationIdRef.current = null;
      setShowAddModal(false);
      resetAddForm();
      refresh();
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Ошибка создания сотрудника';
      setAddError(msg);
      toast.error(msg);
    } finally {
      setAddSaving(false);
    }
  };

  const handleSelectSigurDuplicate = async (suggestion: SigurEmployeeSummary) => {
    try {
      setLoadingSigurProfile(true);
      setAddError(null);
      const profile = await sigurAdminService.getEmployeeProfile(suggestion.id);
      setShowAddModal(false);
      resetAddForm();
      setSigurEditDialog({
        sigurEmployeeId: profile.sigurEmployeeId,
        name: profile.profile.fullName ?? suggestion.name,
        departmentId: profile.profile.departmentId != null ? String(profile.profile.departmentId) : '',
        positionId: profile.profile.positionId != null ? String(profile.profile.positionId) : '',
        tabId: profile.profile.tabNumber ?? '',
        description: profile.profile.description ?? '',
        blocked: profile.profile.blocked === true,
      });
      setSigurEditError(null);
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Не удалось загрузить профиль из Sigur';
      setAddError(msg);
      toast.error(msg);
    } finally {
      setLoadingSigurProfile(false);
    }
  };

  const closeSigurEditDialog = () => {
    if (sigurEditSaving) return;
    setSigurEditDialog(null);
    setSigurEditError(null);
  };

  const handleSaveSigurEdit = async () => {
    if (!sigurEditDialog) return;
    if (!sigurEditDialog.name.trim() || !sigurEditDialog.departmentId) {
      setSigurEditError('Заполните ФИО и отдел');
      return;
    }
    setSigurEditSaving(true);
    setSigurEditError(null);
    try {
      await sigurAdminService.updateEmployee(sigurEditDialog.sigurEmployeeId, {
        name: sigurEditDialog.name.trim(),
        departmentId: Number(sigurEditDialog.departmentId),
        positionId: sigurEditDialog.positionId ? Number(sigurEditDialog.positionId) : null,
        tabId: sigurEditDialog.tabId.trim() || null,
        description: sigurEditDialog.description.trim() || null,
        blocked: sigurEditDialog.blocked,
      });
      toast.success('Профиль в Sigur обновлён');
      setSigurEditDialog(null);
      refresh();
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Не удалось обновить профиль в Sigur';
      setSigurEditError(msg);
      toast.error(msg);
    } finally {
      setSigurEditSaving(false);
    }
  };

  const handleExportEmployees = useCallback(async () => {
    if (isExporting) return;
    setIsExporting(true);
    toast.info('Готовим файл со списком сотрудников…');
    try {
      const { blob, filename } = await employeeService.exportEmployees();
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Не удалось выгрузить сотрудников');
    } finally {
      setIsExporting(false);
    }
  }, [isExporting, toast]);

  // «Экспорт» — ровно текущая таблица: те же фильтры, вкладка, период и сортировка.
  const [isExportingView, setIsExportingView] = useState(false);
  const handleExportView = useCallback(async () => {
    if (isExportingView) return;
    setIsExportingView(true);
    try {
      const { blob, filename } = await employeeService.exportStaffView({
        search: debouncedSearch || undefined,
        departmentId: deptId || undefined,
        scheduleId: scheduleFilter || undefined,
        section,
        status: statusFilter,
        period: period ?? undefined,
        sort: sortKey,
        dir: sortDir,
        cf: columnFiltersKey || undefined,
      });
      triggerBlobDownload(blob, filename);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Не удалось выгрузить таблицу');
    } finally {
      setIsExportingView(false);
    }
  }, [isExportingView, debouncedSearch, deptId, scheduleFilter, section, statusFilter, period, sortKey, sortDir, columnFiltersKey, toast]);

  // Параметры экрана для вариантов значений в фильтре столбца (сервер не применяет фильтр самого столбца).
  const filterViewParams = useMemo(() => ({
    search: debouncedSearch || undefined,
    departmentId: deptId || undefined,
    scheduleId: scheduleFilter || undefined,
    section,
    status: statusFilter,
    period: period ?? undefined,
    cf: columnFiltersKey || undefined,
  }), [debouncedSearch, deptId, scheduleFilter, section, statusFilter, period, columnFiltersKey]);

  const overflowItems = useMemo<IOverflowMenuItem[]>(() => {
    const items: IOverflowMenuItem[] = [];
    if (canManageStaff && statusFilter === 'active') {
      items.push({
        label: selectionMode ? 'Выйти из режима выбора' : 'Выбрать нескольких',
        icon: <CheckSquare size={14} />,
        onClick: toggleSelectionMode,
      });
      items.push({
        label: 'Назначить график по бригадам…',
        icon: <Calendar size={14} />,
        onClick: () => setBulkBrigadeScheduleOpen(true),
        disabled: brigadeOptions.length === 0,
      });
      items.push({
        label: 'Назначить график по фильтру…',
        icon: <Calendar size={14} />,
        onClick: () => setBulkFilterScheduleOpen(true),
        disabled: total === 0,
      });
      items.push({
        label: 'Импорт…',
        icon: <Upload size={14} />,
        onClick: () => setShowImportModal(true),
        divideBefore: true,
      });
    }
    // Рядом с «Импорт…» — парное действие. Когда импорт скрыт (статус не
    // «Активные»), экспорт сам открывает группу разделителем.
    if (canExportEmployees) {
      items.push({
        label: 'Экспорт сотрудников…',
        icon: <Download size={14} />,
        onClick: () => { void handleExportEmployees(); },
        disabled: isExporting,
        divideBefore: !(canManageStaff && statusFilter === 'active'),
      });
    }
    if (canEditTimesheetMode) {
      items.push({
        label: 'Режим табелирования…',
        icon: <CalendarCog size={14} />,
        onClick: () => setBulkTsModeOpen(true),
        divideBefore: true,
      });
    }
    return items;
  }, [canManageStaff, statusFilter, selectionMode, toggleSelectionMode, brigadeOptions.length, total, canEditTimesheetMode, canExportEmployees, isExporting, handleExportEmployees]);

  const headerCounter = useMemo(() => (
    <span className="sc-page-counter sc-page-counter--in-header">
      {total}{statusFilter === 'active' ? ` из ${totalActive}` : ''}
    </span>
  ), [total, statusFilter, totalActive]);
  useHeaderAddon(headerCounter);

  const controlsBar = (
    <div className="sc-filters">
      <StaffSectionSelect value={section} onChange={handleSectionChange} />
      {isSingleManagedDept ? (
        <div className="sc-dept-fixed" title="Вам назначен один отдел">
          {singleManagedDeptName ?? 'Мой отдел'}
        </div>
      ) : (
        <div className="sc-filter-dept-slot">
          <DepartmentTreeSelect
            departments={filterDeptTree}
            value={deptId}
            onChange={handleDeptChange}
            flattenSingleRoot={section !== 'all'}
            isLoading={structureTree.isPending || (headerDeptPending && sectionDepartmentsQuery.isPending)}
            isError={structureTree.isError || (headerDeptPending && sectionDepartmentsQuery.isError)}
            onRetry={() => {
              void structureTree.refetch();
              if (sectionDepartmentsQuery.isError) void sectionDepartmentsQuery.refetch();
            }}
          />
        </div>
      )}
      <select
        className="sc-schedule-filter"
        value={scheduleFilter}
        onChange={e => handleScheduleFilterChange(e.target.value)}
        title="Фильтр по графику работы"
      >
        <option value="">Все графики</option>
        {scheduleTemplates.map(tpl => (
          <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
        ))}
      </select>
      {canManageStaff && (
        <div className="sc-segmented" role="tablist" aria-label="Статус сотрудников">
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'active'}
            className={`sc-seg-btn${statusFilter === 'active' ? ' is-active' : ''}`}
            onClick={() => handleStatusChange('active')}
          >
            Действующие
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'fired'}
            className={`sc-seg-btn${statusFilter === 'fired' ? ' is-active' : ''}`}
            onClick={() => handleStatusChange('fired')}
          >
            Уволенные
          </button>
        </div>
      )}
      {isMobile && (
        <select
          className="sc-schedule-filter sc-sort-select"
          value={`${sortKey}:${sortDir}`}
          onChange={e => {
            const [key, dir] = e.target.value.split(':');
            if (isStaffSortKey(key)) {
              setSortKey(key);
              setSortDir(dir === 'desc' ? 'desc' : 'asc');
            }
          }}
          aria-label="Сортировка"
        >
          {STAFF_SORT_OPTIONS.flatMap(option => [
            <option key={`${option.key}:asc`} value={`${option.key}:asc`}>{option.label} ↑</option>,
            <option key={`${option.key}:desc`} value={`${option.key}:desc`}>{option.label} ↓</option>,
          ])}
        </select>
      )}
      {(canManageStaff || canExportEmployees || overflowItems.length > 0) && (
        <div className="sc-page-actions">
          {canExportEmployees && (
            <button
              type="button"
              className="sc-btn secondary sc-export-view-btn"
              onClick={() => { void handleExportView(); }}
              disabled={isExportingView || total === 0}
              title="Скачать xlsx с текущей таблицей: фильтры, вкладка и сортировка"
              aria-label="Экспорт текущей таблицы"
            >
              <Download size={isMobile ? 20 : 14} aria-hidden="true" />
              {!isMobile && <span>{isExportingView ? 'Готовим…' : 'Экспорт'}</span>}
            </button>
          )}
          {canManageStaff && statusFilter === 'active' && !hrTabAvailable && (
            <button
              className="sc-btn apply"
              onClick={() => setShowAddModal(true)}
              title="Добавить сотрудника"
              aria-label="Добавить сотрудника"
            >
              <UserPlus size={isMobile ? 20 : 14} />
              {!isMobile && <span>Добавить</span>}
            </button>
          )}
          {overflowItems.length > 0 && <OverflowMenu items={overflowItems} />}
        </div>
      )}
      <div className="sc-filter-search">
        <SearchInput value={search} onValueChange={handleSearchChange} placeholder="Поиск по ФИО..." />
      </div>
      {/* Вторая строка панели: «С 1 сентября 2026: Устроены +N · Уволены −N», фильтры столбцов. */}
      {(canManageStaff || isMobile || activeColumnFilterCount > 0) && (
        <div className="sc-movement-row">
          {canManageStaff && (
            <StaffMonthMovement
              data={monthMovement.data}
              isError={monthMovement.isError}
              period={period}
              onToggle={handlePeriodToggle}
            />
          )}
          {isMobile && (
            <button
              type="button"
              className={`sc-btn secondary sc-mobile-filters-btn${activeColumnFilterCount > 0 ? ' is-active' : ''}`}
              onClick={() => setMobileFiltersOpen(true)}
            >
              <Filter size={14} aria-hidden="true" />
              <span>Фильтры{activeColumnFilterCount > 0 ? ` (${activeColumnFilterCount})` : ''}</span>
            </button>
          )}
          {activeColumnFilterCount > 0 && (
            <button type="button" className="sc-colfilter-reset" onClick={resetColumnFilters}>
              <X size={12} aria-hidden="true" />
              Сбросить фильтры столбцов ({activeColumnFilterCount})
            </button>
          )}
        </div>
      )}
    </div>
  );

  /* ─── render ─── */

  return (
    <div className="sc-page">
      {controlsBar}

      {selectionMode && (
        <div className="sc-bulk-bar">
          <div className="sc-bulk-info">
            {selectedEmployeeIds.length > 0 ? (
              <>Выбрано сотрудников: <strong>{selectedEmployeeIds.length}</strong></>
            ) : (
              <>Отметьте сотрудников галочкой</>
            )}
          </div>
          <div className="sc-bulk-actions">
            {canEditSch && (
              <button
                className="sc-btn secondary"
                onClick={() => setBulkScheduleOpen(true)}
                disabled={selectedEmployeeIds.length === 0}
              >
                <Calendar size={14} /> График
              </button>
            )}
            {canEditDept && (
              <button
                className="sc-btn secondary"
                onClick={() => setBulkMoveDeptOpen(true)}
                disabled={selectedEmployeeIds.length === 0}
              >
                <ArrowRightLeft size={14} /> Сменить отдел
              </button>
            )}
            <button className="sc-btn cancel" onClick={toggleSelectionMode}>
              Готово
            </button>
          </div>
        </div>
      )}

      {isFirstPageError ? (
        <div className="sc-loading sc-loading--error">
          <span>Не удалось загрузить сотрудников</span>
          <button className="sc-btn cancel" onClick={() => { void retryFirstPage(); }}>Повторить</button>
        </div>
      ) : loading ? (
        <div className="sc-loading">Загрузка...</div>
      ) : isMobile ? (
        <VirtualCards
          filtered={employees}
          sideData={sideData}
          selectedIds={selectedEmployeeIdSet}
          selectionMode={selectionMode}
          canManage={canManageStaff}
          canEditDept={canEditDept}
          canEditPos={canEditPos}
          canEditSch={canEditSch}
          canOpenCard={canOpenCard}
          onLoadMore={loadMore}
          resetKey={listResetKey}
          onNavigate={handleNavigate}
          onToggleSelect={toggleSelectEmployee}
          onOpenModal={openModal}
          onOpenHistory={openHistory}
          onRehire={statusFilter === 'fired' && canManageStaff ? handleRehire : undefined}
          onFire={statusFilter === 'active' && canManageStaff ? handleFire : undefined}
          onCancelDismissal={statusFilter === 'active' && canManageStaff ? handleCancelDismissal : undefined}
          onReturn={statusFilter === 'active' ? handleReturnToTimesheet : undefined}
          onEditComment={commentEditHandler}
        />
      ) : (
        <VirtualTable
          filtered={employees}
          sideData={sideData}
          selectedIds={selectedEmployeeIdSet}
          selectionMode={selectionMode}
          canManage={canManageStaff}
          canEditDept={canEditDept}
          canEditPos={canEditPos}
          canEditSch={canEditSch}
          canOpenCard={canOpenCard}
          onLoadMore={loadMore}
          resetKey={listResetKey}
          mainObjectTitle={mainObjectTitle}
          onNavigate={handleNavigate}
          onToggleSelect={toggleSelectEmployee}
          onToggleSelectAll={toggleSelectAllVisible}
          allSelected={allVisibleSelected}
          onOpenModal={openModal}
          onOpenHistory={openHistory}
          onRehire={statusFilter === 'fired' && canManageStaff ? handleRehire : undefined}
          onFire={statusFilter === 'active' && canManageStaff ? handleFire : undefined}
          onCancelDismissal={statusFilter === 'active' && canManageStaff ? handleCancelDismissal : undefined}
          onReturn={statusFilter === 'active' ? handleReturnToTimesheet : undefined}
          onEditComment={commentEditHandler}
          sort={sortKey}
          dir={sortDir}
          onSort={handleSort}
          columnFilters={columnFilters}
          onOpenFilter={handleOpenFilter}
        />
      )}

      {/* Состояние подгрузки — вне прокручиваемой области и постоянной высоты:
          появление «Загрузка ещё…» у нижней границы не меняет высоту списка. */}
      {!loading && !isFirstPageError && total > 0 && (
        <div className="sc-list-footer" aria-live="polite">
          {isFetchNextPageError ? (
            <>
              <span className="sc-list-footer-info">Не удалось загрузить следующих сотрудников</span>
              <button className="sc-btn cancel" onClick={retryNextPage}>Повторить</button>
            </>
          ) : sideDataHasError ? (
            <>
              <span className="sc-list-footer-info">Не удалось загрузить часть данных</span>
              <button className="sc-btn cancel" onClick={retrySideData}>Повторить</button>
            </>
          ) : (
            <span className="sc-list-footer-info">
              {isFetchingNextPage || hasNextPage
                ? `Загружено ${employees.length} из ${total}${isFetchingNextPage ? ' — загрузка…' : ''}`
                : `Показано ${employees.length} из ${total}`}
            </span>
          )}
        </div>
      )}

      {/* History Side Panel */}
      {panelEmp && (
        <Suspense fallback={null}>
          <HistoryPanel
            employee={panelEmp}
            history={panelHistory}
            loading={panelLoading}
            canEdit={isAdmin}
            onClose={closeHistory}
            onRefresh={() => openHistory(panelEmp)}
            onDataChanged={handleHistoryDataChanged}
          />
        </Suspense>
      )}

      {/* Modals — isolated from table */}
      <StaffModals
        key={`${modalType ?? 'none'}-${modalEmp?.id ?? 'none'}`}
        modalType={modalType}
        modalEmp={modalEmp}
        deptTree={scopeDeptTree}
        templates={scheduleTemplates}
        scheduleViews={scheduleViews}
        baseScheduleViews={baseScheduleViews}
        onClose={closeModal}
        onSavePosition={handleSavePosition}
        onSaveDepartment={handleSaveDepartment}
        onSaveSchedule={handleSaveSchedule}
        onFixAssignment={handleFixAssignment}
        onDeleteAssignmentRow={handleDeleteAssignmentRow}
      />

      {bulkTsModeOpen && (
        <Suspense fallback={null}>
          <StaffTimesheetModeModal
            departments={allDepts}
            deptTree={scopeDeptTree}
            initialDepartmentId={deptId || ''}
            onClose={() => {
              setBulkTsModeOpen(false);
              // Порции объектов несут и режим табелирования — после правок в окне перечитываем сразу.
              void queryClient.invalidateQueries({ queryKey: [STAFF_MAIN_OBJECTS_QUERY_KEY] });
            }}
          />
        </Suspense>
      )}
      {commentEmp && (
        <Suspense fallback={null}>
          <StaffCommentModal employee={commentEmp} onClose={closeCommentModal} onSaved={handleCommentSaved} />
        </Suspense>
      )}
      {mobileFiltersOpen && !openFilter && (
        <StaffColumnFilterSheet
          filters={columnFilters}
          onPick={column => handleOpenFilter(column, null)}
          onReset={resetColumnFilters}
          onClose={() => setMobileFiltersOpen(false)}
        />
      )}
      {openFilter && (
        <StaffColumnFilterPopover
          key={openFilter.column}
          column={openFilter.column}
          label={STAFF_SORT_OPTIONS.find(option => option.key === openFilter.column)?.label ?? ''}
          filters={columnFilters}
          viewParams={filterViewParams}
          anchor={openFilter.anchor}
          onApply={handleApplyColumnFilter}
          onClose={closeFilter}
        />
      )}
      <BulkScheduleModal
        open={bulkScheduleOpen}
        targetCount={selectedEmployees.length}
        targetLabel="Выбрано сотрудников"
        previewText={selectedEmployeesPreview}
        templates={scheduleTemplates}
        onClose={() => setBulkScheduleOpen(false)}
        onApply={handleBulkSaveSchedule}
      />
      <BulkScheduleModal
        open={bulkFilterScheduleOpen}
        targetCount={total}
        targetLabel="Сотрудников по фильтру"
        previewText={currentFilterDescription}
        templates={scheduleTemplates}
        onClose={() => setBulkFilterScheduleOpen(false)}
        onApply={handleFilteredBulkSaveSchedule}
      />
      <BulkBrigadeScheduleModal
        open={bulkBrigadeScheduleOpen}
        brigades={brigadeOptions}
        templates={scheduleTemplates}
        onClose={() => setBulkBrigadeScheduleOpen(false)}
        onApply={handleBrigadeBulkSaveSchedule}
      />
      <BulkMoveDepartmentModal
        open={bulkMoveDeptOpen}
        targetCount={selectedEmployees.length}
        previewText={selectedEmployeesPreview}
        departments={allDepts}
        archiveDepartmentId={archiveDepartmentId}
        onClose={() => setBulkMoveDeptOpen(false)}
        onApply={handleBulkMoveDepartment}
      />
      {/* ─── Import Modal ─── */}
      {showImportModal && (
        <Suspense fallback={null}>
          <ImportModal
            onClose={() => setShowImportModal(false)}
            onEnrichFile={handleEnrichFile}
            // Импорт окладов — только с правом на раздел «Зарплата»: сервер без него вернёт 403.
            onSalaryFile={canEditPage('/salary/terms') ? handleSalaryFile : undefined}
            onSalaryHistoryFile={canEditPage('/salary/terms') ? handleSalaryHistoryFile : undefined}
            onContactsFile={handleContactsFile}
          />
        </Suspense>
      )}

      {enrichPreview && (
        <Suspense fallback={null}>
          <EnrichPreviewModal preview={enrichPreview} loading={enrichLoading} onApply={handleEnrichApply} onClose={() => { setEnrichPreview(null); setEnrichFile(null); }} title="Импорт документов — Превью" />
        </Suspense>
      )}
      {salaryEnrichPreview && (
        <Suspense fallback={null}>
          <EnrichPreviewModal preview={salaryEnrichPreview} loading={salaryEnrichLoading} onApply={handleSalaryApply} onClose={() => { setSalaryEnrichPreview(null); setSalaryEnrichFile(null); }} title="Импорт окладов — Превью" />
        </Suspense>
      )}
      {salaryHistoryPreview && (
        <Suspense fallback={null}>
          <EnrichPreviewModal preview={salaryHistoryPreview} loading={salaryHistoryLoading} onApply={handleSalaryHistoryApply} onClose={() => { setSalaryHistoryPreview(null); setSalaryHistoryFile(null); }} title="Импорт истории окладов — Превью" />
        </Suspense>
      )}
      {contactsPreview && (
        <Suspense fallback={null}>
          <EnrichPreviewModal preview={contactsPreview} conflicts={contactsPreview.conflicts} loading={contactsLoading} onApply={handleContactsApply} onClose={() => { setContactsPreview(null); setContactsFile(null); }} title="Импорт email — Превью" />
        </Suspense>
      )}

      {/* ─── Add Employee Modal (без кадрового модуля) ─── */}
      {showAddModal && (
        <div className="sc-overlay" onClick={closeAddModal}>
          <div className="sc-modal" onClick={e => e.stopPropagation()}>
            <div className="sc-modal-header">
              <h3>Добавить сотрудника в Sigur</h3>
              <button className="sc-modal-close" onClick={closeAddModal} disabled={addSaving}>&times;</button>
            </div>
            <div className="sc-modal-body">
              <div className="sc-field">
                <label>ФИО *</label>
                <input
                  value={addForm.full_name}
                  onChange={e => setAddForm({ ...addForm, full_name: e.target.value })}
                  placeholder="Иванов Иван Иванович"
                  autoFocus
                  disabled={addSaving || loadingSigurProfile}
                />
                {sigurDuplicatesEnabled && (sigurDuplicatesResult.isFetching || sigurDuplicates.length > 0) && (
                  <div className="sc-sigur-suggestions">
                    <div className="sc-sigur-suggestions-hint">
                      {sigurDuplicatesResult.isFetching
                        ? 'Поиск в Sigur...'
                        : `Найдены похожие в Sigur (${sigurDuplicates.length}). Кликните, чтобы редактировать.`}
                    </div>
                    {sigurDuplicates.map(suggestion => (
                      <button
                        key={suggestion.id}
                        type="button"
                        className="sc-sigur-suggestion-row"
                        onClick={() => void handleSelectSigurDuplicate(suggestion)}
                        disabled={loadingSigurProfile || addSaving}
                      >
                        <span className="sc-sigur-suggestion-name">{suggestion.name}</span>
                        <span className="sc-sigur-suggestion-meta">
                          {[suggestion.departmentName, suggestion.positionName, suggestion.tabId ? `Таб. ${suggestion.tabId}` : null]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="sc-field">
                <label>Дата найма *</label>
                <input
                  type="date"
                  value={addForm.hire_date}
                  onChange={e => setAddForm({ ...addForm, hire_date: e.target.value })}
                  disabled={addSaving}
                />
              </div>
              <div className="sc-field">
                <label>Отдел *</label>
                <select
                  value={addForm.org_department_id}
                  onChange={e => setAddForm({ ...addForm, org_department_id: e.target.value })}
                  disabled={addSaving}
                >
                  <option value="">— Выберите отдел —</option>
                  {allDepts.map(dept => (
                    <option key={dept.id} value={dept.id}>
                      {'  '.repeat(dept.level)}{dept.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sc-field">
                <label>Должность *</label>
                <select
                  value={addForm.position_id}
                  onChange={e => setAddForm({ ...addForm, position_id: e.target.value })}
                  disabled={addSaving || positionsQuery.isLoading}
                >
                  <option value="">
                    {positionsQuery.isLoading ? 'Загрузка...' : '— Выберите должность —'}
                  </option>
                  {(positionsQuery.data || []).map(pos => (
                    <option key={pos.id} value={pos.id}>{pos.name}</option>
                  ))}
                </select>
              </div>
              <div className="sc-field">
                <label>Табельный номер</label>
                <input
                  value={addForm.tab_number}
                  onChange={e => setAddForm({ ...addForm, tab_number: e.target.value })}
                  placeholder="(опционально)"
                  disabled={addSaving}
                />
              </div>
              {addError && <div className="sc-error" style={{ color: '#dc2626', fontSize: 13 }}>{addError}</div>}
            </div>
            <div className="sc-modal-footer">
              <button className="sc-btn cancel" onClick={closeAddModal} disabled={addSaving}>Отмена</button>
              <button
                className="sc-btn apply"
                onClick={handleAddEmployee}
                disabled={addSaving || !addForm.full_name.trim() || !addForm.hire_date || !addForm.org_department_id || !addForm.position_id}
              >
                {addSaving ? 'Создаём в Sigur...' : 'Добавить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Sigur Edit Modal (открывается при клике на дубликат) ─── */}
      {sigurEditDialog && (
        <div className="sc-overlay" onClick={closeSigurEditDialog}>
          <div className="sc-modal" onClick={e => e.stopPropagation()}>
            <div className="sc-modal-header">
              <h3>Редактирование сотрудника Sigur</h3>
              <button className="sc-modal-close" onClick={closeSigurEditDialog} disabled={sigurEditSaving}>&times;</button>
            </div>
            <div className="sc-modal-body">
              <div className="sc-field">
                <label>ФИО *</label>
                <input
                  value={sigurEditDialog.name}
                  onChange={e => setSigurEditDialog(prev => prev ? { ...prev, name: e.target.value } : prev)}
                  disabled={sigurEditSaving}
                />
              </div>
              <div className="sc-field">
                <label>Отдел Sigur *</label>
                <select
                  value={sigurEditDialog.departmentId}
                  onChange={e => setSigurEditDialog(prev => prev ? { ...prev, departmentId: e.target.value } : prev)}
                  disabled={sigurEditSaving || sigurDeptsQuery.isLoading}
                >
                  <option value="">
                    {sigurDeptsQuery.isLoading ? 'Загрузка...' : '— Выберите отдел —'}
                  </option>
                  {sigurDeptOptions.map(option => (
                    <option key={option.id} value={option.id}>
                      {'  '.repeat(option.level)}{option.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sc-field">
                <label>Должность Sigur</label>
                <select
                  value={sigurEditDialog.positionId}
                  onChange={e => setSigurEditDialog(prev => prev ? { ...prev, positionId: e.target.value } : prev)}
                  disabled={sigurEditSaving || sigurPositionsQuery.isLoading}
                >
                  <option value="">
                    {sigurPositionsQuery.isLoading ? 'Загрузка...' : '— Не указана —'}
                  </option>
                  {(sigurPositionsQuery.data || []).map(pos => (
                    <option key={pos.id} value={pos.id}>{pos.name}</option>
                  ))}
                </select>
              </div>
              <div className="sc-field">
                <label>Табельный номер</label>
                <input
                  value={sigurEditDialog.tabId}
                  onChange={e => setSigurEditDialog(prev => prev ? { ...prev, tabId: e.target.value } : prev)}
                  placeholder="(опционально)"
                  disabled={sigurEditSaving}
                />
              </div>
              <div className="sc-field">
                <label>Описание</label>
                <textarea
                  value={sigurEditDialog.description}
                  onChange={e => setSigurEditDialog(prev => prev ? { ...prev, description: e.target.value } : prev)}
                  rows={3}
                  disabled={sigurEditSaving}
                />
              </div>
              <div className="sc-field sc-checkbox-row">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={sigurEditDialog.blocked}
                    onChange={e => setSigurEditDialog(prev => prev ? { ...prev, blocked: e.target.checked } : prev)}
                    disabled={sigurEditSaving}
                  />
                  <span>Заблокирован в Sigur</span>
                </label>
              </div>
              {sigurEditError && <div className="sc-error" style={{ color: '#dc2626', fontSize: 13 }}>{sigurEditError}</div>}
            </div>
            <div className="sc-modal-footer">
              <button className="sc-btn cancel" onClick={closeSigurEditDialog} disabled={sigurEditSaving}>Отмена</button>
              <button
                className="sc-btn apply"
                onClick={() => void handleSaveSigurEdit()}
                disabled={sigurEditSaving || !sigurEditDialog.name.trim() || !sigurEditDialog.departmentId}
              >
                {sigurEditSaving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Fire Modal ─── */}
      {fireEmp && (
        <FireEmployeeModal
          emp={fireEmp}
          date={fireDate}
          onChangeDate={setFireDate}
          inFlight={fireInFlight}
          onCancel={closeFireModal}
          onConfirm={handleConfirmFire}
        />
      )}

      {/* ─── Rehire Modal ─── */}
      {rehireEmp && (
        <div className="sc-overlay" {...rehireOverlayHandlers}>
          <div className="sc-modal" onClick={e => e.stopPropagation()}>
            <div className="sc-modal-header">
              <h3><ShieldCheck size={16} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Восстановить сотрудника</h3>
              <button className="sc-modal-close" onClick={closeRehireModal} disabled={rehireInFlight}>&times;</button>
            </div>
            <div className="sc-modal-body">
              <div className="sc-field">
                <label>Отдел для {rehireEmp.full_name}</label>
                <select
                  value={rehireDeptId}
                  onChange={e => setRehireDeptId(e.target.value)}
                  disabled={rehireInFlight}
                >
                  <option value="">— Выберите отдел —</option>
                  {allDepts
                    .filter(department => department.id !== archiveDepartmentId)
                    .map(department => (
                      <option key={department.id} value={department.id}>
                        {'  '.repeat(department.level)}{department.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="sc-field">
                <label htmlFor="sc-rehire-date">Дата восстановления (первый рабочий день)</label>
                <input
                  id="sc-rehire-date"
                  type="date"
                  className="sc-rehire-date"
                  value={rehireDate}
                  min={rehireEmp.dismissal_date ? addIsoDays(rehireEmp.dismissal_date, 1) : undefined}
                  max={getMoscowISODate()}
                  onChange={e => setRehireDate(e.target.value)}
                  disabled={rehireInFlight}
                />
                {rehireEmp.dismissal_date && (
                  <div className="sc-rehire-hint">
                    Уволен: {formatDate(rehireEmp.dismissal_date)}
                    <button
                      type="button"
                      className="sc-rehire-link"
                      onClick={() => setRehireDate(addIsoDays(rehireEmp.dismissal_date as string, 1))}
                      disabled={rehireInFlight}
                    >
                      Со дня после увольнения
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="sc-modal-footer">
              <button className="sc-btn cancel" onClick={closeRehireModal} disabled={rehireInFlight}>Отмена</button>
              <button
                className="sc-btn apply"
                onClick={handleConfirmRehire}
                disabled={!rehireDeptId || !rehireDate || rehireInFlight}
              >
                {rehireInFlight ? 'Восстанавливаем...' : 'Восстановить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
