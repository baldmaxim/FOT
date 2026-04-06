import { useState, useEffect, useCallback, useMemo, type FC } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Pencil, ArrowRightLeft, History, TrendingUp, Upload, UserPlus } from 'lucide-react';
import { SearchInput } from '../components/ui/SearchInput';
import { employeeService } from '../services/employeeService';
import { useIsMobile } from '../hooks/useIsMobile';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useStaffData } from '../hooks/useStaffData';
import { DeptSelect } from '../components/staff/DeptSelect';
import { HistoryPanel } from '../components/staff/HistoryPanel';
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

/* ───────── Main Page ───────── */

export const StaffControlPage: FC = () => {
  const navigate = useNavigate();
  const [urlParams, setUrlParams] = useSearchParams();
  const isMobile = useIsMobile(768);

  // data — из кэширующего хука
  const { employees, departments, loading, refresh, patchEmployee } = useStaffData();

  // filters — синхронизация с URL
  const [search, setSearch] = useState(() => urlParams.get('q') || '');
  const [deptId, setDeptId] = useState(() => urlParams.get('dept') || '');
  const debouncedSearch = useDebouncedValue(search, 300);

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

  /* ─── memoized computations ─── */

  const allDepts = useMemo(() => sortDepts(flattenDepts(departments)), [departments]);

  const searchLower = debouncedSearch.toLowerCase();
  const filtered = useMemo(
    () => employees.filter(e => {
      if (deptId && e.org_department_id !== deptId) return false;
      if (searchLower && !e.full_name.toLowerCase().includes(searchLower)) return false;
      return true;
    }),
    [employees, deptId, searchLower],
  );

  /* ─── history panel ─── */

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

  /* ─── modal open ─── */

  const openModal = useCallback((emp: Employee, type: 'salary' | 'salary_actual' | 'position' | 'department') => {
    setModalEmp(emp);
    setModalType(type);
    setSalaryVal('');
    setSalaryDate(new Date().toISOString().slice(0, 10));
    setSalaryReason('');
    setPositionVal('');
    setPositionDate(new Date().toISOString().slice(0, 10));
    setPositionReason('');
    setDeptVal(emp.org_department_id || '');
  }, []);

  const closeModal = useCallback(() => {
    setModalType(null);
    setModalEmp(null);
  }, []);

  /* ─── save handlers (optimistic updates) ─── */

  const handleSaveSalary = async () => {
    if (!modalEmp || !salaryVal) return;
    const empId = modalEmp.id;
    const val = Number(salaryVal);
    setSaving(true);
    await employeeService.changeSalary(empId, val, salaryReason || undefined, salaryDate || undefined);
    closeModal();
    setSaving(false);
    if (modalType === 'salary_actual') {
      patchEmployee(empId, { salary_actual: val });
    } else {
      patchEmployee(empId, { salary_calculated: val });
    }
  };

  const handleSavePosition = async () => {
    if (!modalEmp || !positionVal) return;
    const empId = modalEmp.id;
    setSaving(true);
    await employeeService.changePosition(empId, positionVal, positionReason || undefined, positionDate || undefined);
    closeModal();
    setSaving(false);
    patchEmployee(empId, { position_name: positionVal });
  };

  const handleSaveDepartment = async () => {
    if (!modalEmp || !deptVal) return;
    const empId = modalEmp.id;
    setSaving(true);
    await employeeService.moveDepartment(empId, deptVal);
    closeModal();
    setSaving(false);
    const deptName = allDepts.find(d => d.id === deptVal)?.name;
    patchEmployee(empId, { org_department_id: deptVal, department: deptName });
  };

  /* ─── history panel data changed ─── */

  const handleHistoryDataChanged = useCallback(() => {
    refresh();
  }, [refresh]);

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

  const handleAddEmployee = async () => {
    if (!addForm.full_name || !addForm.hire_date) return;
    await employeeService.create(addForm);
    setShowAddModal(false);
    setAddForm({ full_name: '', hire_date: new Date().toISOString().slice(0, 10) });
    refresh();
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
          onDataChanged={handleHistoryDataChanged}
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
