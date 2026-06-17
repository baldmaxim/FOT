import { type FC, useState, useMemo, useEffect, useCallback, lazy, Suspense } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, RotateCcw, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Clock, FileText, Download, Settings, Eye } from 'lucide-react';
import type { TimesheetEntry, TimesheetEmployee } from '../../types';
import {
  timesheetApprovalService,
  APPROVAL_STATUS_LABELS,
  type TimesheetApprovalStatus,
  type IApprovalReviewItem,
  type IApprovalAttachment,
} from '../../services/timesheetApprovalService';
import { ApprovalAttachmentsModal } from '../../components/timesheet/ApprovalAttachmentsModal';
import {
  correctionApprovalService,
  type ICorrectionDepartmentGroup,
  type IBulkResult,
} from '../../services/correctionApprovalService';
import { timesheetService } from '../../services/timesheetService';
import { correctionAttachmentsService } from '../../services/correctionAttachmentsService';
import { documentService } from '../../services/documentService';
import { TimesheetGrid } from '../../components/timesheet/TimesheetGrid';
import { DepartmentTimesheetModal } from '../../components/timesheet/DepartmentTimesheetModal';
import { ApprovalCommentModal } from './ApprovalCommentModal';
import { CorrectionApprovalSettingsModal } from './CorrectionApprovalSettingsModal';
import { CorrectionGroupsList } from './CorrectionGroupsList';
import { WeekendApprovalsPreviewModal } from './WeekendApprovalsPreviewModal';
import { WEEKDAY_SHORT_RU, removeItemsByIds } from './approvalsShared';
const TimesheetCorrectionModal = lazy(() => import('../../components/timesheet/TimesheetCorrectionModal').then(module => ({
  default: module.TimesheetCorrectionModal,
})));
import { DepartmentTreeSelect } from '../../components/staff/DepartmentTreeSelect';
import { useStructureTree } from '../../hooks/useStructure';
import { collectDescendantIds } from '../../utils/departmentUtils';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
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

