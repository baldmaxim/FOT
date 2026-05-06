/**
 * Рекурсивный компонент дерева отделов Sigur.
 *
 * Извлечён из SigurEmployeesTab.tsx (Волна 3 декомпозиции).
 * Self-recursive: рендерит детей через те же props (drill через все callbacks).
 * Поддержка drag&drop сотрудников на отдел через EMPLOYEE_DRAG_TYPE
 * (data ключ — JSON массива employeeIds).
 */
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import type { DragEvent as ReactDragEvent, FC, MouseEvent as ReactMouseEvent } from 'react';
import type { SigurDepartmentNode } from '../../../types';
import { EMPLOYEE_DRAG_TYPE } from './sigurEmployeesTab.helpers';

export interface IDepartmentTreeNodeProps {
  node: SigurDepartmentNode;
  level: number;
  selectedDeptId: number | null;
  expandedIds: Set<number>;
  visibleIds: Set<number> | null;
  manageSelectedIds: Set<number>;
  canManage: boolean;
  onSelect: (departmentId: number | null) => void;
  onToggle: (departmentId: number) => void;
  onToggleManageSelection: (departmentId: number) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLDivElement>, departmentId: number) => void;
  onDropEmployees: (departmentId: number, employeeIds: number[]) => void;
  registerNodeRef: (departmentId: number, element: HTMLDivElement | null) => void;
}

export const DepartmentTreeNode: FC<IDepartmentTreeNodeProps> = ({
  node,
  level,
  selectedDeptId,
  expandedIds,
  visibleIds,
  manageSelectedIds,
  canManage,
  onSelect,
  onToggle,
  onToggleManageSelection,
  onOpenContextMenu,
  onDropEmployees,
  registerNodeRef,
}) => {
  if (visibleIds && !visibleIds.has(node.id)) return null;

  const hasChildren = (node.children || []).length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedDeptId === node.id;
  const isManageSelected = manageSelectedIds.has(node.id);

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData(EMPLOYEE_DRAG_TYPE);
    if (!raw) return;

    try {
      const payload = JSON.parse(raw) as { employeeIds?: number[] };
      const employeeIds = Array.from(new Set((payload.employeeIds || []).map(Number).filter(Number.isFinite)));
      if (employeeIds.length > 0) {
        onDropEmployees(node.id, employeeIds);
      }
    } catch {
      // ignore malformed drag payload
    }
  };

  return (
    <div key={node.id} className="ep-dept-item">
      <div
        ref={element => registerNodeRef(node.id, element)}
        className={[
          'ep-dept-header',
          isSelected ? 'active' : '',
          isManageSelected ? 'manage-selected' : '',
          'droppable',
        ].filter(Boolean).join(' ')}
        style={{ paddingLeft: `${12 + level * 20}px` }}
        onClick={() => onSelect(isSelected ? null : node.id)}
        onContextMenu={event => onOpenContextMenu(event, node.id)}
        onDragOver={event => event.preventDefault()}
        onDrop={handleDrop}
      >
        {canManage && (
          <button
            className={`ep-manage-check ${isManageSelected ? 'checked' : ''}`}
            onClick={event => {
              event.stopPropagation();
              onToggleManageSelection(node.id);
            }}
            title={isManageSelected ? 'Убрать из выбора' : 'Выбрать отдел'}
          />
        )}
        <button
          className={`ep-dept-toggle ${hasChildren ? (isExpanded ? 'expanded' : '') : 'empty'}`}
          onClick={event => {
            event.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
        >
          <ChevronRight size={14} />
        </button>
        {hasChildren && isExpanded ? <FolderOpen size={16} className="ep-dept-icon" /> : <Folder size={16} className="ep-dept-icon" />}
        <span className="ep-dept-name">{node.name}</span>
        <span className="ep-dept-count">
          {node.employeeCountLoaded === false
            ? (node.employeeCount > 0 ? `${node.employeeCount}+` : '…')
            : node.employeeCount}
        </span>
      </div>
      {hasChildren && isExpanded && (
        <div className="ep-dept-children">
          {node.children!.map(child => (
            <DepartmentTreeNode
              key={child.id}
              node={child}
              level={level + 1}
              selectedDeptId={selectedDeptId}
              expandedIds={expandedIds}
              visibleIds={visibleIds}
              manageSelectedIds={manageSelectedIds}
              canManage={canManage}
              onSelect={onSelect}
              onToggle={onToggle}
              onToggleManageSelection={onToggleManageSelection}
              onOpenContextMenu={onOpenContextMenu}
              onDropEmployees={onDropEmployees}
              registerNodeRef={registerNodeRef}
            />
          ))}
        </div>
      )}
    </div>
  );
};
