import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef, memo, type FC, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Pencil, ArrowRightLeft, History, TrendingUp, Upload, UserPlus, Calendar, UserRoundX, ShieldCheck } from 'lucide-react';
import { SearchInput } from '../components/ui/SearchInput';
import { employeeService } from '../services/employeeService';
import { ApiError } from '../api/client';
import { scheduleService } from '../services/scheduleService';
import { workCategoryService } from '../services/workCategoryService';
import type {
  IWorkCategory,
  IWorkSchedule,
  ICategorySchedule,
  IEmployeeScheduleAssignment,
} from '../types/schedule';
import { useIsMobile } from '../hooks/useIsMobile';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useStaffData } from '../hooks/useStaffData';
import { useStructureTree } from '../hooks/useStructure';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { DeptSelect } from '../components/staff/DeptSelect';
import type { Employee, EmployeeHistoryEvent, EnrichPreview, ContactsEnrichPreview } from '../types';
import { structureApi } from '../api/structure';
import type { IFlatDepartmentOption } from '../utils/departmentUtils';
import { getTreeFlatDepartments } from '../utils/departmentUtils';
import '../styles/StaffControlPage.css';

const HistoryPanel = lazy(() => import('../components/staff/HistoryPanel').then(m => ({ default: m.HistoryPanel })));
const ImportModal = lazy(() => import('../components/employees/ImportModal').then(m => ({ default: m.ImportModal })));
const EnrichPreviewModal = lazy(() => import('../components/employees/EnrichPreviewModal').then(m => ({ default: m.EnrichPreviewModal })));

const fmt = (n: number | null | undefined) =>
  n ? n.toLocaleString('ru-RU') + ' ₽' : '—';

const getLocalISODate = (): string => {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
};

const isActiveScheduleAssignment = (effectiveFrom: string, effectiveTo: string | null, date: string): boolean =>
  effectiveFrom <= date && (effectiveTo === null || effectiveTo >= date);

type ModalType = 'salary' | 'salary_actual' | 'position' | 'department' | 'category' | 'schedule';

type ScheduleSource = 'employee' | 'category' | 'default';

interface IEmployeeScheduleView {
  scheduleId: string | null;
  scheduleName: string;
  source: ScheduleSource;
  effectiveFrom?: string | null;
}

interface IBrigadeOption extends IFlatDepartmentOption {
  employeeCount: number;
}

interface IAddEmployeeForm {
  full_name: string;
  hire_date: string;
  org_department_id: string;
  position_id: string;
  tab_number: string;
}

const SCHEDULE_SOURCE_LABELS: Record<ScheduleSource, string> = {
  employee: 'инд.',
  category: 'кат.',
  default: 'деф.',
};
const EMPTY_WORK_CATEGORIES: IWorkCategory[] = [];
const EMPTY_SCHEDULE_TEMPLATES: IWorkSchedule[] = [];
const EMPTY_CATEGORY_ASSIGNMENTS: ICategorySchedule[] = [];
const EMPTY_EMPLOYEE_SCHEDULE_ASSIGNMENTS: IEmployeeScheduleAssignment[] = [];

/* ───────── Memoized table row ───────── */

interface IStaffRowProps {
  emp: Employee;
  index: number;
  categoryLabels: Map<string, string>;
  scheduleViews: Map<number, IEmployeeScheduleView>;
  selectedIds: Set<number>;
  onNavigate: (emp: Employee) => void;
  onToggleSelect: (empId: number) => void;
  onOpenModal: (emp: Employee, type: ModalType) => void;
  onOpenHistory: (emp: Employee) => void;
  onRehire?: (emp: Employee) => void;
  onFire?: (emp: Employee) => void;
}

const openEmployeeInNewTab = (empId: number) => {
  window.open(`/employees/${empId}`, '_blank', 'noopener,noreferrer');
};

const handleMiddleClickMouseDown = (e: ReactMouseEvent) => {
  // Отключаем авто-скролл в браузере на нажатии колеса, чтобы отработал onAuxClick.
  if (e.button === 1) e.preventDefault();
};

