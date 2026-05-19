import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef, memo, type FC, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Pencil, ArrowRightLeft, History, TrendingUp, Upload, UserPlus, Calendar, UserRoundX, ShieldCheck, CheckSquare } from 'lucide-react';
import { SearchInput } from '../components/ui/SearchInput';
import { employeeService } from '../services/employeeService';
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
import type { Employee, EmployeeHistoryEvent, EnrichPreview, ContactsEnrichPreview } from '../types';
import { structureApi } from '../api/structure';
import type { IFlatDepartmentOption } from '../utils/departmentUtils';
import { filterDepartmentTreeByIds, getTreeFlatDepartments } from '../utils/departmentUtils';
import '../styles/StaffControlPage.css';

const HistoryPanel = lazy(() => import('../components/staff/HistoryPanel').then(m => ({ default: m.HistoryPanel })));
const ImportModal = lazy(() => import('../components/employees/ImportModal').then(m => ({ default: m.ImportModal })));
const EnrichPreviewModal = lazy(() => import('../components/employees/EnrichPreviewModal').then(m => ({ default: m.EnrichPreviewModal })));

import {
  EMPTY_EMPLOYEE_SCHEDULE_ASSIGNMENTS,
  EMPTY_SCHEDULE_TEMPLATES,
  fmt,
  getLocalISODate,
  handleMiddleClickMouseDown,
  isActiveScheduleAssignment,
  openEmployeeInNewTab,
  SCHEDULE_SOURCE_LABELS,
  type IAddEmployeeForm,
  type IEmployeeScheduleView,
  type ModalType,
  type StaffStatusFilter,
} from './staffControlPage.helpers';

/* ───────── Memoized table row ───────── */

interface IStaffRowProps {
  emp: Employee;
  index: number;
  scheduleViews: Map<number, IEmployeeScheduleView>;
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
  onReturn?: (emp: Employee) => void;
}

