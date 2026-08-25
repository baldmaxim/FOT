import { type FC, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { TriStateCheckbox, type CheckboxSelectionState } from '../ui/TriStateCheckbox';
import type { ILeaveRequest } from '../../services/leaveRequestService';

interface ILeaveRequestsGroupProps {
  label: string;
  items: ILeaveRequest[];
  showHeader: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isDirectReports: boolean;
  /** Показывать ли чекбокс отдела (массовый режим и есть что выбирать). */
  selectableIds: number[];
  selectionState: CheckboxSelectionState;
  onToggleGroup: (ids: number[], checked: boolean) => void;
  bulkMode: boolean;
  disabled: boolean;
  renderCard: (request: ILeaveRequest) => ReactNode;
}

/** Группа заявлений одного отдела: сворачиваемая шапка со счётчиками + карточки. */
export const LeaveRequestsGroup: FC<ILeaveRequestsGroupProps> = ({
  label,
  items,
  showHeader,
  isCollapsed,
  onToggleCollapse,
  isDirectReports,
  selectableIds,
  selectionState,
  onToggleGroup,
  bulkMode,
  disabled,
  renderCard,
}) => {
  const employeesCount = new Set(items.map(i => i.employee_id)).size;

  return (
    <div
      className={`lrm-group${isCollapsed ? ' lrm-group--collapsed' : ''}${isDirectReports ? ' lrm-group--direct-reports' : ''}`}
    >
      {showHeader && (
        <div className="lrm-group-header">
          {bulkMode && selectableIds.length > 0 && (
            <TriStateCheckbox
              className="lrm-group-check"
              state={selectionState}
              onChange={(checked) => onToggleGroup(selectableIds, checked)}
              ariaLabel={`Выбрать все заявления: ${label}`}
              disabled={disabled}
            />
          )}
          <button
            type="button"
            className="lrm-group-toggle"
            onClick={onToggleCollapse}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            <span className="lrm-group-name">{label}</span>
            <span className="lrm-group-stats">
              {items.length} · {employeesCount} чел
            </span>
          </button>
        </div>
      )}
      {!isCollapsed && items.map(renderCard)}
    </div>
  );
};