const StaffRow: FC<IStaffRowProps> = memo(({ emp, index, categoryLabels, scheduleViews, selectedIds, onNavigate, onToggleSelect, onOpenModal, onOpenHistory, onRehire, onFire }) => {
  const scheduleView = scheduleViews.get(emp.id);
  const isSelected = selectedIds.has(emp.id);

  const handleAuxClick = (e: ReactMouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      openEmployeeInNewTab(emp.id);
    }
  };

  return (
    <tr
      className={`sc-row${isSelected ? ' sc-row--selected' : ''}`}
      onClick={() => onNavigate(emp)}
      onAuxClick={handleAuxClick}
      onMouseDown={handleMiddleClickMouseDown}
    >
      <td className="sc-td-check" onClick={e => e.stopPropagation()}>
        <input
          className="sc-check"
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(emp.id)}
          aria-label={`Выбрать ${emp.full_name}`}
        />
      </td>
      <td className="sc-td-num">{index + 1}</td>
      <td className="sc-td-name">{emp.full_name}</td>
      <td>
        <span className="sc-cell-with-btn">
          {emp.department || '—'}
          <button className="sc-inline-btn" title="Сменить отдел" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'department'); }}>
            <ArrowRightLeft size={12} />
          </button>
        </span>
      </td>
      <td>
        <span className="sc-cell-with-btn">
          <button className="sc-inline-btn" title="Сменить должность" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'position'); }}>
            <Pencil size={12} />
          </button>
          {emp.position_name || '—'}
        </span>
      </td>
      <td>
        <span className="sc-cell-with-btn">
          <button className="sc-inline-btn" title="Изменить категорию труда" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'category'); }}>
            <Pencil size={12} />
          </button>
          {emp.work_category ? categoryLabels.get(emp.work_category) || emp.work_category : '—'}
        </span>
      </td>
      <td>
        <span className="sc-cell-with-btn">
          <button className="sc-inline-btn" title="Назначить график" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'schedule'); }}>
            <Calendar size={12} />
          </button>
          <span className="sc-schedule-cell">
            <span className="sc-schedule-name">{scheduleView?.scheduleName || '—'}</span>
            {scheduleView && <span className={`sc-schedule-badge ${scheduleView.source}`}>{SCHEDULE_SOURCE_LABELS[scheduleView.source]}</span>}
          </span>
        </span>
      </td>
      <td className="sc-td-salary">
        <span className="sc-cell-with-btn">
          <button className="sc-inline-btn" title="Изменить оклад (договор)" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'salary_actual'); }}>
            <Pencil size={12} />
          </button>
          {fmt(emp.salary_actual)}
        </span>
      </td>
      <td className="sc-td-salary">
        <span className="sc-cell-with-btn">
          <button className="sc-inline-btn" title="Изменить реальный оклад" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'salary'); }}>
            <Pencil size={12} />
          </button>
          {fmt(emp.salary_calculated)}
        </span>
      </td>
      <td className="sc-td-hist" onClick={e => e.stopPropagation()}>
        {onRehire && emp.employment_status === 'fired' ? (
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
            <button className="sc-btn-icon" title="История" onClick={() => onOpenHistory(emp)}>
              <History size={14} />
            </button>
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
  categories: IWorkCategory[];
  templates: IWorkSchedule[];
  scheduleViews: Map<number, IEmployeeScheduleView>;
  baseScheduleViews: Map<number, IEmployeeScheduleView>;
  onClose: () => void;
  onSaveSalary: (empId: number, val: number, type: ModalType, reason?: string, date?: string) => Promise<void>;
  onSavePosition: (empId: number, val: string, reason?: string, date?: string) => Promise<void>;
  onSaveDepartment: (empId: number, deptId: string) => Promise<void>;
  onSaveCategory: (empId: number, category: string | null) => Promise<void>;
  onSaveSchedule: (empId: number, scheduleId: string | null, effectiveFrom: string) => Promise<void>;
}

const StaffModals: FC<IStaffModalsProps> = memo(({
  modalType,
  modalEmp,
  allDepts,
  categories,
  templates,
  scheduleViews,
  baseScheduleViews,
  onClose,
  onSaveSalary,
  onSavePosition,
  onSaveDepartment,
  onSaveCategory,
  onSaveSchedule,
}) => {
  const currentSchedule = modalEmp ? scheduleViews.get(modalEmp.id) : undefined;
  const [salaryVal, setSalaryVal] = useState('');
  const [salaryDate, setSalaryDate] = useState(() => getLocalISODate());
  const [salaryReason, setSalaryReason] = useState('');
  const [positionVal, setPositionVal] = useState('');
  const [positionDate, setPositionDate] = useState(() => getLocalISODate());
  const [positionReason, setPositionReason] = useState('');
  const [deptVal, setDeptVal] = useState(() => modalEmp?.org_department_id || '');
  const [categoryVal, setCategoryVal] = useState<string>(() => modalEmp?.work_category || '');
  const [scheduleVal, setScheduleVal] = useState(() => currentSchedule?.source === 'employee' ? currentSchedule.scheduleId || '' : '');
  const [scheduleDate, setScheduleDate] = useState(() => currentSchedule?.source === 'employee' ? currentSchedule.effectiveFrom || getLocalISODate() : getLocalISODate());
  const [saving, setSaving] = useState(false);

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
      await onSaveDepartment(modalEmp.id, deptVal);
    } catch {
      // ошибка уже показана в верхнем хендлере через toast
    } finally {
      setSaving(false);
    }
  };

  const handleCategory = async () => {
    setSaving(true);
    const value = categoryVal === '' ? null : categoryVal;
    await onSaveCategory(modalEmp.id, value);
    setSaving(false);
  };

  const handleSchedule = async () => {
    setSaving(true);
    const value = scheduleVal === '' ? null : scheduleVal;
    await onSaveSchedule(modalEmp.id, value, scheduleDate);
    setSaving(false);
  };

  if (modalType === 'salary' || modalType === 'salary_actual') {
    const title = modalType === 'salary' ? 'Изменить реальный оклад' : 'Изменить оклад (договор)';
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

  if (modalType === 'category') {
    return (
      <div className="sc-overlay" onClick={onClose}>
        <div className="sc-modal" onClick={e => e.stopPropagation()}>
          <div className="sc-modal-header">
            <h3>Категория труда — {modalEmp.full_name}</h3>
            <button className="sc-modal-close" onClick={onClose}>&times;</button>
          </div>
          <div className="sc-modal-body">
            <div className="sc-field">
              <label>Категория</label>
              <select value={categoryVal} onChange={e => setCategoryVal(e.target.value)} autoFocus>
                <option value="">— не назначена —</option>
                {categories.filter(c => c.is_active).map(c => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              График работы подтянется автоматически по привязке категории. Индивидуальный график
              сотрудника, если задан, имеет приоритет.
            </div>
          </div>
          <div className="sc-modal-footer">
            <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
            <button
              className="sc-btn apply"
              onClick={handleCategory}
              disabled={saving || (categoryVal || '') === (modalEmp.work_category || '')}
            >
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
    const hasEmployeeOverride = effectiveSchedule?.source === 'employee';
    const currentEmployeeScheduleId = effectiveSchedule?.source === 'employee' ? effectiveSchedule.scheduleId || '' : '';
    const currentEmployeeScheduleDate = effectiveSchedule?.source === 'employee' ? effectiveSchedule.effectiveFrom || getLocalISODate() : getLocalISODate();
    return (
      <div className="sc-overlay" onClick={onClose}>
        <div className="sc-modal" onClick={e => e.stopPropagation()}>
          <div className="sc-modal-header">
            <h3>График работы — {modalEmp.full_name}</h3>
            <button className="sc-modal-close" onClick={onClose}>&times;</button>
          </div>
          <div className="sc-modal-body">
            <div className="sc-field">
              <label>Персональный график</label>
              <select value={scheduleVal} onChange={e => setScheduleVal(e.target.value)} autoFocus>
                <option value="">— по категории труда —</option>
                {templates.map(tpl => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
            </div>
            <div className="sc-field">
              <label>{scheduleVal ? 'Дата вступления в силу' : 'Дата снятия персонального графика'}</label>
              <input type="date" value={scheduleDate} onChange={e => setScheduleDate(e.target.value)} />
            </div>
            <div className="sc-schedule-help">
              <div><strong>Сейчас действует:</strong> {effectiveSchedule?.scheduleName || '—'}{effectiveSchedule ? ` (${SCHEDULE_SOURCE_LABELS[effectiveSchedule.source]})` : ''}</div>
              <div><strong>Базовый график:</strong> {baseSchedule?.scheduleName || 'дефолтный график'}</div>
              <div>Если оставить пусто, с выбранной даты сотрудник вернётся к графику своей категории труда.</div>
            </div>
          </div>
          <div className="sc-modal-footer">
            <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
            <button
              className="sc-btn apply"
              onClick={handleSchedule}
              disabled={saving || !scheduleDate || (!hasEmployeeOverride && scheduleVal === '') || ((scheduleVal || '') === currentEmployeeScheduleId && scheduleDate === currentEmployeeScheduleDate)}
            >
              {saving ? 'Сохранение...' : 'Применить'}
            </button>
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
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
          <button className="sc-btn apply" onClick={handleDepartment} disabled={!deptVal || deptVal === modalEmp.org_department_id || saving}>
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
  categoryLabels: Map<string, string>;
  scheduleViews: Map<number, IEmployeeScheduleView>;
  selectedIds: Set<number>;
  onNavigate: (emp: Employee) => void;
  onToggleSelect: (empId: number) => void;
  onToggleSelectAll: () => void;
  allSelected: boolean;
  onOpenModal: (emp: Employee, type: ModalType) => void;
  onOpenHistory: (emp: Employee) => void;
  onRehire?: (emp: Employee) => void;
  onFire?: (emp: Employee) => void;
}

const ROW_HEIGHT = 36;

const VirtualTable: FC<IVirtualTableProps> = memo(({
  filtered,
  categoryLabels,
  scheduleViews,
  selectedIds,
  onNavigate,
  onToggleSelect,
  onToggleSelectAll,
  allSelected,
  onOpenModal,
  onOpenHistory,
  onRehire,
  onFire,
}) => {
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
            <th className="sc-th-check">
              <input
                className="sc-check"
                type="checkbox"
                checked={allSelected}
                onChange={onToggleSelectAll}
                aria-label="Выбрать всех сотрудников на странице"
              />
            </th>
            <th className="sc-th-num">№</th>
            <th>ФИО</th>
            <th>Отдел</th>
            <th>Должность</th>
            <th>Категория</th>
            <th>График</th>
            <th>Оклад (договор)</th>
            <th>Реальный оклад</th>
            <th className="sc-th-hist"></th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr><td colSpan={10} className="sc-empty">Нет сотрудников</td></tr>
          ) : (
            <>
              {/* spacer top */}
              {virtualizer.getVirtualItems()[0]?.start > 0 && (
                <tr><td colSpan={10} style={{ height: virtualizer.getVirtualItems()[0].start, padding: 0, border: 'none' }} /></tr>
              )}
              {virtualizer.getVirtualItems().map(vRow => {
                const emp = filtered[vRow.index];
                return (
                  <StaffRow
                    key={emp.id}
                    emp={emp}
                    index={vRow.index}
                    categoryLabels={categoryLabels}
                    scheduleViews={scheduleViews}
                    selectedIds={selectedIds}
                    onNavigate={onNavigate}
                    onToggleSelect={onToggleSelect}
                    onOpenModal={onOpenModal}
                    onOpenHistory={onOpenHistory}
                    onRehire={onRehire}
                    onFire={onFire}
                  />
                );
              })}
              {/* spacer bottom */}
              {(() => {
                const items = virtualizer.getVirtualItems();
                const lastItem = items[items.length - 1];
                const remaining = lastItem ? virtualizer.getTotalSize() - lastItem.end : 0;
                return remaining > 0 ? <tr><td colSpan={10} style={{ height: remaining, padding: 0, border: 'none' }} /></tr> : null;
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
  categoryLabels: Map<string, string>;
  scheduleViews: Map<number, IEmployeeScheduleView>;
  selectedIds: Set<number>;
  onNavigate: (emp: Employee) => void;
  onToggleSelect: (empId: number) => void;
  onOpenModal: (emp: Employee, type: ModalType) => void;
  onOpenHistory: (emp: Employee) => void;
  onRehire?: (emp: Employee) => void;
  onFire?: (emp: Employee) => void;
}

const CARD_HEIGHT = 270;

const MobileCard: FC<{
  emp: Employee;
  categoryLabels: Map<string, string>;
  scheduleViews: Map<number, IEmployeeScheduleView>;
  selectedIds: Set<number>;
  onNavigate: (emp: Employee) => void;
  onToggleSelect: (empId: number) => void;
  onOpenModal: (emp: Employee, type: ModalType) => void;
  onOpenHistory: (emp: Employee) => void;
  onRehire?: (emp: Employee) => void;
  onFire?: (emp: Employee) => void;
}> = memo(({ emp, categoryLabels, scheduleViews, selectedIds, onNavigate, onToggleSelect, onOpenModal, onOpenHistory, onRehire, onFire }) => {
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
      onClick={() => onNavigate(emp)}
      onAuxClick={handleAuxClick}
      onMouseDown={handleMiddleClickMouseDown}
    >
      <div className="sc-card-head">
        <div className="sc-card-name">{emp.full_name}</div>
        <div className="sc-card-check" onClick={e => e.stopPropagation()}>
          <input
            className="sc-check"
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect(emp.id)}
            aria-label={`Выбрать ${emp.full_name}`}
          />
        </div>
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
        <span className="sc-card-label">Категория</span>
        <span>{emp.work_category ? categoryLabels.get(emp.work_category) || emp.work_category : '—'}</span>
      </div>
      <div className="sc-card-row">
        <span className="sc-card-label">График</span>
        <span className="sc-schedule-cell">
          <span className="sc-schedule-name">{scheduleView?.scheduleName || '—'}</span>
          {scheduleView && <span className={`sc-schedule-badge ${scheduleView.source}`}>{SCHEDULE_SOURCE_LABELS[scheduleView.source]}</span>}
        </span>
      </div>
      <div className="sc-card-row">
        <span className="sc-card-label">Оклад (дог.)</span>
        <span>{fmt(emp.salary_actual)}</span>
      </div>
      <div className="sc-card-row">
        <span className="sc-card-label">Оклад (прог.)</span>
        <span>{fmt(emp.salary_calculated)}</span>
      </div>
      <div className="sc-card-actions">
        {onRehire && emp.employment_status === 'fired' ? (
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
            <button className="sc-btn-icon" title="История" onClick={e => { e.stopPropagation(); onOpenHistory(emp); }}>
              <History size={14} />
            </button>
            <button className="sc-btn-icon" title="Сменить должность" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'position'); }}>
              <Pencil size={14} />
            </button>
            <button className="sc-btn-icon" title="Категория труда" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'category'); }}>
              <Pencil size={14} />
            </button>
            <button className="sc-btn-icon" title="Назначить график" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'schedule'); }}>
              <Calendar size={14} />
            </button>
            <button className="sc-btn-icon" title="Изменить оклад" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'salary'); }}>
              <TrendingUp size={14} />
            </button>
            <button className="sc-btn-icon" title="Сменить отдел" onClick={e => { e.stopPropagation(); onOpenModal(emp, 'department'); }}>
              <ArrowRightLeft size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
});

const VirtualCards: FC<IVirtualCardsProps> = memo(({ filtered, categoryLabels, scheduleViews, selectedIds, onNavigate, onToggleSelect, onOpenModal, onOpenHistory, onRehire, onFire }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_HEIGHT,
    overscan: 5,
  });

  return (
    <div className="sc-cards" ref={scrollRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vRow => {
          const emp = filtered[vRow.index];
          return (
            <div key={emp.id} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vRow.start}px)` }}>
              <MobileCard
                emp={emp}
                categoryLabels={categoryLabels}
                scheduleViews={scheduleViews}
                selectedIds={selectedIds}
                onNavigate={onNavigate}
                onToggleSelect={onToggleSelect}
                onOpenModal={onOpenModal}
                onOpenHistory={onOpenHistory}
                onRehire={onRehire}
                onFire={onFire}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

interface IBulkScheduleModalProps {
  open: boolean;
  targetCount: number;
  targetLabel: string;
  previewText: string;
  templates: IWorkSchedule[];
  onClose: () => void;
  onApply: (scheduleId: string | null, effectiveFrom: string) => Promise<void>;
}

const BulkScheduleModal: FC<IBulkScheduleModalProps> = memo(({ open, targetCount, targetLabel, previewText, templates, onClose, onApply }) => {
  const [mode, setMode] = useState<'assign' | 'reset'>('assign');
  const [scheduleId, setScheduleId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => getLocalISODate());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('assign');
    setScheduleId('');
    setEffectiveFrom(getLocalISODate());
    setSaving(false);
  }, [open, targetCount, previewText]);

  if (!open) return null;

  const handleApply = async () => {
    if (!effectiveFrom) return;
    if (mode === 'assign' && !scheduleId) return;
    setSaving(true);
    try {
      await onApply(mode === 'assign' ? scheduleId : null, effectiveFrom);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sc-overlay" onClick={onClose}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Массовое назначение графика</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <div className="sc-field">
            <label>Действие</label>
            <select value={mode} onChange={e => setMode(e.target.value as 'assign' | 'reset')} autoFocus>
              <option value="assign">Назначить персональный график</option>
              <option value="reset">Вернуть к графику категории</option>
            </select>
          </div>
          {mode === 'assign' && (
            <div className="sc-field">
              <label>Шаблон графика</label>
              <select value={scheduleId} onChange={e => setScheduleId(e.target.value)}>
                <option value="">Выберите график</option>
                {templates.map(tpl => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="sc-field">
            <label>{mode === 'assign' ? 'Дата вступления в силу' : 'Дата снятия персонального графика'}</label>
            <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} />
          </div>
          <div className="sc-schedule-help">
            <div><strong>{targetLabel}:</strong> {targetCount}</div>
            <div>{previewText}</div>
            <div>
              {mode === 'assign'
                ? 'С выбранной даты персональный график будет назначен всем сотрудникам из выбранной области.'
                : 'С выбранной даты персональный график будет снят, и сотрудники вернутся к графику своей категории труда.'}
            </div>
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
          <button className="sc-btn apply" onClick={handleApply} disabled={saving || !effectiveFrom || (mode === 'assign' && !scheduleId)}>
            {saving ? 'Сохранение...' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  );
});

interface IBulkCategoryModalProps {
  open: boolean;
  targetCount: number;
  categories: IWorkCategory[];
  onClose: () => void;
  onApply: (categoryCode: string | null) => Promise<void>;
}

const BulkCategoryModal: FC<IBulkCategoryModalProps> = memo(({ open, targetCount, categories, onClose, onApply }) => {
  const [categoryCode, setCategoryCode] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCategoryCode('');
    setSaving(false);
  }, [open, targetCount]);

  if (!open) return null;

  const handleApply = async () => {
    setSaving(true);
    try {
      await onApply(categoryCode || null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sc-overlay" onClick={onClose}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Массовое назначение категории</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <div className="sc-field">
            <label>Категория труда</label>
            <select value={categoryCode} onChange={e => setCategoryCode(e.target.value)} autoFocus>
              <option value="">— не назначена —</option>
              {categories.filter(c => c.is_active).map(c => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="sc-schedule-help">
            <div><strong>Выбрано сотрудников:</strong> {targetCount}</div>
            <div>Категория будет назначена всем выбранным сотрудникам.</div>
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
          <button className="sc-btn apply" onClick={handleApply} disabled={saving}>
            {saving ? 'Сохранение...' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  );
});

interface IBulkBrigadeScheduleModalProps {
  open: boolean;
  brigades: IBrigadeOption[];
  templates: IWorkSchedule[];
  onClose: () => void;
  onApply: (departmentIds: string[], scheduleId: string | null, effectiveFrom: string) => Promise<void>;
}

const BulkBrigadeScheduleModal: FC<IBulkBrigadeScheduleModalProps> = memo(({
  open,
  brigades,
  templates,
  onClose,
  onApply,
}) => {
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'assign' | 'reset'>('assign');
  const [scheduleId, setScheduleId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => getLocalISODate());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelectedIds([]);
    setMode('assign');
    setScheduleId('');
    setEffectiveFrom(getLocalISODate());
    setSaving(false);
  }, [open]);

  const filteredBrigades = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return brigades;
    return brigades.filter(brigade => brigade.name.toLowerCase().includes(normalized));
  }, [brigades, search]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedBrigades = useMemo(
    () => brigades.filter(brigade => selectedIdSet.has(brigade.id)),
    [brigades, selectedIdSet],
  );
  const selectedEmployeeCount = useMemo(
    () => selectedBrigades.reduce((total, brigade) => total + brigade.employeeCount, 0),
    [selectedBrigades],
  );
  const selectedPreview = useMemo(() => {
    const names = selectedBrigades.slice(0, 3).map(brigade => brigade.name);
    const rest = Math.max(0, selectedBrigades.length - names.length);
    if (names.length === 0) return 'Бригады не выбраны';
    return rest > 0 ? `${names.join(', ')} и ещё ${rest}` : names.join(', ');
  }, [selectedBrigades]);

  if (!open) return null;

  const toggleBrigade = (brigadeId: string) => {
    setSelectedIds(prev => (
      prev.includes(brigadeId)
        ? prev.filter(id => id !== brigadeId)
        : [...prev, brigadeId]
    ));
  };

  const selectAllFiltered = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      filteredBrigades.forEach(brigade => next.add(brigade.id));
      return Array.from(next);
    });
  };

  const clearSelection = () => {
    setSelectedIds([]);
  };

  const handleApply = async () => {
    if (!effectiveFrom || selectedIds.length === 0 || selectedEmployeeCount === 0) return;
    if (mode === 'assign' && !scheduleId) return;

    setSaving(true);
    try {
      await onApply(selectedIds, mode === 'assign' ? scheduleId : null, effectiveFrom);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sc-overlay" onClick={onClose}>
      <div className="sc-modal sc-modal--wide" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Массовое назначение графика по бригадам</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body sc-brigade-modal">
          <div className="sc-brigade-panel">
            <div className="sc-field">
              <label>Поиск бригады</label>
              <SearchInput
                value={search}
                onValueChange={setSearch}
                placeholder="Поиск по названию бригады..."
                autoFocus
              />
            </div>
            <div className="sc-brigade-toolbar">
              <div className="sc-brigade-toolbar-actions">
                <button className="sc-btn secondary" type="button" onClick={selectAllFiltered} disabled={filteredBrigades.length === 0}>
                  Выбрать все бригады
                </button>
                <button className="sc-btn cancel" type="button" onClick={clearSelection} disabled={selectedIds.length === 0}>
                  Снять выбор
                </button>
              </div>
              <div className="sc-brigade-toolbar-meta">
                Выбрано: <strong>{selectedBrigades.length}</strong>
              </div>
            </div>
            <div className="sc-brigade-list">
              {filteredBrigades.length === 0 ? (
                <div className="sc-brigade-empty">Нет доступных бригад по текущему поиску.</div>
              ) : (
                filteredBrigades.map(brigade => {
                  const isSelected = selectedIdSet.has(brigade.id);
                  return (
                    <label key={brigade.id} className={`sc-brigade-item ${isSelected ? 'sc-brigade-item--selected' : ''}`}>
                      <div className="sc-brigade-item-main">
                        <input
                          className="sc-check"
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleBrigade(brigade.id)}
                          aria-label={`Выбрать ${brigade.name}`}
                        />
                        <div className="sc-brigade-item-labels">
                          <span
                            className="sc-brigade-item-name"
                            style={{ paddingLeft: `${brigade.level * 14}px` }}
                          >
                            {brigade.name}
                          </span>
                          <span className="sc-brigade-item-hint">Точный отдел без вложенных подразделений</span>
                        </div>
                      </div>
                      <span className="sc-brigade-item-count">{brigade.employeeCount}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          <div className="sc-brigade-panel">
            <div className="sc-field">
              <label>Действие</label>
              <select value={mode} onChange={e => setMode(e.target.value as 'assign' | 'reset')}>
                <option value="assign">Назначить персональный график</option>
                <option value="reset">Вернуть к графику категории</option>
              </select>
            </div>
            {mode === 'assign' && (
              <div className="sc-field">
                <label>Шаблон графика</label>
                <select value={scheduleId} onChange={e => setScheduleId(e.target.value)}>
                  <option value="">Выберите график</option>
                  {templates.map(tpl => (
                    <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="sc-field">
              <label>{mode === 'assign' ? 'Дата вступления в силу' : 'Дата снятия персонального графика'}</label>
              <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="sc-schedule-help">
              <div><strong>Выбрано бригад:</strong> {selectedBrigades.length}</div>
              <div><strong>Активных сотрудников:</strong> {selectedEmployeeCount}</div>
              <div><strong>Состав:</strong> {selectedPreview}</div>
              <div>
                {mode === 'assign'
                  ? 'С выбранной даты персональный график будет назначен всем текущим активным сотрудникам выбранных бригад.'
                  : 'С выбранной даты персональный график будет снят, и сотрудники вернутся к графику своей категории труда.'}
              </div>
            </div>
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
          <button
            className="sc-btn apply"
            onClick={handleApply}
            disabled={saving || selectedIds.length === 0 || selectedEmployeeCount === 0 || !effectiveFrom || (mode === 'assign' && !scheduleId)}
          >
            {saving ? 'Применение...' : 'Применить'}
          </button>
        </div>
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
  const [statusFilter, setStatusFilter] = useState<'active' | 'fired'>('active');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isAdmin, profile } = useAuth();
  const managedDepartmentIds = useMemo(() => profile?.managed_department_ids ?? [], [profile]);
  const restrictToManaged = !isAdmin && managedDepartmentIds.length > 0;

  const { employees, departments, countsByDepartment, loading, meta, totalActive, refresh, patchEmployee } = useStaffData({
    page,
    pageSize: 100,
    search: debouncedSearch || undefined,
    departmentId: deptId || undefined,
    status: statusFilter,
  });

  const structureTree = useStructureTree();
  const archiveDepartmentId = structureTree.data?.stats.archive_department_id ?? null;

  const today = getLocalISODate();
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<number[]>([]);
  const [bulkScheduleOpen, setBulkScheduleOpen] = useState(false);
  const [bulkFilterScheduleOpen, setBulkFilterScheduleOpen] = useState(false);
  const [bulkBrigadeScheduleOpen, setBulkBrigadeScheduleOpen] = useState(false);
  const [bulkCategoryOpen, setBulkCategoryOpen] = useState(false);
  const visibleEmployeeIds = useMemo(() => employees.map(emp => emp.id), [employees]);
  const workCategoriesQuery = useQuery({
    queryKey: ['work-categories'],
    queryFn: () => workCategoryService.list(),
    staleTime: 5 * 60_000,
  });
  const scheduleTemplatesQuery = useQuery({
    queryKey: ['schedules', 'templates'],
    queryFn: () => scheduleService.list(),
    staleTime: 5 * 60_000,
  });
  const categoryAssignmentsQuery = useQuery({
    queryKey: ['schedules', 'category-assignments'],
    queryFn: () => scheduleService.listCategories(),
    staleTime: 5 * 60_000,
  });
  const employeeScheduleAssignmentsQuery = useQuery({
    queryKey: ['schedules', 'employee-assignments', visibleEmployeeIds],
    queryFn: () => scheduleService.listEmployeeAssignments(visibleEmployeeIds),
    enabled: visibleEmployeeIds.length > 0,
    placeholderData: previousData => previousData,
    staleTime: 60_000,
  });
  const workCategories = workCategoriesQuery.data ?? EMPTY_WORK_CATEGORIES;
  const scheduleTemplates = scheduleTemplatesQuery.data ?? EMPTY_SCHEDULE_TEMPLATES;
  const categoryAssignments = categoryAssignmentsQuery.data ?? EMPTY_CATEGORY_ASSIGNMENTS;
  const employeeScheduleAssignments = employeeScheduleAssignmentsQuery.data ?? EMPTY_EMPLOYEE_SCHEDULE_ASSIGNMENTS;

  const categoryLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of workCategories) m.set(c.code, c.name);
    return m;
  }, [workCategories]);

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

  const activeCategoryAssignments = useMemo(() => {
    const map = new Map<string, ICategorySchedule>();
    for (const assignment of categoryAssignments) {
      if (!isActiveScheduleAssignment(assignment.effective_from, assignment.effective_to, today)) continue;
      if (!map.has(assignment.category)) map.set(assignment.category, assignment);
    }
    return map;
  }, [categoryAssignments, today]);

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
    for (const emp of employees) {
      const categoryAssignment = emp.work_category ? activeCategoryAssignments.get(emp.work_category) : undefined;
      const categorySchedule = categoryAssignment?.work_schedules;
      if (categorySchedule) {
        map.set(emp.id, {
          scheduleId: categorySchedule.id,
          scheduleName: categorySchedule.name,
          source: 'category',
          effectiveFrom: categoryAssignment?.effective_from || null,
        });
      } else if (defaultSchedule) {
        map.set(emp.id, {
          scheduleId: defaultSchedule.id,
          scheduleName: defaultSchedule.name,
          source: 'default',
          effectiveFrom: null,
        });
      }
    }
    return map;
  }, [employees, activeCategoryAssignments, defaultSchedule]);

  const scheduleViews = useMemo(() => {
    const map = new Map<number, IEmployeeScheduleView>();
    for (const emp of employees) {
      const personalAssignment = activeEmployeeScheduleAssignments.get(emp.id);
      if (personalAssignment?.work_schedules) {
        map.set(emp.id, {
          scheduleId: personalAssignment.work_schedules.id,
          scheduleName: personalAssignment.work_schedules.name,
          source: 'employee',
          effectiveFrom: personalAssignment.effective_from,
        });
        continue;
      }
      const baseSchedule = baseScheduleViews.get(emp.id);
      if (baseSchedule) map.set(emp.id, baseSchedule);
    }
    return map;
  }, [employees, activeEmployeeScheduleAssignments, baseScheduleViews]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (deptId) p.set('dept', deptId);
    if (debouncedSearch) p.set('q', debouncedSearch);
    setUrlParams(p, { replace: true });
  }, [deptId, debouncedSearch, setUrlParams]);

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

  const allDepts = useMemo(() => {
    const flat = getTreeFlatDepartments(departments);
    if (!restrictToManaged) return flat;
    const allow = new Set(managedDepartmentIds);
    return flat.filter(d => allow.has(d.id));
  }, [departments, restrictToManaged, managedDepartmentIds]);
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
    if (debouncedSearch) {
      parts.push(`Поиск: "${debouncedSearch}"`);
    }
    if (parts.length === 0) return 'Все активные сотрудники';
    return parts.join(' • ');
  }, [deptId, debouncedSearch, allDepts]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const handleDeptChange = useCallback((value: string) => {
    setDeptId(value);
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

  const clearSelectedEmployees = useCallback(() => {
    setSelectedEmployeeIds([]);
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

  const handleSaveDepartment = useCallback(async (empId: number, newDeptId: string) => {
    try {
      await employeeService.moveDepartment(empId, newDeptId);
      closeModal();
      const deptName = allDepts.find(d => d.id === newDeptId)?.name;
      patchEmployee(empId, { org_department_id: newDeptId, department: deptName });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Не удалось перенести сотрудника';
      toast.error(msg);
      throw e;
    }
  }, [closeModal, patchEmployee, allDepts, toast]);

  const handleSaveCategory = useCallback(async (empId: number, category: string | null) => {
    await employeeService.changeCategory(empId, category);
    closeModal();
    patchEmployee(empId, { work_category: category });
  }, [closeModal, patchEmployee]);

  const handleSaveSchedule = useCallback(async (empId: number, scheduleId: string | null, effectiveFrom: string) => {
    if (scheduleId) {
      await scheduleService.assignEmployee(empId, {
        schedule_id: scheduleId,
        effective_from: effectiveFrom,
      });
    } else {
      await scheduleService.removeEmployeeAssignment(empId, effectiveFrom);
    }
    await Promise.all([
      employeeScheduleAssignmentsQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ['schedules', 'employee-assignments'] }),
    ]);
    closeModal();
  }, [closeModal, employeeScheduleAssignmentsQuery, queryClient]);

  const applyScheduleToEmployees = useCallback(async (employeeIds: number[], scheduleId: string | null, effectiveFrom: string) => {
    if (employeeIds.length === 0) return;
    const CHUNK_SIZE = 20;

    for (let i = 0; i < employeeIds.length; i += CHUNK_SIZE) {
      const chunk = employeeIds.slice(i, i + CHUNK_SIZE);
      if (scheduleId) {
        await Promise.all(chunk.map(empId => scheduleService.assignEmployee(empId, {
          schedule_id: scheduleId,
          effective_from: effectiveFrom,
        })));
      } else {
        await Promise.all(chunk.map(empId => scheduleService.removeEmployeeAssignment(empId, effectiveFrom)));
      }
    }
  }, []);

  const handleBulkSaveSchedule = useCallback(async (scheduleId: string | null, effectiveFrom: string) => {
    await applyScheduleToEmployees(selectedEmployees.map(employee => employee.id), scheduleId, effectiveFrom);
    await Promise.all([
      employeeScheduleAssignmentsQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ['schedules', 'employee-assignments'] }),
    ]);
    setBulkScheduleOpen(false);
    setSelectedEmployeeIds([]);
  }, [applyScheduleToEmployees, employeeScheduleAssignmentsQuery, queryClient, selectedEmployees]);

  const handleBulkSaveCategory = useCallback(async (categoryCode: string | null) => {
    const CHUNK_SIZE = 20;
    const ids = selectedEmployees.map(e => e.id);
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      await Promise.all(ids.slice(i, i + CHUNK_SIZE).map(id => employeeService.changeCategory(id, categoryCode)));
    }
    ids.forEach(id => patchEmployee(id, { work_category: categoryCode || undefined }));
    setBulkCategoryOpen(false);
    setSelectedEmployeeIds([]);
  }, [selectedEmployees, patchEmployee]);

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
    await applyScheduleToEmployees(employeeIds, scheduleId, effectiveFrom);
    await Promise.all([
      employeeScheduleAssignmentsQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ['schedules', 'employee-assignments'] }),
    ]);
    setBulkFilterScheduleOpen(false);
  }, [applyScheduleToEmployees, debouncedSearch, deptId, employeeScheduleAssignmentsQuery, queryClient]);

  const handleBrigadeBulkSaveSchedule = useCallback(async (departmentIds: string[], scheduleId: string | null, effectiveFrom: string) => {
    try {
      const result = await scheduleService.bulkApplyToBrigades({
        department_ids: departmentIds,
        action: scheduleId ? 'assign' : 'reset',
        schedule_id: scheduleId || undefined,
        effective_date: effectiveFrom,
      });

      if (result.employees_updated > 0) {
        toast.success(
          `Обработано бригад: ${result.departments_processed}. Сотрудников обновлено: ${result.employees_updated} из ${result.employees_matched}.`,
        );
      } else {
        toast.info(
          `Обработано бригад: ${result.departments_processed}. Активных изменений нет.`,
        );
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
    }
  }, [employeeScheduleAssignmentsQuery, queryClient, toast]);

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

  const filtersContent = (
    <div className="sc-filters">
      <DeptSelect
        departments={allDepts}
        value={deptId}
        onChange={handleDeptChange}
      />
      <div className="sc-filter-search">
        <SearchInput value={search} onValueChange={handleSearchChange} placeholder="Поиск по ФИО..." />
      </div>
      <div className="sc-status-toggle">
        <button
          className={`sc-btn${statusFilter === 'active' ? ' apply' : ' secondary'}`}
          onClick={() => { setStatusFilter('active'); setPage(1); }}
        >
          Активные
        </button>
        <button
          className={`sc-btn${statusFilter === 'fired' ? ' apply' : ' secondary'}`}
          onClick={() => { setStatusFilter('fired'); setPage(1); }}
        >
          Уволенные
        </button>
      </div>
      <div className="sc-filter-count">
        {meta.total}{statusFilter === 'active' ? ` из ${totalActive}` : ''}
      </div>
      {statusFilter === 'active' && isAdmin && (
        <div className="sc-filter-actions">
          <button className="sc-btn secondary" onClick={() => setBulkBrigadeScheduleOpen(true)} disabled={brigadeOptions.length === 0}>
            <Calendar size={14} /> По бригадам
          </button>
          <button className="sc-btn secondary" onClick={() => setBulkFilterScheduleOpen(true)} disabled={meta.total === 0}>
            <Calendar size={14} /> По фильтру
          </button>
          <button className="sc-btn secondary" onClick={() => setShowImportModal(true)}>
            <Upload size={14} /> Импорт
          </button>
          <button className="sc-btn apply" onClick={() => setShowAddModal(true)}>
            <UserPlus size={14} /> Добавить
          </button>
        </div>
      )}
    </div>
  );

  /* ─── render ─── */

  return (
    <div className="sc-page">
      {/* Filters */}
      {isMobile ? (
        <div className="sc-mobile-toolbar">
          <DeptSelect
            departments={allDepts}
            value={deptId}
            onChange={handleDeptChange}
          />
          <div className="sc-filter-search">
            <SearchInput value={search} onValueChange={handleSearchChange} placeholder="Поиск по ФИО..." />
          </div>
          {isAdmin && (
            <button className="sc-btn apply" onClick={() => setShowAddModal(true)}>
              <UserPlus size={16} /> Добавить
            </button>
          )}
          <div className="sc-status-toggle sc-status-toggle--mobile">
            <button
              className={`sc-btn${statusFilter === 'active' ? ' apply' : ' secondary'}`}
              onClick={() => { setStatusFilter('active'); setPage(1); }}
            >
              Активные
            </button>
            <button
              className={`sc-btn${statusFilter === 'fired' ? ' apply' : ' secondary'}`}
              onClick={() => { setStatusFilter('fired'); setPage(1); }}
            >
              Уволенные
            </button>
          </div>
        </div>
      ) : (
        filtersContent
      )}

      {selectedEmployeeIds.length > 0 && (
        <div className="sc-bulk-bar">
          <div className="sc-bulk-info">
            Выбрано сотрудников: <strong>{selectedEmployeeIds.length}</strong>
          </div>
          <div className="sc-bulk-actions">
            <button className="sc-btn secondary" onClick={() => setBulkCategoryOpen(true)}>
              Категория
            </button>
            <button className="sc-btn secondary" onClick={() => setBulkScheduleOpen(true)}>
              <Calendar size={14} /> График
            </button>
            <button className="sc-btn cancel" onClick={clearSelectedEmployees}>
              Снять выбор
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="sc-loading">Загрузка...</div>
      ) : isMobile ? (
        <VirtualCards
          filtered={employees}
          categoryLabels={categoryLabels}
          scheduleViews={scheduleViews}
          selectedIds={selectedEmployeeIdSet}
          onNavigate={handleNavigate}
          onToggleSelect={toggleSelectEmployee}
          onOpenModal={openModal}
          onOpenHistory={openHistory}
          onRehire={statusFilter === 'fired' ? handleRehire : undefined}
          onFire={statusFilter === 'active' ? handleFire : undefined}
        />
      ) : (
        <VirtualTable
          filtered={employees}
          categoryLabels={categoryLabels}
          scheduleViews={scheduleViews}
          selectedIds={selectedEmployeeIdSet}
          onNavigate={handleNavigate}
          onToggleSelect={toggleSelectEmployee}
          onToggleSelectAll={toggleSelectAllVisible}
          allSelected={allVisibleSelected}
          onOpenModal={openModal}
          onOpenHistory={openHistory}
          onRehire={statusFilter === 'fired' ? handleRehire : undefined}
          onFire={statusFilter === 'active' ? handleFire : undefined}
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
        categories={workCategories}
        templates={scheduleTemplates}
        scheduleViews={scheduleViews}
        baseScheduleViews={baseScheduleViews}
        onClose={closeModal}
        onSaveSalary={handleSaveSalary}
        onSavePosition={handleSavePosition}
        onSaveDepartment={handleSaveDepartment}
        onSaveCategory={handleSaveCategory}
        onSaveSchedule={handleSaveSchedule}
      />
      <BulkCategoryModal
        open={bulkCategoryOpen}
        targetCount={selectedEmployees.length}
        categories={workCategories}
        onClose={() => setBulkCategoryOpen(false)}
        onApply={handleBulkSaveCategory}
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
                  disabled={addSaving}
                />
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