const formatDate = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const formatDateWithWeekday = (iso: string): string => {
  const d = new Date(iso + 'T00:00:00');
  return `${formatDate(iso)} (${WEEKDAY_SHORT_RU[d.getDay()]})`;
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
  const isMobile = useIsMobile(768);

  const [view, setView] = useState<'pending' | 'history'>('pending');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [tsModal, setTsModal] = useState<{
    departmentId?: string;
    employeeIds?: number[];
    departmentName: string;
    month: string;
  } | null>(null);
  const [deptId, setDeptId] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const debouncedName = useDebouncedValue(nameQuery, 200);

  const structureTree = useStructureTree();
  const departments = useMemo(() => structureTree.data?.departments ?? [], [structureTree.data]);
  const allowedDeptIds = useMemo(
    () => (deptId ? collectDescendantIds(departments, new Set([deptId])) : null),
    [deptId, departments],
  );

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

  const optimisticallyRemove = (ids: number[]) => {
    queryClient.setQueryData<ICorrectionDepartmentGroup[]>(
      ['correction-approvals', view, period.startDate, period.endDate],
      (old) => removeItemsByIds(old, ids),
    );
  };

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
      optimisticallyRemove(variables);
      await invalidate();
      toast.success?.(formatBulkToast('Утверждено', data));
      clearProcessedIds(variables);
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка массового согласования'),
  });

  const bulkRejectSelectedMutation = useMutation({
    mutationFn: (ids: number[]) => correctionApprovalService.bulkRejectByIds(ids),
    onSuccess: async (data, variables) => {
      optimisticallyRemove(variables);
      await invalidate();
      toast.success?.(formatBulkToast('Отклонено', data));
      clearProcessedIds(variables);
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка массового отклонения'),
  });

  const bulkRevertSelectedMutation = useMutation({
    mutationFn: (ids: number[]) => correctionApprovalService.bulkRevertByIds(ids),
    onSuccess: async (data, variables) => {
      optimisticallyRemove(variables);
      await invalidate();
      toast.success?.(formatBulkToast('Возвращено', data));
      clearProcessedIds(variables);
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка массового отката'),
  });

  const allGroups: ICorrectionDepartmentGroup[] = useMemo(() => query.data ?? [], [query.data]);
  const groups: ICorrectionDepartmentGroup[] = useMemo(() => {
    let gs = allowedDeptIds ? allGroups.filter(g => allowedDeptIds.has(g.department_id)) : allGroups;
    const q = debouncedName.trim().toLowerCase();
    if (q) {
      gs = gs
        .map(g => ({ ...g, items: g.items.filter(it => (it.employee_name ?? '').toLowerCase().includes(q)) }))
        .filter(g => g.items.length > 0);
    }
    return gs;
  }, [allGroups, allowedDeptIds, debouncedName]);

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

  // Табель отдела за месяц первой (самой ранней) запрошенной даты выхода.
  // is_direct_reports-группа имеет синтетический department_id → грузим по составу.
  const openTimesheet = (group: ICorrectionDepartmentGroup) => {
    const month = (group.items.map(i => i.work_date).filter(Boolean).sort()[0]
      ?? period.startDate).slice(0, 7);
    setTsModal({
      departmentName: group.department_name,
      departmentId: group.is_direct_reports ? undefined : group.department_id,
      employeeIds: group.is_direct_reports
        ? [...new Set(group.items.map(i => i.employee_id))]
        : undefined,
      month,
    });
  };

  const allItemIds = useMemo(() => {
    const ids: number[] = [];
    for (const g of groups) for (const it of g.items) ids.push(it.id);
    return ids;
  }, [groups]);

  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(allItemIds) : new Set());
  };

  const toggleExpand = (departmentId: string) => {
    setExpanded(s => ({ ...s, [departmentId]: !s[departmentId] }));
  };

  const bulkPending = bulkApproveSelectedMutation.isPending
    || bulkRejectSelectedMutation.isPending
    || bulkRevertSelectedMutation.isPending;
  const isHistory = view === 'history';
  const canSelect = canReview;

  return (
    <>
      <div className="approvals-toolbar cor-toolbar">
        <div className="cor-toolbar-top">
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
          {canReview && (
            <button
              type="button"
              className="cor-settings-btn"
              onClick={() => setShowSettings(true)}
              title="Настройка согласования по отделам"
              aria-label="Настройка согласования по отделам"
            >
              <Settings size={16} />
            </button>
          )}
        </div>

        <div className="cor-filters">
          <div className="cor-filter-dept">
            <DepartmentTreeSelect
              departments={departments}
              value={deptId}
              onChange={setDeptId}
              isLoading={structureTree.isPending}
              isError={structureTree.isError}
              onRetry={() => { void structureTree.refetch(); }}
            />
          </div>
          <input
            type="search"
            className="cor-filter-name"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder="Поиск по ФИО…"
            aria-label="Поиск по ФИО"
          />
        </div>

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
        <CorrectionGroupsList
          groups={groups}
          isHistory={isHistory}
          isMobile={isMobile}
          canSelect={canSelect}
          selectedIds={selectedIds}
          onToggleId={toggleId}
          onToggleGroup={toggleGroup}
          onToggleAll={toggleAll}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          expandedNotes={expandedNotes}
          onToggleNotes={toggleNotes}
          onOpenTimesheet={openTimesheet}
          onBulkApprove={(ids) => bulkApproveSelectedMutation.mutate(ids)}
          onBulkReject={(ids) => bulkRejectSelectedMutation.mutate(ids)}
          onBulkRevert={(ids) => bulkRevertSelectedMutation.mutate(ids)}
          bulkPending={bulkPending}
        />
      )}

      {showSettings && (
        <CorrectionApprovalSettingsModal onClose={() => setShowSettings(false)} />
      )}

      {tsModal && (
        <DepartmentTimesheetModal {...tsModal} onClose={() => setTsModal(null)} />
      )}
    </>
  );
};