const StaffRow: FC<IStaffRowProps> = memo(({ emp, index, scheduleViews, selectedIds, selectionMode, canManage, canEditDept, canEditPos, canEditSch, canOpenCard, onNavigate, onToggleSelect, onOpenModal, onOpenHistory, onRehire, onFire, onReturn }) => {
  const scheduleView = scheduleViews.get(emp.id);
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
      <td className="sc-td-name">
        {emp.full_name}
        {emp.excluded_from_timesheet && (
          <span className="sc-excluded-badge" title={emp.excluded_from_timesheet_at ? `Исключён из табеля: ${new Date(emp.excluded_from_timesheet_at).toLocaleString('ru-RU')}` : 'Исключён из табеля'}>
            Исключён
          </span>
        )}
      </td>
      <td>
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
      <td>
        <span className="sc-cell-with-btn">
          {canEditSch && (
            <button className="sc-inline-btn" title="Назначить график" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'schedule'); }}>
              <Calendar size={12} />
            </button>
          )}
          <span className="sc-schedule-cell">
            <span className="sc-schedule-name">{scheduleView?.scheduleName || '—'}</span>
            {scheduleView && scheduleView.source !== 'default' && <span className={`sc-schedule-badge ${scheduleView.source}`}>{SCHEDULE_SOURCE_LABELS[scheduleView.source]}</span>}
          </span>
        </span>
      </td>
      {canManage && (
        <td className="sc-td-salary">
          <span className="sc-cell-with-btn">
            <button className="sc-inline-btn" title="Изменить оклад (договор)" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'salary_actual'); }}>
              <Pencil size={12} />
            </button>
            {fmt(emp.salary_actual)}
          </span>
        </td>
      )}
      {canManage && (
        <td className="sc-td-salary">
          <span className="sc-cell-with-btn">
            <button className="sc-inline-btn" title="Изменить оклад+премию" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'salary'); }}>
              <Pencil size={12} />
            </button>
            {fmt(emp.salary_calculated)}
          </span>
        </td>
      )}
      <td className="sc-td-hist" onClick={e => e.stopPropagation()}>
        {onReturn && emp.excluded_from_timesheet ? (
          <button className="sc-btn apply" style={{ fontSize: 11, padding: '2px 8px' }} title="Вернуть сотрудника в табель" onClick={() => onReturn(emp)}>
            Вернуть в табель
          </button>
        ) : onRehire && emp.employment_status === 'fired' ? (
          <button className="sc-btn secondary" style={{ fontSize: 11, padding: '2px 8px' }} title="Восстановить сотрудника" onClick={() => onRehire(emp)}>
            Восстановить
          </button>
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
  allDepts: IFlatDepartmentOption[];
  templates: IWorkSchedule[];
  scheduleViews: Map<number, IEmployeeScheduleView>;
  baseScheduleViews: Map<number, IEmployeeScheduleView>;
  onClose: () => void;
  onSaveSalary: (empId: number, val: number, type: ModalType, reason?: string, date?: string) => Promise<void>;
  onSavePosition: (empId: number, val: string, reason?: string, date?: string) => Promise<void>;
  onSaveDepartment: (empId: number, deptId: string, effectiveDate?: string, reason?: string) => Promise<void>;
  onSaveSchedule: (empId: number, scheduleId: string | null, effectiveFrom: string, anchorDate: string | null) => Promise<void>;
  onFixAssignment: (empId: number, data: { assignment_id: string; effective_from?: string; anchor_date?: string | null }) => Promise<void>;
}

const StaffModals: FC<IStaffModalsProps> = memo(({
  modalType,
  modalEmp,
  allDepts,
  templates,
  scheduleViews,
  baseScheduleViews,
  onClose,
  onSaveSalary,
  onSavePosition,
  onSaveDepartment,
  onSaveSchedule,
  onFixAssignment,
}) => {
  const currentSchedule = modalEmp ? scheduleViews.get(modalEmp.id) : undefined;
  const [salaryVal, setSalaryVal] = useState('');
  const [salaryDate, setSalaryDate] = useState(() => getLocalISODate());
  const [salaryReason, setSalaryReason] = useState('');
  const [positionVal, setPositionVal] = useState('');
  const [positionDate, setPositionDate] = useState(() => getLocalISODate());
  const [positionReason, setPositionReason] = useState('');
  const [deptVal, setDeptVal] = useState(() => modalEmp?.org_department_id || '');
  const [deptDate, setDeptDate] = useState(() => getLocalISODate());
  const [deptReason, setDeptReason] = useState('');
  const [scheduleVal, setScheduleVal] = useState(() => currentSchedule?.source === 'employee' ? currentSchedule.scheduleId || '' : '');
  const [scheduleDate, setScheduleDate] = useState(() => currentSchedule?.source === 'employee' ? currentSchedule.effectiveFrom || getLocalISODate() : getLocalISODate());
  const [scheduleAnchor, setScheduleAnchor] = useState(() => currentSchedule?.assignmentAnchorDate ?? '');
  const hasFixableAssignment = currentSchedule?.source === 'employee' && !!currentSchedule.assignmentId;
  const [scheduleTab, setScheduleTab] = useState<'fix' | 'new'>(() => (hasFixableAssignment ? 'fix' : 'new'));
  const [fixFrom, setFixFrom] = useState(() => currentSchedule?.effectiveFrom || '');
  const [fixAnchor, setFixAnchor] = useState(() => currentSchedule?.assignmentAnchorDate ?? '');
  const [saving, setSaving] = useState(false);
  const selectedScheduleTemplate = scheduleVal ? templates.find(t => t.id === scheduleVal) ?? null : null;
  const isCycleTemplate = selectedScheduleTemplate?.pattern_type === 'cycle';

  if (!modalType || !modalEmp) return null;

  const handleSalary = async () => {
    if (!salaryVal) return;
    setSaving(true);
    await onSaveSalary(modalEmp.id, Number(salaryVal), modalType, salaryReason || undefined, salaryDate || undefined);
    setSaving(false);
  };

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

  const handleSchedule = async () => {
    setSaving(true);
    const value = scheduleVal === '' ? null : scheduleVal;
    const anchor = isCycleTemplate && scheduleAnchor.trim() ? scheduleAnchor : null;
    try {
      await onSaveSchedule(modalEmp.id, value, scheduleDate, anchor);
    } finally {
      setSaving(false);
    }
  };

  const handleFix = async () => {
    if (!currentSchedule?.assignmentId) return;
    const payload: { assignment_id: string; effective_from?: string; anchor_date?: string | null } = {
      assignment_id: currentSchedule.assignmentId,
    };
    if (fixFrom && fixFrom !== (currentSchedule.effectiveFrom || '')) payload.effective_from = fixFrom;
    if (currentSchedule.templatePatternType === 'cycle') {
      const norm = fixAnchor.trim() ? fixAnchor : null;
      if (norm !== (currentSchedule.assignmentAnchorDate ?? null)) payload.anchor_date = norm;
    }
    if (payload.effective_from === undefined && !('anchor_date' in payload)) return;
    setSaving(true);
    try {
      await onFixAssignment(modalEmp.id, payload);
    } finally {
      setSaving(false);
    }
  };

  if (modalType === 'salary' || modalType === 'salary_actual') {
    const title = modalType === 'salary' ? 'Изменить оклад+премию' : 'Изменить оклад (договор)';
    const placeholder = modalType === 'salary' ? 'Повышение, пересмотр...' : 'Изменение договора...';
    return (
      <div className="sc-overlay" onClick={onClose}>
        <div className="sc-modal" onClick={e => e.stopPropagation()}>
          <div className="sc-modal-header">
            <h3>{title} — {modalEmp.full_name}</h3>
            <button className="sc-modal-close" onClick={onClose}>&times;</button>
          </div>
          <div className="sc-modal-body">
            <div className="sc-field">
              <label>Новый оклад (₽)</label>
              <input type="number" value={salaryVal} onChange={e => setSalaryVal(e.target.value)} placeholder="150 000" autoFocus />
            </div>
            <div className="sc-field">
              <label>Дата вступления в силу</label>
              <input type="date" value={salaryDate} onChange={e => setSalaryDate(e.target.value)} />
            </div>
            <div className="sc-field">
              <label>Причина</label>
              <input value={salaryReason} onChange={e => setSalaryReason(e.target.value)} placeholder={placeholder} />
            </div>
          </div>
          <div className="sc-modal-footer">
            <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
            <button className="sc-btn apply" onClick={handleSalary} disabled={!salaryVal || saving}>
              {saving ? 'Сохранение...' : 'Применить'}
            </button>
          </div>
        </div>
      </div>
    );
  }

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
    const currentTemplate = templates.find(t => t.id === effectiveSchedule?.scheduleId) ?? null;
    const isCurrentCycle = effectiveSchedule?.templatePatternType === 'cycle';
    const fixAnchorNorm = fixAnchor.trim() ? fixAnchor : null;
    const fixFromChanged = !!fixFrom && fixFrom !== (effectiveSchedule?.effectiveFrom || '');
    const fixAnchorChanged = isCurrentCycle && fixAnchorNorm !== (effectiveSchedule?.assignmentAnchorDate ?? null);
    const fixDisabled = saving || !effectiveSchedule?.assignmentId || !fixFrom || (!fixFromChanged && !fixAnchorChanged);
    const onFixTab = scheduleTab === 'fix' && hasFixableAssignment;

    return (
      <div className="sc-overlay" onClick={onClose}>
        <div className="sc-modal" onClick={e => e.stopPropagation()}>
          <div className="sc-modal-header">
            <h3>График работы — {modalEmp.full_name}</h3>
            <button className="sc-modal-close" onClick={onClose}>&times;</button>
          </div>
          <div className="sc-modal-body">
            <div className="sc-segmented" role="tablist" aria-label="Режим" style={{ marginBottom: 14 }}>
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

            {onFixTab ? (
              <>
                <div className="sc-schedule-help" style={{ marginBottom: 14 }}>
                  <div><strong>Текущий график:</strong> {effectiveSchedule?.scheduleName || '—'}</div>
                  <div><strong>Дата вступления:</strong> {effectiveSchedule?.effectiveFrom || '—'}</div>
                  {isCurrentCycle && (
                    <div><strong>Якорь назначения:</strong> {effectiveSchedule?.assignmentAnchorDate || `— (якорь паттерна ${currentTemplate?.anchor_date || '—'})`}</div>
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
              </>
            )}
          </div>
          <div className="sc-modal-footer">
            <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
            {onFixTab ? (
              <button className="sc-btn apply" onClick={handleFix} disabled={fixDisabled}>
                {saving ? 'Сохранение...' : 'Исправить даты'}
              </button>
            ) : (
              <button
                className="sc-btn apply"
                onClick={handleSchedule}
                disabled={saving || !scheduleDate || (!hasEmployeeOverride && scheduleVal === '') || isUnchanged}
              >
                {saving ? 'Сохранение...' : 'Применить'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sc-overlay" onClick={onClose}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Сменить отдел — {modalEmp.full_name}</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <div className="sc-field">
            <label>Отдел</label>
            <select value={deptVal} onChange={e => setDeptVal(e.target.value)} autoFocus>
              <option value="">Выберите отдел</option>
              {allDepts.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
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
          <button className="sc-btn apply" onClick={handleDepartment} disabled={!deptVal || deptVal === modalEmp.org_department_id || !deptDate || saving}>
            {saving ? 'Сохранение...' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  );
});

/* ───────── Virtualized Table ───────── */

interface IVirtualTableProps {
  filtered: Employee[];
  scheduleViews: Map<number, IEmployeeScheduleView>;
  selectedIds: Set<number>;
  selectionMode: boolean;
  canManage: boolean;
  canEditDept: boolean;
  canEditPos: boolean;
  canEditSch: boolean;
  canOpenCard: boolean;
  onNavigate: (emp: Employee) => void;
  onToggleSelect: (empId: number) => void;
  onToggleSelectAll: () => void;
  allSelected: boolean;
  onOpenModal: (emp: Employee, type: ModalType) => void;
  onOpenHistory: (emp: Employee) => void;
  onRehire?: (emp: Employee) => void;
  onFire?: (emp: Employee) => void;
  onReturn?: (emp: Employee) => void;
}

const ROW_HEIGHT = 36;

const VirtualTable: FC<IVirtualTableProps> = memo(({
  filtered,
  scheduleViews,
  selectedIds,
  selectionMode,
  canManage,
  canEditDept,
  canEditPos,
  canEditSch,
  canOpenCard,
  onNavigate,
  onToggleSelect,
  onToggleSelectAll,
  allSelected,
  onOpenModal,
  onOpenHistory,
  onRehire,
  onFire,
  onReturn,
}) => {
  const totalCols = (canManage ? 8 : 6) + (selectionMode ? 1 : 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
  });

  return (
    <div className="sc-table-wrap" ref={scrollRef}>
      <table className="sc-table">
        <thead>
          <tr>
            {selectionMode && (
              <th className="sc-th-check">
                <input
                  className="sc-check"
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleSelectAll}
                  aria-label="Выбрать всех сотрудников на странице"
                />
              </th>
            )}
            <th className="sc-th-num">№</th>
            <th>ФИО</th>
            <th>Отдел</th>
            <th>Должность</th>
            <th>График</th>
            {canManage && <th>Оклад (договор)</th>}
            {canManage && <th>Оклад+премия</th>}
            <th className="sc-th-hist"></th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr><td colSpan={totalCols} className="sc-empty">Нет сотрудников</td></tr>
          ) : (
            <>
              {/* spacer top */}
              {virtualizer.getVirtualItems()[0]?.start > 0 && (
                <tr><td colSpan={totalCols} style={{ height: virtualizer.getVirtualItems()[0].start, padding: 0, border: 'none' }} /></tr>
              )}
              {virtualizer.getVirtualItems().map(vRow => {
                const emp = filtered[vRow.index];
                return (
                  <StaffRow
                    key={emp.id}
                    emp={emp}
                    index={vRow.index}
                    scheduleViews={scheduleViews}
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
                    onReturn={onReturn}
                  />
                );
              })}
              {/* spacer bottom */}
              {(() => {
                const items = virtualizer.getVirtualItems();
                const lastItem = items[items.length - 1];
                const remaining = lastItem ? virtualizer.getTotalSize() - lastItem.end : 0;
                return remaining > 0 ? <tr><td colSpan={totalCols} style={{ height: remaining, padding: 0, border: 'none' }} /></tr> : null;
              })()}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
});

/* ───────── Virtualized Mobile Cards ───────── */

interface IVirtualCardsProps {
  filtered: Employee[];
  scheduleViews: Map<number, IEmployeeScheduleView>;
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
  onReturn?: (emp: Employee) => void;
}

const CARD_ESTIMATE = 220;

const MobileCard: FC<{
  emp: Employee;
  scheduleViews: Map<number, IEmployeeScheduleView>;
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
  onReturn?: (emp: Employee) => void;
}> = memo(({ emp, scheduleViews, selectedIds, selectionMode, canManage, canEditDept, canEditPos, canEditSch, canOpenCard, onNavigate, onToggleSelect, onOpenModal, onOpenHistory, onRehire, onFire, onReturn }) => {
  const scheduleView = scheduleViews.get(emp.id);
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
        <span className="sc-card-label">График</span>
        <span className="sc-schedule-cell">
          <span className="sc-schedule-name">{scheduleView?.scheduleName || '—'}</span>
          {scheduleView && <span className={`sc-schedule-badge ${scheduleView.source}`}>{SCHEDULE_SOURCE_LABELS[scheduleView.source]}</span>}
        </span>
      </div>
      {canManage && (
        <div className="sc-card-row">
          <span className="sc-card-label">Оклад (дог.)</span>
          <span>{fmt(emp.salary_actual)}</span>
        </div>
      )}
      {canManage && (
        <div className="sc-card-row">
          <span className="sc-card-label">Оклад (прог.)</span>
          <span>{fmt(emp.salary_calculated)}</span>
        </div>
      )}
      <div className="sc-card-actions">
        {onReturn && emp.excluded_from_timesheet ? (
          <button className="sc-btn apply" style={{ fontSize: 12, padding: '4px 10px' }} onClick={e => { e.stopPropagation(); onReturn(emp); }}>
            Вернуть в табель
          </button>
        ) : onRehire && emp.employment_status === 'fired' ? (
          <button className="sc-btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={e => { e.stopPropagation(); onRehire(emp); }}>
            Восстановить
          </button>
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
            {canManage && (
              <button className="sc-btn-icon" title="Изменить оклад" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'salary'); }}>
                <TrendingUp size={14} />
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

const VirtualCards: FC<IVirtualCardsProps> = memo(({ filtered, scheduleViews, selectedIds, selectionMode, canManage, canEditDept, canEditPos, canEditSch, canOpenCard, onNavigate, onToggleSelect, onOpenModal, onOpenHistory, onRehire, onFire, onReturn }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_ESTIMATE,
    overscan: 5,
    gap: 4,
  });

  return (
    <div className="sc-cards" ref={scrollRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vRow => {
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
                scheduleViews={scheduleViews}
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
                onReturn={onReturn}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});


/* ───────── Main Page ───────── */

export const StaffControlPage: FC = () => {
  const navigate = useNavigate();
  const [urlParams, setUrlParams] = useSearchParams();
  const isMobile = useIsMobile(768);
  const [search, setSearch] = useState(() => urlParams.get('q') || '');
  const [deptId, setDeptId] = useState(() => urlParams.get('dept') || '');
  const [scheduleFilter, setScheduleFilter] = useState(() => urlParams.get('schedule') || '');
  const [statusFilter, setStatusFilter] = useState<StaffStatusFilter>('active');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isAdmin, canEditPage, canViewPage } = useAuth();
  const canEditDept = isAdmin || canEditPage('/staff-control/department');
  const canEditPos = isAdmin || canEditPage('/staff-control/position');
  const canEditSch = isAdmin || canEditPage('/staff-control/schedule');
  const canOpenCard = isAdmin || canViewPage('/employees');
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
      setPage(1);
    }
  }, [singleManagedDeptId, deptId]);

  const { employees, departments, countsByDepartment, loading, meta, totalActive, refresh, patchEmployee } = useStaffData({
    page,
    pageSize: 100,
    search: debouncedSearch || undefined,
    departmentId: deptId || undefined,
    scheduleId: scheduleFilter || undefined,
    status: statusFilter,
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
  const visibleEmployeeIds = useMemo(() => employees.map(emp => emp.id), [employees]);
  const scheduleTemplatesQuery = useQuery({
    queryKey: ['schedules', 'templates'],
    queryFn: () => scheduleService.list(),
    staleTime: 5 * 60_000,
  });
  const employeeScheduleAssignmentsQuery = useQuery({
    queryKey: ['schedules', 'employee-assignments', visibleEmployeeIds],
    queryFn: () => scheduleService.listEmployeeAssignments(visibleEmployeeIds),
    enabled: visibleEmployeeIds.length > 0,
    placeholderData: previousData => previousData,
    staleTime: 60_000,
  });
  const scheduleTemplates = scheduleTemplatesQuery.data ?? EMPTY_SCHEDULE_TEMPLATES;
  const employeeScheduleAssignments = employeeScheduleAssignmentsQuery.data ?? EMPTY_EMPLOYEE_SCHEDULE_ASSIGNMENTS;

  const selectedEmployeeIdsVisible = useMemo(
    () => selectedEmployeeIds.filter(id => employees.some(emp => emp.id === id)),
    [selectedEmployeeIds, employees],
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

  const activeEmployeeScheduleAssignments = useMemo(() => {
    const map = new Map<number, IEmployeeScheduleAssignment>();
    for (const assignment of employeeScheduleAssignments) {
      if (!isActiveScheduleAssignment(assignment.effective_from, assignment.effective_to, today)) continue;
      if (!map.has(assignment.employee_id)) map.set(assignment.employee_id, assignment);
    }
    return map;
  }, [employeeScheduleAssignments, today]);

  const defaultSchedule = useMemo(
    () => scheduleTemplates.find(template => template.is_default) || null,
    [scheduleTemplates],
  );

  const baseScheduleViews = useMemo(() => {
    const map = new Map<number, IEmployeeScheduleView>();
    if (!defaultSchedule) return map;
    for (const emp of employees) {
      map.set(emp.id, {
        scheduleId: defaultSchedule.id,
        scheduleName: defaultSchedule.name,
        source: 'default',
        effectiveFrom: null,
      });
    }
    return map;
  }, [employees, defaultSchedule]);

  const scheduleViews = useMemo(() => {
    const map = new Map<number, IEmployeeScheduleView>();
    for (const emp of employees) {
      const personalAssignment = activeEmployeeScheduleAssignments.get(emp.id);
      if (personalAssignment?.work_schedules) {
        const isSameAsDefault = !!defaultSchedule && personalAssignment.work_schedules.id === defaultSchedule.id;
        map.set(emp.id, {
          scheduleId: personalAssignment.work_schedules.id,
          scheduleName: personalAssignment.work_schedules.name,
          source: isSameAsDefault ? 'default' : 'employee',
          effectiveFrom: isSameAsDefault ? null : personalAssignment.effective_from,
          assignmentAnchorDate: personalAssignment.anchor_date,
          assignmentId: personalAssignment.id,
          templatePatternType: personalAssignment.work_schedules.pattern_type,
        });
        continue;
      }
      const baseSchedule = baseScheduleViews.get(emp.id);
      if (baseSchedule) map.set(emp.id, baseSchedule);
    }
    return map;
  }, [employees, activeEmployeeScheduleAssignments, baseScheduleViews, defaultSchedule]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (deptId) p.set('dept', deptId);
    if (debouncedSearch) p.set('q', debouncedSearch);
    if (scheduleFilter) p.set('schedule', scheduleFilter);
    setUrlParams(p, { replace: true });
  }, [deptId, debouncedSearch, scheduleFilter, setUrlParams]);

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

  // Дерево для DepartmentTreeSelect: тот же scope-фильтр, что и allDepts,
  // но БЕЗ расплющивания (компонент сам строит раскрывающееся дерево).
  const deptTree = useMemo(
    () => (restrictToManaged
      ? filterDepartmentTreeByIds(departments, new Set(managedDepartmentIds))
      : departments),
    [departments, restrictToManaged, managedDepartmentIds],
  );

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
    if (parts.length === 0) return 'Все активные сотрудники';
    return parts.join(' • ');
  }, [deptId, scheduleFilter, debouncedSearch, allDepts, scheduleTemplates]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const handleDeptChange = useCallback((value: string) => {
    setDeptId(value);
    setPage(1);
  }, []);

  const handleScheduleFilterChange = useCallback((value: string) => {
    setScheduleFilter(value);
    setPage(1);
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

  const handleSaveSalary = useCallback(async (empId: number, val: number, type: ModalType, reason?: string, date?: string) => {
    await employeeService.changeSalary(empId, val, reason, date);
    closeModal();
    if (type === 'salary_actual') {
      patchEmployee(empId, { salary_actual: val });
    } else {
      patchEmployee(empId, { salary_calculated: val });
    }
  }, [closeModal, patchEmployee]);

  const handleSavePosition = useCallback(async (empId: number, val: string, reason?: string, date?: string) => {
    await employeeService.changePosition(empId, val, reason, date);
    closeModal();
    patchEmployee(empId, { position_name: val });
  }, [closeModal, patchEmployee]);

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
      patchEmployee(empId, {
        org_department_id: newDeptId,
        department: deptName,
        ...(isReturn ? { excluded_from_timesheet: false, excluded_from_timesheet_at: null } : {}),
      });
      if (isReturn) {
        refresh();
        toast.success('Сотрудник возвращён в табель');
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Не удалось перенести сотрудника';
      toast.error(msg);
      throw e;
    }
  }, [closeModal, patchEmployee, allDepts, toast, employees, refresh]);

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

  // Смена графика влияет на табель (норма/покраска/согласования считаются из
  // расписания). Сбрасываем кэш табеля, иначе пользователь видит старое.
  const invalidateTimesheetQueries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['timesheet-page'] });
    void queryClient.invalidateQueries({ queryKey: ['timesheet'] });
    void queryClient.invalidateQueries({ queryKey: ['timesheet-grid'] });
    void queryClient.invalidateQueries({ queryKey: ['timesheet-approval'] });
    void queryClient.invalidateQueries({ queryKey: ['employee-timesheet'] });
  }, [queryClient]);

  const handleSaveSchedule = useCallback(async (empId: number, scheduleId: string | null, effectiveFrom: string, anchorDate: string | null) => {
    try {
      if (scheduleId) {
        await scheduleService.assignEmployee(empId, {
          schedule_id: scheduleId,
          effective_from: effectiveFrom,
          anchor_date: anchorDate,
        });
      } else {
        await scheduleService.removeEmployeeAssignment(empId, effectiveFrom);
      }
      await Promise.all([
        employeeScheduleAssignmentsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ['schedules', 'employee-assignments'] }),
      ]);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      invalidateTimesheetQueries();
      toast.success(scheduleId ? 'График назначен' : 'Персональный график снят');
      closeModal();
    } catch (e) {
      // Ошибку не глотаем (раньше — «тихо ничего», модалка закрывалась):
      // показываем тост, модалку оставляем открытой для повтора.
      toast.error(e instanceof ApiError ? e.message : 'Не удалось сохранить график');
    }
  }, [closeModal, employeeScheduleAssignmentsQuery, queryClient, refresh, toast, invalidateTimesheetQueries]);

  const handleFixAssignment = useCallback(async (
    empId: number,
    data: { assignment_id: string; effective_from?: string; anchor_date?: string | null },
  ) => {
    try {
      await scheduleService.fixEmployeeAssignment(empId, data);
      await Promise.all([
        employeeScheduleAssignmentsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ['schedules', 'employee-assignments'] }),
      ]);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      invalidateTimesheetQueries();
      toast.success('Даты назначения исправлены');
      closeModal();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Не удалось исправить даты назначения');
    }
  }, [closeModal, employeeScheduleAssignmentsQuery, queryClient, refresh, toast, invalidateTimesheetQueries]);

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
    await Promise.all([
      employeeScheduleAssignmentsQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ['schedules', 'employee-assignments'] }),
    ]);
    refresh();
    void queryClient.invalidateQueries({ queryKey: ['employees'] });
    invalidateTimesheetQueries();
    setBulkScheduleOpen(false);
    setSelectedEmployeeIds([]);
    if (ids.length === 0) return;
    if (failed > 0) {
      toast.error(`Обновлено ${ok} из ${ids.length}, не удалось ${failed}.` + (sampleError ? ` Пример: ${sampleError}` : ''));
    } else {
      toast.success(`Сотрудников обновлено: ${ok}.`);
    }
  }, [applyScheduleToEmployees, employeeScheduleAssignmentsQuery, queryClient, refresh, selectedEmployees, toast, invalidateTimesheetQueries]);

  const [rehireEmp, setRehireEmp] = useState<Employee | null>(null);
  const [rehireDeptId, setRehireDeptId] = useState('');
  const [rehireInFlight, setRehireInFlight] = useState(false);

  const handleRehire = useCallback((emp: Employee) => {
    setRehireEmp(emp);
    setRehireDeptId('');
  }, []);

  const closeRehireModal = useCallback(() => {
    if (rehireInFlight) return;
    setRehireEmp(null);
    setRehireDeptId('');
  }, [rehireInFlight]);

  const handleConfirmRehire = useCallback(async () => {
    if (!rehireEmp || !rehireDeptId) return;
    setRehireInFlight(true);
    try {
      await employeeService.rehire(rehireEmp.id, rehireDeptId);
      setRehireEmp(null);
      setRehireDeptId('');
      refresh();
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Ошибка восстановления сотрудника';
      toast.error(msg);
    } finally {
      setRehireInFlight(false);
    }
  }, [rehireEmp, rehireDeptId, refresh, toast]);

  const handleFire = useCallback(async (emp: Employee) => {
    if (!confirm(`Уволить ${emp.full_name}? Сотрудник будет перемещён в папку «Уволенные» в Sigur, карты пропуска будут заблокированы.`)) return;
    try {
      await employeeService.fire(emp.id);
      refresh();
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Ошибка увольнения сотрудника';
      toast.error(msg);
    }
  }, [refresh, toast]);

  const handleFilteredBulkSaveSchedule = useCallback(async (scheduleId: string | null, effectiveFrom: string) => {
    const employeeIds = await employeeService.getFilteredIds({
      search: debouncedSearch || undefined,
      departmentId: deptId || undefined,
      status: 'active',
      view: 'list',
    });
    const { ok, failed, sampleError } = await applyScheduleToEmployees(employeeIds, scheduleId, effectiveFrom);
    await Promise.all([
      employeeScheduleAssignmentsQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ['schedules', 'employee-assignments'] }),
    ]);
    refresh();
    void queryClient.invalidateQueries({ queryKey: ['employees'] });
    invalidateTimesheetQueries();
    setBulkFilterScheduleOpen(false);
    if (employeeIds.length === 0) return;
    if (failed > 0) {
      toast.error(`Обновлено ${ok} из ${employeeIds.length}, не удалось ${failed}.` + (sampleError ? ` Пример: ${sampleError}` : ''));
    } else {
      toast.success(`Сотрудников обновлено: ${ok}.`);
    }
  }, [applyScheduleToEmployees, debouncedSearch, deptId, employeeScheduleAssignmentsQuery, queryClient, refresh, toast, invalidateTimesheetQueries]);

  const handleBrigadeBulkSaveSchedule = useCallback(async (departmentIds: string[], scheduleId: string | null, effectiveFrom: string) => {
    try {
      const result = await scheduleService.bulkApplyToBrigades({
        department_ids: departmentIds,
        action: scheduleId ? 'assign' : 'reset',
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
      await Promise.all([
        employeeScheduleAssignmentsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ['schedules', 'employee-assignments'] }),
      ]);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      invalidateTimesheetQueries();
    }
  }, [employeeScheduleAssignmentsQuery, queryClient, refresh, toast, invalidateTimesheetQueries]);

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

  const resetAddForm = () => {
    setAddForm({
      full_name: '',
      hire_date: getLocalISODate(),
      org_department_id: '',
      position_id: '',
      tab_number: '',
    });
    setAddError(null);
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
    try {
      await employeeService.create({
        full_name: addForm.full_name.trim(),
        hire_date: addForm.hire_date,
        org_department_id: addForm.org_department_id,
        position_id: addForm.position_id,
        tab_number: addForm.tab_number.trim() || null,
      });
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

  const overflowItems = useMemo<IOverflowMenuItem[]>(() => {
    if (!isAdmin) return [];
    const items: IOverflowMenuItem[] = [];
    if (statusFilter === 'active') {
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
        disabled: meta.total === 0,
      });
      items.push({
        label: 'Импорт…',
        icon: <Upload size={14} />,
        onClick: () => setShowImportModal(true),
        divideBefore: true,
      });
    }
    if (isAdmin && statusFilter !== 'excluded') {
      items.push({
        label: 'Без отдела (диагностика)',
        icon: <ShieldCheck size={14} />,
        onClick: () => { setStatusFilter('excluded'); setPage(1); },
        divideBefore: items.length > 0,
      });
    } else if (isAdmin && statusFilter === 'excluded') {
      items.push({
        label: 'Вернуться к активным',
        icon: <ShieldCheck size={14} />,
        onClick: () => { setStatusFilter('active'); setPage(1); },
      });
    }
    return items;
  }, [isAdmin, statusFilter, selectionMode, toggleSelectionMode, brigadeOptions.length, meta.total]);

  const headerCounter = useMemo(() => (
    <span className="sc-page-counter sc-page-counter--in-header">
      {meta.total}{statusFilter === 'active' ? ` из ${totalActive}` : ''}
    </span>
  ), [meta.total, statusFilter, totalActive]);
  useHeaderAddon(headerCounter);

  const controlsBar = (
    <div className="sc-filters">
      {isSingleManagedDept ? (
        <div className="sc-dept-fixed" title="Вам назначен один отдел">
          {singleManagedDeptName ?? 'Мой отдел'}
        </div>
      ) : (
        <DepartmentTreeSelect
          departments={deptTree}
          value={deptId}
          onChange={handleDeptChange}
          isLoading={structureTree.isPending}
          isError={structureTree.isError}
          onRetry={() => { void structureTree.refetch(); }}
        />
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
      {isAdmin && statusFilter !== 'excluded' && (
        <div className="sc-segmented" role="tablist" aria-label="Статус сотрудников">
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'active'}
            className={`sc-seg-btn${statusFilter === 'active' ? ' is-active' : ''}`}
            onClick={() => { setStatusFilter('active'); setPage(1); }}
          >
            Активные
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'fired'}
            className={`sc-seg-btn${statusFilter === 'fired' ? ' is-active' : ''}`}
            onClick={() => { setStatusFilter('fired'); setPage(1); }}
          >
            Уволенные
          </button>
        </div>
      )}
      {isAdmin && statusFilter === 'excluded' && (
        <div className="sc-segmented" aria-label="Режим диагностики">
          <button type="button" className="sc-seg-btn is-active" disabled>
            Без отдела (диагностика)
          </button>
        </div>
      )}
      {isAdmin && (
        <div className="sc-page-actions">
          {statusFilter === 'active' && (
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

      {loading ? (
        <div className="sc-loading">Загрузка...</div>
      ) : isMobile ? (
        <VirtualCards
          filtered={employees}
          scheduleViews={scheduleViews}
          selectedIds={selectedEmployeeIdSet}
          selectionMode={selectionMode}
          canManage={isAdmin}
          canEditDept={canEditDept}
          canEditPos={canEditPos}
          canEditSch={canEditSch}
          canOpenCard={canOpenCard}
          onNavigate={handleNavigate}
          onToggleSelect={toggleSelectEmployee}
          onOpenModal={openModal}
          onOpenHistory={openHistory}
          onRehire={statusFilter === 'fired' && isAdmin ? handleRehire : undefined}
          onFire={statusFilter === 'active' && isAdmin ? handleFire : undefined}
          onReturn={statusFilter === 'excluded' ? handleReturnToTimesheet : undefined}
        />
      ) : (
        <VirtualTable
          filtered={employees}
          scheduleViews={scheduleViews}
          selectedIds={selectedEmployeeIdSet}
          selectionMode={selectionMode}
          canManage={isAdmin}
          canEditDept={canEditDept}
          canEditPos={canEditPos}
          canEditSch={canEditSch}
          canOpenCard={canOpenCard}
          onNavigate={handleNavigate}
          onToggleSelect={toggleSelectEmployee}
          onToggleSelectAll={toggleSelectAllVisible}
          allSelected={allVisibleSelected}
          onOpenModal={openModal}
          onOpenHistory={openHistory}
          onRehire={statusFilter === 'fired' && isAdmin ? handleRehire : undefined}
          onFire={statusFilter === 'active' && isAdmin ? handleFire : undefined}
          onReturn={statusFilter === 'excluded' ? handleReturnToTimesheet : undefined}
        />
      )}

      {/* Pagination */}
      {meta.totalPages > 1 && (
        <div className="sc-pagination">
          <button className="sc-btn cancel" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Назад</button>
          <span className="sc-pagination-info">{page} / {meta.totalPages}</span>
          <button className="sc-btn cancel" disabled={page >= meta.totalPages} onClick={() => setPage(p => p + 1)}>Вперёд →</button>
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
        allDepts={allDepts}
        templates={scheduleTemplates}
        scheduleViews={scheduleViews}
        baseScheduleViews={baseScheduleViews}
        onClose={closeModal}
        onSaveSalary={handleSaveSalary}
        onSavePosition={handleSavePosition}
        onSaveDepartment={handleSaveDepartment}
        onSaveSchedule={handleSaveSchedule}
        onFixAssignment={handleFixAssignment}
      />
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
        targetCount={meta.total}
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
            onSalaryFile={handleSalaryFile}
            onSalaryHistoryFile={handleSalaryHistoryFile}
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

      {/* ─── Add Employee Modal ─── */}
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

      {/* ─── Rehire Modal ─── */}
      {rehireEmp && (
        <div className="sc-overlay" onClick={closeRehireModal}>
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
            </div>
            <div className="sc-modal-footer">
              <button className="sc-btn cancel" onClick={closeRehireModal} disabled={rehireInFlight}>Отмена</button>
              <button
                className="sc-btn apply"
                onClick={handleConfirmRehire}
                disabled={!rehireDeptId || rehireInFlight}
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
