import { type FC, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, ChevronDown, ChevronUp } from 'lucide-react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  correctionApprovalService,
  type IResponsibleApprovalGroup,
  type ICorrectionDepartmentGroup,
} from '../../services/correctionApprovalService';
import type { ITimesheetDateRange } from '../../utils/timesheetApprovalPeriod';
import { CorrectionGroupsList } from './CorrectionGroupsList';
import { DepartmentTimesheetModal } from '../../components/timesheet/DepartmentTimesheetModal';
import './WeekendApprovalsPreviewModal.css';

interface IProps {
  period: ITimesheetDateRange;
  onClose: () => void;
}

interface ITsModalState {
  departmentId?: string;
  employeeIds?: number[];
  departmentName: string;
  month: string;
}

// В readOnly выбор не нужен — общий пустой набор и no-op хендлеры.
const EMPTY_SELECTION = new Set<number>();
const noop = (): void => {};

interface IResponsibleSectionProps {
  group: IResponsibleApprovalGroup;
  isHistory: boolean;
  isMobile: boolean;
  onOpenTimesheet: (group: ICorrectionDepartmentGroup) => void;
}

/** Секция одного ответственного: его очередь «как он сам её видит» (read-only). */
const ResponsibleSection: FC<IResponsibleSectionProps> = ({ group, isHistory, isMobile, onOpenTimesheet }) => {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());

  const toggleExpand = (departmentId: string): void => {
    setExpanded(s => ({ ...s, [departmentId]: !s[departmentId] }));
  };
  const toggleNotes = (id: number): void => {
    setExpandedNotes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="wap-section">
      <header className="wap-section-header">
        <button
          type="button"
          className="wap-section-toggle"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
        >
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          <span className={`wap-section-name${group.is_unassigned ? ' wap-section-name--unassigned' : ''}`}>
            {group.is_unassigned
              ? 'Без назначенного ответственного'
              : (group.responsible_name ?? `#${group.responsible_employee_id}`)}
          </span>
        </button>
        <span className="wap-section-stats" title={`Записей: ${group.items_count} · Сотрудников: ${group.employees_count}`}>
          {group.items_count} · {group.employees_count}&thinsp;чел
        </span>
      </header>
      {open && (
        <CorrectionGroupsList
          groups={group.departments}
          isHistory={isHistory}
          isMobile={isMobile}
          readOnly
          canSelect
          selectedIds={EMPTY_SELECTION}
          onToggleId={noop}
          onToggleGroup={noop}
          onToggleAll={noop}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          expandedNotes={expandedNotes}
          onToggleNotes={toggleNotes}
          onOpenTimesheet={onOpenTimesheet}
        />
      )}
    </section>
  );
};

/**
 * Админ-обзор очереди согласований выходных «глазами ответственных» (read-only).
 * Все заявки, разбитые по ответственным лицам; действия согласования отключены.
 */
export const WeekendApprovalsPreviewModal: FC<IProps> = ({ period, onClose }) => {
  const overlayHandlers = useOverlayDismiss(onClose);
  const isMobile = useIsMobile(768);
  const [mode, setMode] = useState<'pending' | 'history'>('pending');
  const [tsModal, setTsModal] = useState<ITsModalState | null>(null);

  const query = useQuery({
    queryKey: ['weekend-approvals-preview', mode, period.startDate, period.endDate],
    queryFn: () => correctionApprovalService.getAllByResponsible(period.startDate, period.endDate, mode),
  });

  const groups = query.data ?? [];
  const isHistory = mode === 'history';

  const openTimesheet = (group: ICorrectionDepartmentGroup): void => {
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

  return (
    <>
      <div className="approvals-modal-overlay" {...overlayHandlers}>
        <div className="approvals-modal wap-modal">
          <div className="approvals-modal-header">
            <h3>Просмотр согласований по ответственным</h3>
            <button
              type="button"
              className="approvals-modal-close"
              onClick={onClose}
              aria-label="Закрыть"
            >
              <X size={18} />
            </button>
          </div>

          <div className="approvals-modal-body wap-body">
            <div className="wap-topbar">
              <div className="cor-view-tabs" role="tablist" aria-label="Раздел согласования">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'pending'}
                  className={`cor-view-tab${mode === 'pending' ? ' is-active' : ''}`}
                  onClick={() => setMode('pending')}
                >
                  На проверке
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'history'}
                  className={`cor-view-tab${mode === 'history' ? ' is-active' : ''}`}
                  onClick={() => setMode('history')}
                >
                  История
                </button>
              </div>
              <span className="wap-readonly-note">Режим только чтения</span>
            </div>

            <div className="wap-list">
              {query.isLoading ? (
                <div className="approvals-empty">Загрузка…</div>
              ) : query.isError ? (
                <div className="approvals-empty">Ошибка загрузки</div>
              ) : groups.length === 0 ? (
                <div className="approvals-empty">
                  {isHistory ? 'В истории за период ничего нет' : 'Нет заявок по выходным за период'}
                </div>
              ) : (
                groups.map(group => (
                  <ResponsibleSection
                    key={group.responsible_employee_id ?? 'unassigned'}
                    group={group}
                    isHistory={isHistory}
                    isMobile={isMobile}
                    onOpenTimesheet={openTimesheet}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {tsModal && (
        <DepartmentTimesheetModal {...tsModal} onClose={() => setTsModal(null)} />
      )}
    </>
  );
};
