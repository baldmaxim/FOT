import { type FC, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { TriStateCheckbox, type CheckboxSelectionState } from '../ui/TriStateCheckbox';
import type { ILeaveRequest } from '../../services/leaveRequestService';

interface ILeaveRequestsGroupProps {
  label: string;
  items: ILeaveRequest[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isDirectReports: boolean;
  /** id заявлений группы, которые можно выбрать (pending). */
  selectableIds: number[];
  selectionState: CheckboxSelectionState;
  onToggleGroup: (ids: number[], checked: boolean) => void;
  bulkMode: boolean;
  disabled: boolean;
  renderRow: (request: ILeaveRequest) => ReactNode;
}

/**
 * Карточка отдела со сворачиваемым списком заявлений. Вид повторяет группу
 * выходных дней на /approvals: чекбокс, название, плашка «N · M чел».
 */
export const LeaveRequestsGroup: FC<ILeaveRequestsGroupProps> = ({
  label,
  items,
  isCollapsed,
  onToggleCollapse,
  isDirectReports,
  selectableIds,
  selectionState,
  onToggleGroup,
  bulkMode,
  disabled,
  renderRow,
}) => {
  const employeesCount = new Set(items.map(i => i.employee_id)).size;

  return (
    <div className={`lrm-dept-card${isDirectReports ? ' lrm-dept-card--direct-reports' : ''}`}>
      <div className={`lrm-dept-header${isCollapsed ? '' : ' lrm-dept-header--expanded'}`}>
        {bulkMode && selectableIds.length > 0 && (
          <TriStateCheckbox
            className="lrm-dept-check"
            state={selectionState}
            onChange={(checked) => onToggleGroup(selectableIds, checked)}
            ariaLabel={`Выбрать все заявления: ${label}`}
            disabled={disabled}
          />
        )}
        <button
          type="button"
          className="lrm-dept-toggle"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          <span className="lrm-dept-name" title={label}>{label}</span>
        </button>
        <span
          className="lrm-dept-stats"
          title={`Заявлений: ${items.length} · Сотрудников: ${employeesCount}`}
        >
          {items.length} · {employeesCount}&thinsp;чел
        </span>
      </div>

      {!isCollapsed && (
        <ul className="lrm-items">
          {items.map(renderRow)}
        </ul>
      )}
    </div>
  );
};