const sanitizeFilePart = (value: string): string => value.replace(/[\\/:*?"<>|]+/g, '_');

interface IApprovalCardExtrasProps {
  row: IApprovalReviewItem;
  employees: TimesheetEmployee[];
}

const ApprovalCardExtras: FC<IApprovalCardExtrasProps> = ({ row, employees }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isAdmin, profile } = useAuth();
  const [attModalOpen, setAttModalOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [exporting, setExporting] = useState<'fact' | '1c' | 'employee' | 'employee_1c' | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | ''>('');

  // Удалять файлы вправе админы и начальники отделов/участков (бэк дополнительно проверяет доступ и статус).
  const canManageAttachments =
    isAdmin || (profile?.managed_department_ids?.length ?? 0) > 0 || profile?.has_direct_reports === true;

  const monthStr = useMemo(() => {
    const d = new Date(row.start_date + 'T00:00:00');
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, [row.start_date]);
  const isPersonal = row.manager_employee_id != null;
  const deptLabel = sanitizeFilePart(
    isPersonal
      ? (row.manager_employee_name ?? `employee_${row.manager_employee_id ?? 'unknown'}`)
      : (row.department_name ?? row.department_id ?? 'department')
  );

  const attachmentsQuery = useQuery({
    queryKey: ['approval-attachments', row.id],
    queryFn: () => timesheetApprovalService.listAttachments({ approval_id: row.id }),
    staleTime: 30_000,
  });
  const attachments = useMemo(() => attachmentsQuery.data ?? [], [attachmentsQuery.data]);

  const loadAttachmentUrl = useCallback(
    async (att: IApprovalAttachment, disposition: 'inline' | 'attachment' = 'attachment'): Promise<string> => {
      // Агрегатор отдаёт подписанные URL сразу — у файлов корректировок свой авторизационный
      // путь, и getAttachmentDownloadUrl на них вернёт 404. Fallback на эндпоинт — только если
      // прямого URL нет (напр. R2 выключен или legacy-ответ без URL).
      const direct = disposition === 'inline' ? att.preview_url : att.download_url;
      if (direct) return direct;
      const { download_url } = await timesheetApprovalService.getAttachmentDownloadUrl(att.document_id, disposition);
      return download_url;
    },
    [],
  );

  const handleDeleteAttachment = useCallback(
    async (documentId: number) => {
      const att = attachments.find(a => a.document_id === documentId);
      if (!att) return;
      if (!window.confirm(`Удалить файл «${att.file_name}»?`)) return;
      setDeletingId(documentId);
      try {
        if (att.kind === 'weekend_memo') {
          await timesheetApprovalService.deleteAttachment(documentId);
        } else if (att.kind === 'correction') {
          if (att.adjustment_id == null) throw new Error('Не удалось определить корректировку файла');
          await correctionAttachmentsService.remove(att.adjustment_id, documentId);
        } else {
          await documentService.remove(documentId);
        }
        await queryClient.invalidateQueries({ queryKey: ['approval-attachments', row.id] });
        toast.success?.('Файл удалён');
      } catch (err) {
        toast.error?.(err instanceof Error ? err.message : 'Не удалось удалить файл');
      } finally {
        setDeletingId(null);
      }
    },
    [attachments, queryClient, row.id, toast],
  );

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportFact = async () => {
    if (!row.department_id) return;
    setExporting('fact');
    try {
      const blob = await timesheetService.export({
        month: monthStr,
        department_id: row.department_id,
        from: row.start_date,
        to: row.end_date,
        presentation: 'hr',
      });
      downloadBlob(blob, `Факт_${deptLabel}_${row.start_date}_${row.end_date}.xlsx`);
    } catch (err) {
      toast.error?.(err instanceof Error ? err.message : 'Ошибка выгрузки факта');
    } finally {
      setExporting(null);
    }
  };

  const handleExport1C = async () => {
    if (!row.department_id) return;
    setExporting('1c');
    try {
      const blob = await timesheetService.exportMass({
        month: monthStr,
        department_ids: [row.department_id],
        from: row.start_date,
        to: row.end_date,
        group_by: 'employees',
        presentation: 'hr',
        export_as_1c: true,
      });
      downloadBlob(blob, `1С_${deptLabel}_${row.start_date}_${row.end_date}.zip`);
    } catch (err) {
      toast.error?.(err instanceof Error ? err.message : 'Ошибка выгрузки для 1С');
    } finally {
      setExporting(null);
    }
  };

  const handleExportEmployee = async () => {
    if (selectedEmployeeId === '') return;
    const emp = employees.find(e => e.id === selectedEmployeeId);
    setExporting('employee');
    try {
      const blob = await timesheetService.export({
        month: monthStr,
        department_id: row.department_id ?? undefined,
        from: row.start_date,
        to: row.end_date,
        presentation: 'hr',
        employee_id: selectedEmployeeId,
      });
      const empLabel = sanitizeFilePart(emp?.full_name ?? String(selectedEmployeeId));
      downloadBlob(blob, `Табель_${empLabel}_${row.start_date}_${row.end_date}.xlsx`);
    } catch (err) {
      toast.error?.(err instanceof Error ? err.message : 'Ошибка выгрузки табеля сотрудника');
    } finally {
      setExporting(null);
    }
  };

  const handleExportEmployee1C = async () => {
    if (selectedEmployeeId === '') return;
    const emp = employees.find(e => e.id === selectedEmployeeId);
    setExporting('employee_1c');
    try {
      const blob = await timesheetService.export({
        month: monthStr,
        department_id: row.department_id ?? undefined,
        from: row.start_date,
        to: row.end_date,
        presentation: 'hr',
        employee_id: selectedEmployeeId,
        export_as_1c: true,
      });
      const empLabel = sanitizeFilePart(emp?.full_name ?? String(selectedEmployeeId));
      downloadBlob(blob, `1С_${empLabel}_${row.start_date}_${row.end_date}.xlsx`);
    } catch (err) {
      toast.error?.(err instanceof Error ? err.message : 'Ошибка выгрузки для 1С');
    } finally {
      setExporting(null);
    }
  };

  return (
    <>
      {attachments.length > 0 && (
        <div className="approvals-attachments">
          <button
            type="button"
            className="approvals-attachment-btn"
            onClick={() => setAttModalOpen(true)}
          >
            <FileText size={14} /> Вложения ({attachments.length})
          </button>
        </div>
      )}
      {attModalOpen && (
        <ApprovalAttachmentsModal
          attachments={attachments}
          loading={attachmentsQuery.isLoading}
          urlLoader={loadAttachmentUrl}
          onClose={() => setAttModalOpen(false)}
          onDelete={canManageAttachments ? handleDeleteAttachment : undefined}
          canDelete={canManageAttachments ? () => true : undefined}
          deletingId={deletingId}
        />
      )}
      {!isPersonal && (
        <div className="approvals-export">
          <button
            type="button"
            className="approvals-export-btn"
            onClick={handleExportFact}
            disabled={exporting !== null}
          >
            <Download size={16} /> {exporting === 'fact' ? 'Выгрузка…' : 'Выгрузка факта'}
          </button>
          <button
            type="button"
            className="approvals-export-btn"
            onClick={handleExport1C}
            disabled={exporting !== null}
          >
            <Download size={16} /> {exporting === '1c' ? 'Выгрузка…' : 'Выгрузка для 1С'}
          </button>
        </div>
      )}
      <div className="approvals-export-employee">
        <select
          className="approvals-export-select"
          value={selectedEmployeeId}
          onChange={e => setSelectedEmployeeId(e.target.value ? Number(e.target.value) : '')}
          disabled={employees.length === 0 || exporting !== null}
        >
          <option value="">Выберите сотрудника…</option>
          {employees.map(emp => (
            <option key={emp.id} value={emp.id}>{emp.full_name}</option>
          ))}
        </select>
        <button
          type="button"
          className="approvals-export-btn"
          onClick={handleExportEmployee}
          disabled={selectedEmployeeId === '' || exporting !== null}
        >
          <Download size={16} /> {exporting === 'employee' ? 'Выгрузка…' : 'Выгрузка в Excel'}
        </button>
        <button
          type="button"
          className="approvals-export-btn"
          onClick={handleExportEmployee1C}
          disabled={selectedEmployeeId === '' || exporting !== null}
        >
          <Download size={16} /> {exporting === 'employee_1c' ? 'Выгрузка…' : 'Выгрузка для 1С'}
        </button>
      </div>
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

  const isPersonal = row.manager_employee_id != null;

  const submittedQuery = useQuery({
    queryKey: ['approval-submitted-employees', row.id],
    queryFn: () => timesheetApprovalService.getSubmittedEmployees(row.id),
    staleTime: 60_000,
  });

  // Для персональной подачи department_id=null — тянем табель по списку сотрудников снимка,
  // а не по отделу. Ждём подгрузки снимка, потом запрашиваем по employee_ids.
  const personalEmployeeIds = submittedQuery.data?.employees.map(e => e.employee_id) ?? [];
  const tsQuery = useQuery({
    queryKey: ['approval-timesheet', row.id, isPersonal ? personalEmployeeIds.join(',') : null],
    queryFn: () => timesheetService.getAll({
      month: monthStr,
      department_id: isPersonal ? undefined : (row.department_id ?? undefined),
      employee_ids: isPersonal ? personalEmployeeIds : undefined,
      from: monthBounds?.firstDate ?? row.start_date,
      to: monthBounds?.lastDate ?? row.end_date,
      include_objects: true,
      schedule_payload: 'compact',
    }),
    enabled: !isPersonal || personalEmployeeIds.length > 0,
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
      <div className="approvals-submission-summary">
        <div className="approvals-submission-row">
          <span className="approvals-submission-label">{isPersonal ? 'Подача:' : 'Отдел:'}</span>
          <span className="approvals-submission-value">
            {isPersonal
              ? `Персональная подача · ${row.manager_employee_name ?? '—'}`
              : (row.department_name ?? row.department_id ?? '—')}
          </span>
        </div>
        <div className="approvals-submission-row">
          <span className="approvals-submission-label">Руководитель:</span>
          <span className="approvals-submission-manager">{row.submitted_by_name ?? '—'}</span>
        </div>
        <div className="approvals-submission-row approvals-submission-row--employees">
          <span className="approvals-submission-label">
            {isPersonal ? 'Подчинённые' : 'Сотрудники'}{submittedQuery.data ? ` (${submittedQuery.data.employees.length})` : ''}:
          </span>
          {submittedQuery.isLoading ? (
            <span className="approvals-submission-value">Загрузка…</span>
          ) : submittedQuery.isError ? (
            <span className="approvals-submission-value approvals-submission-error">не удалось загрузить состав</span>
          ) : submittedQuery.data && submittedQuery.data.employees.length > 0 ? (
            <ul className="approvals-submission-employees">
              {submittedQuery.data.employees.map(e => (
                <li key={e.employee_id}>{e.full_name}</li>
              ))}
            </ul>
          ) : (
            <span className="approvals-submission-value">—</span>
          )}
        </div>
      </div>

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

      <ApprovalCardExtras row={row} employees={tsQuery.data?.employees ?? []} />

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
  const [deptId, setDeptId] = useState('');

  const structureTree = useStructureTree();
  const departments = useMemo(() => structureTree.data?.departments ?? [], [structureTree.data]);
  const allowedDeptIds = useMemo(
    () => (deptId ? collectDescendantIds(departments, new Set([deptId])) : null),
    [deptId, departments],
  );

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

  const allRows: IApprovalReviewItem[] = useMemo(() => query.data ?? [], [query.data]);
  const rows: IApprovalReviewItem[] = useMemo(
    () => (allowedDeptIds
      ? allRows.filter(r => r.department_id != null && allowedDeptIds.has(r.department_id))
      : allRows),
    [allRows, allowedDeptIds],
  );

  // Группировка карточек по «участку» (общему parent_department_id) — см. group_key с бэка.
  // Группы с одной подачей отрисовываются как раньше (без обёртки), чтобы не плодить шум.
  const grouped = useMemo(() => {
    const map = new Map<string, IApprovalReviewItem[]>();
    for (const row of rows) {
      const key = row.group_key ?? `approval:${row.id}`;
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()].map(([key, items]) => ({
      key,
      items,
      // Заголовок участка — сначала parent_department_name, иначе ФИО руководителя для manager-ключа.
      label: items[0]?.parent_department_name
        ?? (key.startsWith('manager:')
          ? items[0]?.manager_employee_name ?? 'Персональная подача руководителя'
          : items[0]?.department_name ?? null),
    }));
  }, [rows]);

  const handleConfirmComment = (comment: string) => {
    if (!commentModal) return;
    if (commentModal.mode === 'rework') {
      rejectMutation.mutate({ id: commentModal.row.id, comment });
    } else {
      returnMutation.mutate({ id: commentModal.row.id, comment });
    }
  };

  return (
    <>
      <div className="ts-filter-dept">
        <DepartmentTreeSelect
          departments={departments}
          value={deptId}
          onChange={setDeptId}
          isLoading={structureTree.isPending}
          isError={structureTree.isError}
          onRetry={() => { void structureTree.refetch(); }}
        />
      </div>

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
          {grouped.map(group => {
            const renderCard = (row: IApprovalReviewItem, inGroup: boolean) => {
              const expanded = expandedId === row.id;
              // Подзаголовок секции: для personal-подачи показываем «Руководитель: ФИО»,
              // для подачи отдела — её собственное имя (отличающееся от заголовка участка).
              const sectionLabel = row.manager_employee_id != null
                ? `Руководитель: ${row.manager_employee_name ?? '—'}`
                : row.department_name ?? row.department_id ?? '—';
              return (
                <li key={row.id} className={`approvals-card${inGroup ? ' approvals-card--in-group' : ''}`}>
                  <button
                    type="button"
                    className="approvals-card-header"
                    onClick={() => setExpandedId(expanded ? null : row.id)}
                  >
                    <div className="approvals-card-info">
                      <strong>{sectionLabel}</strong>
                      <span className="approvals-card-range">{formatDate(row.start_date)} — {formatDate(row.end_date)}</span>
                    </div>
                    <span className="approvals-card-status">{APPROVAL_STATUS_LABELS[row.status]}</span>
                    {row.department_id && (
                      <span
                        className={`approvals-card-timekeeper${row.timekeeper_checked ? ' approvals-card-timekeeper--checked' : ''}`}
                        title={row.timekeeper_checked_by_name ? `Табельщица: ${row.timekeeper_checked_by_name}` : undefined}
                      >
                        Табельщица: {row.timekeeper_checked ? 'Проверено' : 'Не проверено'}
                      </span>
                    )}
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
            };

            if (group.items.length === 1) {
              return renderCard(group.items[0]!, false);
            }
            return (
              <li key={group.key} className="approvals-group">
                <div className="approvals-group-header">
                  <strong>Участок: {group.label ?? '—'}</strong>
                  <span className="approvals-group-meta">{group.items.length} подач</span>
                </div>
                <ul className="approvals-group-items">
                  {group.items.map(row => renderCard(row, true))}
                </ul>
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
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('corrections');
  const [showPreview, setShowPreview] = useState(false);

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
        {isAdmin && tab === 'corrections' && (
          <button
            type="button"
            className="approvals-period-preview-btn"
            onClick={() => setShowPreview(true)}
            title="Просмотр согласований по ответственным (только чтение)"
          >
            <Eye size={16} />
            <span>Просмотр</span>
          </button>
        )}
      </div>

      {tab === 'corrections'
        ? <CorrectionsTab period={correctionsPeriod} />
        : <TimesheetsTab period={period} />}

      {showPreview && (
        <WeekendApprovalsPreviewModal
          period={correctionsPeriod}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
};
