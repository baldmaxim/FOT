import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Pencil, ArrowRightLeft, History, X, TrendingUp, Briefcase, Trash2, Check, Upload, UserPlus, ChevronDown } from 'lucide-react';
import { SearchInput } from '../components/ui/SearchInput';
import { employeeService } from '../services/employeeService';
import { structureApi } from '../api/structure';
import { useIsMobile } from '../hooks/useIsMobile';
import { ImportModal } from '../components/employees/ImportModal';
import { EnrichPreviewModal } from '../components/employees/EnrichPreviewModal';
import type { Employee, EmployeeHistoryEvent, EmployeeInput, EnrichPreview } from '../types';
import type { OrgDepartmentNode } from '../types/organization';
import '../styles/StaffControlPage.css';

/* ───────── helpers ───────── */

const flattenDepts = (nodes: OrgDepartmentNode[]): OrgDepartmentNode[] =>
  nodes.flatMap(n => [n, ...flattenDepts(n.children)]);

const sortDepts = (depts: OrgDepartmentNode[]): OrgDepartmentNode[] =>
  [...depts].sort((a, b) => {
    const aHas = /\(/.test(a.name) ? 0 : 1;
    const bHas = /\(/.test(b.name) ? 0 : 1;
    return aHas - bHas || a.name.localeCompare(b.name, 'ru');
  });

const fmt = (n: number | null | undefined) =>
  n ? n.toLocaleString('ru-RU') + ' ₽' : '—';

const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

/* ───────── DeptSelect ───────── */

const DeptSelect: FC<{
  departments: OrgDepartmentNode[];
  value: string;
  onChange: (id: string) => void;
}> = ({ departments, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const selected = departments.find(d => d.id === value);
  const qLower = q.toLowerCase();
  const filtered = q ? departments.filter(d => d.name.toLowerCase().includes(qLower)) : departments;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ('');
  };

  return (
    <div className="sc-dept-select" ref={ref}>
      <button className="sc-dept-trigger" onClick={() => { setOpen(!open); setQ(''); }}>
        <span className="sc-dept-trigger-text">{selected ? selected.name : 'Все отделы'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="sc-dept-dropdown">
          <input
            className="sc-dept-search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Поиск отдела..."
            autoFocus
          />
          <div className="sc-dept-list">
            <div className={`sc-dept-option ${!value ? 'active' : ''}`} onClick={() => pick('')}>
              Все отделы
            </div>
            {filtered.map(d => (
              <div
                key={d.id}
                className={`sc-dept-option ${d.id === value ? 'active' : ''}`}
                onClick={() => pick(d.id)}
              >
                {d.name}
              </div>
            ))}
            {filtered.length === 0 && <div className="sc-dept-empty">Не найдено</div>}
          </div>
        </div>
      )}
    </div>
  );
};

/* ───────── HistoryPanel ───────── */

const HistoryPanel: FC<{
  employee: Employee;
  history: EmployeeHistoryEvent[];
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onDataChanged: () => void;
}> = ({ employee, history, loading, onClose, onRefresh, onDataChanged }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSalary, setEditSalary] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editReason, setEditReason] = useState('');
  const [saving, setSaving] = useState(false);

  // add forms
  const [addMode, setAddMode] = useState<'salary' | 'position' | null>(null);
  const [addVal, setAddVal] = useState('');
  const [addDate, setAddDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [addReason, setAddReason] = useState('');

  const salaryEvents = history
    .filter(e => e.event_type === 'salary')
    .sort((a, b) => a.event_date.localeCompare(b.event_date));

  const salaryDeltas = new Map<string, number>();
  for (let i = 1; i < salaryEvents.length; i++) {
    const prev = (salaryEvents[i - 1].event_data as Record<string, unknown>).salary as number;
    const curr = (salaryEvents[i].event_data as Record<string, unknown>).salary as number;
    if (prev && curr) salaryDeltas.set(salaryEvents[i].event_id, curr - prev);
  }

  const sorted = [...history].sort((a, b) => b.event_date.localeCompare(a.event_date));

  const startEdit = (ev: EmployeeHistoryEvent) => {
    const data = ev.event_data as Record<string, unknown>;
    setEditingId(ev.event_id);
    setEditDate(ev.event_date);
    setEditReason(String(data.reason || data.change_reason || ''));
    if (ev.event_type === 'salary') setEditSalary(String(data.salary || ''));
    setAddMode(null);
  };

  const saveEdit = async (ev: EmployeeHistoryEvent) => {
    setSaving(true);
    const body: Record<string, unknown> = { effective_date: editDate, change_reason: editReason };
    if (ev.event_type === 'salary') body.salary = Number(editSalary);
    await employeeService.updateHistoryEvent(employee.id, ev.event_id, body);
    setEditingId(null);
    setSaving(false);
    onRefresh();
    onDataChanged();
  };

  const handleDelete = async (ev: EmployeeHistoryEvent) => {
    if (!confirm('Удалить запись?')) return;
    await employeeService.deleteHistoryEvent(employee.id, ev.event_id);
    onRefresh();
    onDataChanged();
  };

  const handleAdd = async () => {
    if (!addVal) return;
    setSaving(true);
    if (addMode === 'salary') {
      await employeeService.changeSalary(employee.id, Number(addVal), addReason || undefined, addDate || undefined);
    } else {
      await employeeService.changePosition(employee.id, addVal, addReason || undefined, addDate || undefined);
    }
    setAddMode(null);
    setAddVal('');
    setAddReason('');
    setAddDate(new Date().toISOString().slice(0, 10));
    setSaving(false);
    onRefresh();
    onDataChanged();
  };

  const openAdd = (mode: 'salary' | 'position') => {
    setAddMode(mode);
    setAddVal('');
    setAddDate(new Date().toISOString().slice(0, 10));
    setAddReason('');
    setEditingId(null);
  };

  return (
    <div className="sc-panel-overlay" onClick={onClose}>
      <div className="sc-panel" onClick={e => e.stopPropagation()}>
        <div className="sc-panel-header">
          <h3>{employee.full_name}</h3>
          <button className="sc-panel-close" onClick={onClose}><X size={18} /></button>
        </div>

        {/* Add buttons */}
        <div className="sc-panel-add-bar">
          <button className="sc-panel-add-btn" onClick={() => openAdd('salary')}>
            <TrendingUp size={13} /> Оклад
          </button>
          <button className="sc-panel-add-btn" onClick={() => openAdd('position')}>
            <Briefcase size={13} /> Должность
          </button>
        </div>

        {/* Add form */}
        {addMode && (
          <div className="sc-panel-add-form">
            <div className="sc-panel-edit-row">
              {addMode === 'salary' ? (
                <input type="number" value={addVal} onChange={e => setAddVal(e.target.value)} placeholder="Оклад (₽)" autoFocus />
              ) : (
                <input value={addVal} onChange={e => setAddVal(e.target.value)} placeholder="Должность" autoFocus />
              )}
              <input type="date" value={addDate} onChange={e => setAddDate(e.target.value)} />
            </div>
            <input value={addReason} onChange={e => setAddReason(e.target.value)} placeholder="Причина" />
            <div className="sc-panel-edit-actions">
              <button className="sc-panel-edit-btn save" onClick={handleAdd} disabled={!addVal || saving}>
                <Check size={13} /> {saving ? '...' : 'Добавить'}
              </button>
              <button className="sc-panel-edit-btn" onClick={() => setAddMode(null)}>Отмена</button>
            </div>
          </div>
        )}

        <div className="sc-panel-body">
          {loading ? (
            <div className="sc-panel-loading">Загрузка...</div>
          ) : sorted.length === 0 ? (
            <div className="sc-panel-empty">Нет записей</div>
          ) : (
            <div className="sc-panel-timeline">
              {sorted.map(ev => {
                const data = ev.event_data as Record<string, unknown>;
                const isEditing = editingId === ev.event_id;

                if (ev.event_type === 'salary') {
                  const salary = data.salary as number | null;
                  const delta = salaryDeltas.get(ev.event_id);
                  const reason = String(data.reason || '');
                  const isFirst = salaryEvents[0]?.event_id === ev.event_id;
                  const isHire = reason.toLowerCase().includes('приеме') || reason.toLowerCase().includes('приём');

                  return (
                    <div key={ev.event_id} className={`sc-panel-item ${isEditing ? 'editing' : ''}`}>
                      <div className="sc-panel-dot-col">
                        <div className={`sc-panel-dot ${delta && delta > 0 ? 'green' : delta && delta < 0 ? 'red' : 'gray'}`} />
                        <div className="sc-panel-line" />
                      </div>
                      <div className="sc-panel-content">
                        {isEditing ? (
                          <div className="sc-panel-edit-form">
                            <div className="sc-panel-edit-row">
                              <input type="number" value={editSalary} onChange={e => setEditSalary(e.target.value)} placeholder="Оклад" />
                              <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} />
                            </div>
                            <input value={editReason} onChange={e => setEditReason(e.target.value)} placeholder="Причина" />
                            <div className="sc-panel-edit-actions">
                              <button className="sc-panel-edit-btn save" onClick={() => saveEdit(ev)} disabled={saving}>
                                <Check size={13} /> {saving ? '...' : 'OK'}
                              </button>
                              <button className="sc-panel-edit-btn" onClick={() => setEditingId(null)}>×</button>
                            </div>
                          </div>
                        ) : (
                          <div className="sc-panel-row-compact">
                            <span className="sc-panel-date-sm">{fmtDate(ev.event_date)}</span>
                            <span className="sc-panel-salary-sm">{fmt(salary)}</span>
                            {delta != null && delta !== 0 && (
                              <span className={`sc-panel-delta-sm ${delta > 0 ? 'up' : 'down'}`}>
                                {delta > 0 ? '+' : ''}{delta.toLocaleString('ru-RU')}
                              </span>
                            )}
                            {isFirst && !delta && <span className="sc-panel-delta-sm neutral">старт</span>}
                            {reason && !isHire ? <span className="sc-panel-reason-sm">{reason}</span> : null}
                            <span className="sc-panel-item-btns">
                              <button className="sc-panel-act-btn" onClick={() => startEdit(ev)}><Pencil size={11} /></button>
                              <button className="sc-panel-act-btn danger" onClick={() => handleDelete(ev)}><Trash2 size={11} /></button>
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                // assignment
                const title = (() => {
                  if (data.type === 'hire' || data.type === 'Прием') return 'Приём';
                  if (data.type === 'transfer' || data.type === 'Перевод') return 'Перевод';
                  if (data.type === 'dismiss' || data.type === 'Увольнение') return 'Увольнение';
                  return 'Назначение';
                })();

                return (
                  <div key={ev.event_id} className={`sc-panel-item ${isEditing ? 'editing' : ''}`}>
                    <div className="sc-panel-dot-col">
                      <div className="sc-panel-dot blue" />
                      <div className="sc-panel-line" />
                    </div>
                    <div className="sc-panel-content">
                      {isEditing ? (
                        <div className="sc-panel-edit-form">
                          <div className="sc-panel-edit-row">
                            <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} />
                          </div>
                          <input value={editReason} onChange={e => setEditReason(e.target.value)} placeholder="Причина" />
                          <div className="sc-panel-edit-actions">
                            <button className="sc-panel-edit-btn save" onClick={() => saveEdit(ev)} disabled={saving}>
                              <Check size={13} /> {saving ? '...' : 'OK'}
                            </button>
                            <button className="sc-panel-edit-btn" onClick={() => setEditingId(null)}>×</button>
                          </div>
                        </div>
                      ) : (
                        <div className="sc-panel-row-compact">
                          <span className="sc-panel-date-sm">{fmtDate(ev.event_date)}</span>
                          <Briefcase size={12} className="sc-panel-assign-icon" />
                          <span className="sc-panel-assign-sm">{title}</span>
                          {data.position ? <span className="sc-panel-pos-sm">{String(data.position)}</span> : null}
                          {data.department ? <span className="sc-panel-reason-sm">{String(data.department)}</span> : null}
                          <span className="sc-panel-item-btns">
                            <button className="sc-panel-act-btn" onClick={() => startEdit(ev)}><Pencil size={11} /></button>
                            <button className="sc-panel-act-btn danger" onClick={() => handleDelete(ev)}><Trash2 size={11} /></button>
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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

  // data
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<OrgDepartmentNode[]>([]);
  const [loading, setLoading] = useState(true);

  // filters — синхронизация с URL
  const [search, setSearch] = useState(() => urlParams.get('q') || '');
  const [deptId, setDeptId] = useState(() => urlParams.get('dept') || '');

  useEffect(() => {
    const p = new URLSearchParams();
    if (deptId) p.set('dept', deptId);
    if (search) p.set('q', search);
    setUrlParams(p, { replace: true });
  }, [deptId, search, setUrlParams]);

  // history panel
  const [panelEmp, setPanelEmp] = useState<Employee | null>(null);
  const [panelHistory, setPanelHistory] = useState<EmployeeHistoryEvent[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);

  // modals
  const [modalType, setModalType] = useState<'salary' | 'salary_actual' | 'position' | 'department' | null>(null);
  const [modalEmp, setModalEmp] = useState<Employee | null>(null);

  // modal fields
  const [salaryVal, setSalaryVal] = useState('');
  const [salaryDate, setSalaryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [salaryReason, setSalaryReason] = useState('');
  const [positionVal, setPositionVal] = useState('');
  const [positionDate, setPositionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [positionReason, setPositionReason] = useState('');
  const [deptVal, setDeptVal] = useState('');
  const [saving, setSaving] = useState(false);

  // import / add
  const [showImportModal, setShowImportModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState<EmployeeInput>({ full_name: '', hire_date: new Date().toISOString().slice(0, 10) });
  const [enrichPreview, setEnrichPreview] = useState<EnrichPreview | null>(null);
  const [enrichFile, setEnrichFile] = useState<File | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [salaryEnrichPreview, setSalaryEnrichPreview] = useState<EnrichPreview | null>(null);
  const [salaryEnrichFile, setSalaryEnrichFile] = useState<File | null>(null);
  const [salaryEnrichLoading, setSalaryEnrichLoading] = useState(false);
  const [salaryHistoryPreview, setSalaryHistoryPreview] = useState<EnrichPreview | null>(null);
  const [salaryHistoryFile, setSalaryHistoryFile] = useState<File | null>(null);
  const [salaryHistoryLoading, setSalaryHistoryLoading] = useState(false);

  /* ─── load ─── */

  const loadData = useCallback(async () => {
    setLoading(true);
    const [emps, tree] = await Promise.all([
      employeeService.getAll(),
      structureApi.getTree(),
    ]);
    setEmployees(emps.filter(e => e.employment_status === 'active'));
    if (tree.data) setDepartments(tree.data.departments);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  /* ─── filter ─── */

  const allDepts = sortDepts(flattenDepts(departments));
  const searchLower = search.toLowerCase();

  const filtered = employees.filter(e => {
    if (deptId && e.org_department_id !== deptId) return false;
    if (searchLower && !e.full_name.toLowerCase().includes(searchLower)) return false;
    return true;
  });

  /* ─── history panel ─── */

  const openHistory = async (emp: Employee) => {
    setPanelEmp(emp);
    setPanelLoading(true);
    const history = await employeeService.getHistory(emp.id);
    setPanelHistory(history);
    setPanelLoading(false);
  };

  const closeHistory = () => {
    setPanelEmp(null);
    setPanelHistory([]);
  };

  /* ─── modal open ─── */

  const openModal = (emp: Employee, type: 'salary' | 'salary_actual' | 'position' | 'department') => {
    setModalEmp(emp);
    setModalType(type);
    setSalaryVal('');
    setSalaryDate(new Date().toISOString().slice(0, 10));
    setSalaryReason('');
    setPositionVal('');
    setPositionDate(new Date().toISOString().slice(0, 10));
    setPositionReason('');
    setDeptVal(emp.org_department_id || '');
  };

  const closeModal = () => {
    setModalType(null);
    setModalEmp(null);
  };

  /* ─── save handlers ─── */

  const handleSaveSalary = async () => {
    if (!modalEmp || !salaryVal) return;
    setSaving(true);
    await employeeService.changeSalary(modalEmp.id, Number(salaryVal), salaryReason || undefined, salaryDate || undefined);
    closeModal();
    setSaving(false);
    loadData();
  };

  const handleSavePosition = async () => {
    if (!modalEmp || !positionVal) return;
    setSaving(true);
    await employeeService.changePosition(modalEmp.id, positionVal, positionReason || undefined, positionDate || undefined);
    closeModal();
    setSaving(false);
    loadData();
  };

  const handleSaveDepartment = async () => {
    if (!modalEmp || !deptVal) return;
    setSaving(true);
    await employeeService.moveDepartment(modalEmp.id, deptVal);
    closeModal();
    setSaving(false);
    loadData();
  };

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
      loadData();
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
      loadData();
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
      loadData();
    } catch { /* ignore */ }
    setSalaryHistoryLoading(false);
    setSalaryHistoryPreview(null);
    setSalaryHistoryFile(null);
  };

  const handleAddEmployee = async () => {
    if (!addForm.full_name || !addForm.hire_date) return;
    await employeeService.create(addForm);
    setShowAddModal(false);
    setAddForm({ full_name: '', hire_date: new Date().toISOString().slice(0, 10) });
    loadData();
  };

  /* ─── render ─── */

  return (
    <div className="sc-page">
      {/* Filters */}
      <div className="sc-filters">
        <DeptSelect
          departments={allDepts}
          value={deptId}
          onChange={setDeptId}
        />
        <div className="sc-filter-search">
          <SearchInput value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." />
        </div>
        <div className="sc-filter-count">
          {filtered.length} из {employees.length}
        </div>
        <div className="sc-filter-actions">
          <button className="sc-btn secondary" onClick={() => setShowImportModal(true)}>
            <Upload size={14} /> Импорт
          </button>
          <button className="sc-btn apply" onClick={() => setShowAddModal(true)}>
            <UserPlus size={14} /> Добавить
          </button>
        </div>
      </div>

      {loading ? (
        <div className="sc-loading">Загрузка...</div>
      ) : isMobile ? (
        /* ─── Mobile cards ─── */
        <div className="sc-cards">
          {filtered.map(emp => (
            <div key={emp.id} className="sc-card" onClick={() => navigate(`/tender/${emp.id}`, { state: { label: 'Управление кадрами', from: `/staff-control?${urlParams.toString()}` } })}>
              <div className="sc-card-name">{emp.full_name}</div>
              <div className="sc-card-row">
                <span className="sc-card-label">Отдел</span>
                <span>{emp.department || '—'}</span>
              </div>
              <div className="sc-card-row">
                <span className="sc-card-label">Должность</span>
                <span>{emp.position_name || '—'}</span>
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
                <button className="sc-btn-icon" title="История" onClick={e => { e.stopPropagation(); openHistory(emp); }}>
                  <History size={14} />
                </button>
                <button className="sc-btn-icon" title="Сменить должность" onClick={e => { e.stopPropagation(); openModal(emp, 'position'); }}>
                  <Pencil size={14} />
                </button>
                <button className="sc-btn-icon" title="Изменить оклад" onClick={e => { e.stopPropagation(); openModal(emp, 'salary'); }}>
                  <TrendingUp size={14} />
                </button>
                <button className="sc-btn-icon" title="Сменить отдел" onClick={e => { e.stopPropagation(); openModal(emp, 'department'); }}>
                  <ArrowRightLeft size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ─── Desktop table ─── */
        <div className="sc-table-wrap">
          <table className="sc-table">
            <thead>
              <tr>
                <th className="sc-th-num">№</th>
                <th>ФИО</th>
                <th>Отдел</th>
                <th>Должность</th>
                <th>Оклад (договор)</th>
                <th>Оклад (программа)</th>
                <th className="sc-th-hist"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((emp, i) => (
                <tr key={emp.id} className="sc-row" onClick={() => navigate(`/tender/${emp.id}`, { state: { label: 'Управление кадрами', from: `/staff-control?${urlParams.toString()}` } })}>
                  <td className="sc-td-num">{i + 1}</td>
                  <td className="sc-td-name">{emp.full_name}</td>
                  <td>
                    <span className="sc-cell-with-btn">
                      {emp.department || '—'}
                      <button
                        className="sc-inline-btn"
                        title="Сменить отдел"
                        onClick={e => { e.stopPropagation(); openModal(emp, 'department'); }}
                      >
                        <ArrowRightLeft size={12} />
                      </button>
                    </span>
                  </td>
                  <td>
                    <span className="sc-cell-with-btn">
                      <button
                        className="sc-inline-btn"
                        title="Сменить должность"
                        onClick={e => { e.stopPropagation(); openModal(emp, 'position'); }}
                      >
                        <Pencil size={12} />
                      </button>
                      {emp.position_name || '—'}
                    </span>
                  </td>
                  <td className="sc-td-salary">
                    <span className="sc-cell-with-btn">
                      <button
                        className="sc-inline-btn"
                        title="Изменить оклад (договор)"
                        onClick={e => { e.stopPropagation(); openModal(emp, 'salary_actual'); }}
                      >
                        <Pencil size={12} />
                      </button>
                      {fmt(emp.salary_actual)}
                    </span>
                  </td>
                  <td className="sc-td-salary">
                    <span className="sc-cell-with-btn">
                      <button
                        className="sc-inline-btn"
                        title="Изменить оклад (программа)"
                        onClick={e => { e.stopPropagation(); openModal(emp, 'salary'); }}
                      >
                        <Pencil size={12} />
                      </button>
                      {fmt(emp.salary_calculated)}
                    </span>
                  </td>
                  <td className="sc-td-hist" onClick={e => e.stopPropagation()}>
                    <button className="sc-btn-icon" title="История" onClick={() => openHistory(emp)}>
                      <History size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="sc-empty">Нет сотрудников</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* History Side Panel */}
      {panelEmp && (
        <HistoryPanel
          employee={panelEmp}
          history={panelHistory}
          loading={panelLoading}
          onClose={closeHistory}
          onRefresh={() => openHistory(panelEmp)}
          onDataChanged={loadData}
        />
      )}

      {/* ─── Change Salary Modal (программа) ─── */}
      {modalType === 'salary' && modalEmp && (
        <div className="sc-overlay" onClick={closeModal}>
          <div className="sc-modal" onClick={e => e.stopPropagation()}>
            <div className="sc-modal-header">
              <h3>Изменить оклад (программа) — {modalEmp.full_name}</h3>
              <button className="sc-modal-close" onClick={closeModal}>&times;</button>
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
                <input value={salaryReason} onChange={e => setSalaryReason(e.target.value)} placeholder="Повышение, пересмотр..." />
              </div>
            </div>
            <div className="sc-modal-footer">
              <button className="sc-btn cancel" onClick={closeModal}>Отмена</button>
              <button className="sc-btn apply" onClick={handleSaveSalary} disabled={!salaryVal || saving}>
                {saving ? 'Сохранение...' : 'Применить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Change Salary Modal (договор) ─── */}
      {modalType === 'salary_actual' && modalEmp && (
        <div className="sc-overlay" onClick={closeModal}>
          <div className="sc-modal" onClick={e => e.stopPropagation()}>
            <div className="sc-modal-header">
              <h3>Изменить оклад (договор) — {modalEmp.full_name}</h3>
              <button className="sc-modal-close" onClick={closeModal}>&times;</button>
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
                <input value={salaryReason} onChange={e => setSalaryReason(e.target.value)} placeholder="Изменение договора..." />
              </div>
            </div>
            <div className="sc-modal-footer">
              <button className="sc-btn cancel" onClick={closeModal}>Отмена</button>
              <button className="sc-btn apply" onClick={handleSaveSalary} disabled={!salaryVal || saving}>
                {saving ? 'Сохранение...' : 'Применить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Change Position Modal ─── */}
      {modalType === 'position' && modalEmp && (
        <div className="sc-overlay" onClick={closeModal}>
          <div className="sc-modal" onClick={e => e.stopPropagation()}>
            <div className="sc-modal-header">
              <h3>Сменить должность — {modalEmp.full_name}</h3>
              <button className="sc-modal-close" onClick={closeModal}>&times;</button>
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
              <button className="sc-btn cancel" onClick={closeModal}>Отмена</button>
              <button className="sc-btn apply" onClick={handleSavePosition} disabled={!positionVal || saving}>
                {saving ? 'Сохранение...' : 'Применить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Move Department Modal ─── */}
      {modalType === 'department' && modalEmp && (
        <div className="sc-overlay" onClick={closeModal}>
          <div className="sc-modal" onClick={e => e.stopPropagation()}>
            <div className="sc-modal-header">
              <h3>Сменить отдел — {modalEmp.full_name}</h3>
              <button className="sc-modal-close" onClick={closeModal}>&times;</button>
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
              <button className="sc-btn cancel" onClick={closeModal}>Отмена</button>
              <button className="sc-btn apply" onClick={handleSaveDepartment} disabled={!deptVal || deptVal === modalEmp.org_department_id || saving}>
                {saving ? 'Сохранение...' : 'Применить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Import Modal ─── */}
      {showImportModal && (
        <ImportModal
          onClose={() => setShowImportModal(false)}
          onEnrichFile={handleEnrichFile}
          onSalaryFile={handleSalaryFile}
          onSalaryHistoryFile={handleSalaryHistoryFile}
        />
      )}

      {enrichPreview && (
        <EnrichPreviewModal preview={enrichPreview} loading={enrichLoading} onApply={handleEnrichApply} onClose={() => { setEnrichPreview(null); setEnrichFile(null); }} title="Импорт документов — Превью" />
      )}
      {salaryEnrichPreview && (
        <EnrichPreviewModal preview={salaryEnrichPreview} loading={salaryEnrichLoading} onApply={handleSalaryApply} onClose={() => { setSalaryEnrichPreview(null); setSalaryEnrichFile(null); }} title="Импорт окладов — Превью" />
      )}
      {salaryHistoryPreview && (
        <EnrichPreviewModal preview={salaryHistoryPreview} loading={salaryHistoryLoading} onApply={handleSalaryHistoryApply} onClose={() => { setSalaryHistoryPreview(null); setSalaryHistoryFile(null); }} title="Импорт истории окладов — Превью" />
      )}

      {/* ─── Add Employee Modal ─── */}
      {showAddModal && (
        <div className="sc-overlay" onClick={() => setShowAddModal(false)}>
          <div className="sc-modal" onClick={e => e.stopPropagation()}>
            <div className="sc-modal-header">
              <h3>Добавить сотрудника</h3>
              <button className="sc-modal-close" onClick={() => setShowAddModal(false)}>&times;</button>
            </div>
            <div className="sc-modal-body">
              <div className="sc-field">
                <label>ФИО</label>
                <input value={addForm.full_name} onChange={e => setAddForm({ ...addForm, full_name: e.target.value })} placeholder="Иванов Иван Иванович" autoFocus />
              </div>
              <div className="sc-field">
                <label>Дата найма</label>
                <input type="date" value={addForm.hire_date} onChange={e => setAddForm({ ...addForm, hire_date: e.target.value })} />
              </div>
            </div>
            <div className="sc-modal-footer">
              <button className="sc-btn cancel" onClick={() => setShowAddModal(false)}>Отмена</button>
              <button className="sc-btn apply" onClick={handleAddEmployee} disabled={!addForm.full_name}>Добавить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
