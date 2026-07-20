import { type FC, useMemo, useEffect, useRef } from 'react';
import { Check, X, RotateCcw, ChevronDown, ChevronUp, FileText } from 'lucide-react';
import type {
  ICorrectionDepartmentGroup,
  ICorrectionPendingItem,
} from '../../services/correctionApprovalService';
import {
  STATUS_LABELS,
  STATUS_ICONS,
  formatHM,
  formatDateCompact,
  formatDateTimeShort,
} from './approvalsShared';

interface IGroupCheckboxProps {
  state: 'none' | 'partial' | 'all';
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}

const GroupCheckbox: FC<IGroupCheckboxProps> = ({ state, onChange, ariaLabel, disabled = false }) => {
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
      disabled={disabled}
    />
  );
};

interface ICorrectionGroupsListProps {
  groups: ICorrectionDepartmentGroup[];
  isHistory: boolean;
  isMobile: boolean;
  /** true — режим просмотра админа: чекбоксы и действия видны, но отключены. */
  readOnly?: boolean;
  /** Показывать ли блок выбора/действий (для ответственного — да). */
  canSelect: boolean;
  selectedIds: Set<number>;
  onToggleId: (id: number) => void;
  onToggleGroup: (group: ICorrectionDepartmentGroup, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  expanded: Record<string, boolean>;
  onToggleExpand: (departmentId: string) => void;
  expandedNotes: Set<number>;
  onToggleNotes: (id: number) => void;
  onOpenTimesheet: (group: ICorrectionDepartmentGroup) => void;
  onBulkApprove?: (ids: number[]) => void;
  onBulkReject?: (ids: number[]) => void;
  onBulkRevert?: (ids: number[]) => void;
  bulkPending?: boolean;
}

type SelectionState = 'none' | 'partial' | 'all';

/**
 * Презентационный список выходных дней на согласовании, сгруппированный по
 * отделам. Используется во вкладке «Выходные дни» (интерактивно) и в админ-модалке
 * «Просмотр по ответственным» (readOnly — действия отключены).
 */
export const CorrectionGroupsList: FC<ICorrectionGroupsListProps> = ({
  groups,
  isHistory,
  isMobile,
  readOnly = false,
  canSelect,
  selectedIds,
  onToggleId,
  onToggleGroup,
  onToggleAll,
  expanded,
  onToggleExpand,
  expandedNotes,
  onToggleNotes,
  onOpenTimesheet,
  onBulkApprove,
  onBulkReject,
  onBulkRevert,
  bulkPending = false,
}) => {
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

  const allSelectionState: SelectionState = useMemo(() => {
    if (allItemIds.length === 0) return 'none';
    let count = 0;
    for (const id of allItemIds) if (selectedIds.has(id)) count++;
    if (count === 0) return 'none';
    if (count === allItemIds.length) return 'all';
    return 'partial';
  }, [allItemIds, selectedIds]);

  const groupSelectionState = (group: ICorrectionDepartmentGroup): SelectionState => {
    if (group.items.length === 0) return 'none';
    let count = 0;
    for (const item of group.items) if (selectedIds.has(item.id)) count++;
    if (count === 0) return 'none';
    if (count === group.items.length) return 'all';
    return 'partial';
  };

  const actionsDisabled = readOnly || selectedIds.size === 0 || bulkPending;

  return (
    <>
      {canSelect && groups.length > 0 && (
        <div className="cor-actionbar">
          <GroupCheckbox
            state={allSelectionState}
            onChange={onToggleAll}
            ariaLabel="Выбрать все выходные дни во всех отделах"
            disabled={readOnly}
          />
          <span className="cor-actionbar-summary">
            {!readOnly && selectedIds.size > 0 ? (
              <>Выбрано: <b>{selectedIds.size}</b></>
            ) : (
              <><b>{allItemIds.length}</b> в <b>{groups.length}</b> отд. · <b>{totalEmployees}</b> чел</>
            )}
          </span>
          {readOnly && <span className="cor-actionbar-readonly">Режим просмотра</span>}
          {!readOnly && (
          <div className="cor-actionbar-btns">
            {!isHistory ? (
              <>
                <button
                  type="button"
                  className="cor-actionbar-btn cor-actionbar-btn--approve"
                  onClick={() => onBulkApprove?.([...selectedIds])}
                  disabled={actionsDisabled}
                >
                  <Check size={15} />
                  {(() => {
                    const label = isMobile ? 'Утв. выбр.' : 'Утвердить выбранные';
                    return !readOnly && selectedIds.size > 0 ? `${label} (${selectedIds.size})` : label;
                  })()}
                </button>
                <button
                  type="button"
                  className="cor-actionbar-btn cor-actionbar-btn--reject"
                  onClick={() => onBulkReject?.([...selectedIds])}
                  disabled={actionsDisabled}
                >
                  <X size={15} />
                  {(() => {
                    const label = isMobile ? 'Откл. выбр.' : 'Отклонить выбранные';
                    return !readOnly && selectedIds.size > 0 ? `${label} (${selectedIds.size})` : label;
                  })()}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="cor-actionbar-btn cor-actionbar-btn--revert"
                onClick={() => onBulkRevert?.([...selectedIds])}
                disabled={actionsDisabled}
              >
                <RotateCcw size={15} />
                {(() => {
                  const label = isMobile ? 'Вернуть' : 'Вернуть выбранные';
                  return !readOnly && selectedIds.size > 0 ? `${label} (${selectedIds.size})` : label;
                })()}
              </button>
            )}
          </div>
          )}
        </div>
      )}

      <ul className="approvals-list">
        {groups.map(group => {
          const isOpen = !!expanded[group.department_id];
          return (
            <li key={group.department_id} className="cor-dept-card">
              <div className={`cor-dept-header${isOpen ? ' cor-dept-header--expanded' : ''}`}>
                {canSelect && (
                  <GroupCheckbox
                    state={groupSelectionState(group)}
                    onChange={(checked) => onToggleGroup(group, checked)}
                    ariaLabel={`Выбрать все в отделе ${group.department_name}`}
                    disabled={readOnly}
                  />
                )}
                <button
                  type="button"
                  className="cor-dept-toggle"
                  onClick={() => onToggleExpand(group.department_id)}
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
                <button
                  type="button"
                  className="cor-dept-timesheet-btn"
                  onClick={(e) => { e.stopPropagation(); onOpenTimesheet(group); }}
                  title="Табель отдела за месяц"
                  aria-label={`Табель отдела ${group.department_name}`}
                >
                  <FileText size={15} />
                  {!isMobile && <span>Табель</span>}
                </button>
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
                            onChange={() => onToggleId(item.id)}
                            aria-label={`Выбрать корректировку ${item.employee_name ?? item.employee_id} ${item.work_date}`}
                            disabled={readOnly}
                          />
                        )}
                        <span className="cor-item-date" data-hours={hours}>
                          <span className="cor-item-date-day">{dateParts.day}</span>
                          <span className="cor-item-date-wd">{dateParts.weekday}</span>
                        </span>
                        <span className="cor-item-employee">
                          <span className="cor-item-employee-name">{item.employee_name ?? `#${item.employee_id}`}</span>
                          {(item.skud_objects?.length ?? 0) > 0 && (
                            <span className="cor-item-objects" title="Объекты по СКУД за последние 2 недели">
                              {item.skud_objects!.join(', ')}
                            </span>
                          )}
                        </span>
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
                          onClick={() => onToggleNotes(item.id)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleNotes(item.id); } }}
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
    </>
  );
};
