import { useState, useEffect, useCallback, type FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import type { PaginatedMeta } from '../../services/employeeService';
import { skudService } from '../../services/skudService';
import { useAuth } from '../../contexts/AuthContext';
import { EmpVirtualList } from '../../components/employees/EmpVirtualList';
import type { Employee, IEmployeePresence } from '../../types';
import '../../styles/EmployeesPage.css';

const PAGE_SIZE = 50;

export const HeaderEmployeesPage: FC = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const departmentId = profile?.department_id || null;

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [presenceMap, setPresenceMap] = useState<Map<number, IEmployeePresence>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState<PaginatedMeta>({ page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 });
  const [activeTab, setActiveTab] = useState<'all' | 'fired'>('all');
  const [error, setError] = useState('');

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => { setPage(1); }, [activeTab]);

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const res = await employeeService.getPaginated({
        page,
        pageSize: PAGE_SIZE,
        search: debouncedSearch || undefined,
        status: activeTab === 'fired' ? 'fired' : 'active',
        departmentId: departmentId || undefined,
      });
      setEmployees(res.data);
      setMeta(res.meta);
    } catch {
      setEmployees([]);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, departmentId, activeTab]);

  const loadPresence = useCallback(async () => {
    try {
      const data = await skudService.getPresence(departmentId ?? undefined);
      const map = new Map<number, IEmployeePresence>();
      data.forEach(p => map.set(p.employee_id, p));
      setPresenceMap(map);
    } catch { /* ignore */ }
  }, [departmentId]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);
  useEffect(() => {
    loadPresence();
    const interval = setInterval(loadPresence, 30_000);
    return () => clearInterval(interval);
  }, [loadPresence]);

  const handleEmpClick = (emp: Employee) => navigate(`/tender/${emp.id}`);

  const handleFire = async (emp: Employee, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Уволить ${emp.full_name}?`)) return;
    try {
      await employeeService.fire(emp.id);
      loadEmployees();
    } catch { setError('Ошибка увольнения'); }
  };

  const handleRehire = async (emp: Employee, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await employeeService.rehire(emp.id);
      loadEmployees();
    } catch { setError('Ошибка восстановления'); }
  };

  const canPrev = page > 1;
  const canNext = page < meta.totalPages;

  return (
    <div className="employees-page">
      <div className="ep-emp-panel">
        <div className="ep-emp-header">
          <div className="ep-emp-title">
            <h2>Сотрудники</h2>
            <span className="ep-emp-count">{meta.total} чел.</span>
          </div>
          <div className="ep-emp-tabs">
            <button
              className={`ep-tab ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              Все
            </button>
            <button
              className={`ep-tab ${activeTab === 'fired' ? 'active' : ''}`}
              onClick={() => setActiveTab('fired')}
            >
              Уволенные
            </button>
          </div>
        </div>

        <div className="ep-emp-toolbar">
          <div className="ep-toolbar-search">
            <Search size={15} />
            <input
              type="text"
              placeholder="Поиск по имени..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <div className="ep-error">
            {error}
            <button onClick={() => setError('')}>×</button>
          </div>
        )}

        <EmpVirtualList
          employees={employees}
          loading={loading}
          selectedEmps={new Set()}
          presenceMap={presenceMap}
          canEdit={true}
          showMove={false}
          onEmpClick={handleEmpClick}
          onToggleSelection={() => {}}
          onFire={handleFire}
          onRehire={handleRehire}
          onMove={() => {}}
        />

        {meta.totalPages > 1 && (
          <div className="ep-pagination">
            <button className="ep-pagination-btn" disabled={!canPrev} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft size={16} />
            </button>
            <span className="ep-pagination-info">{meta.page} / {meta.totalPages}</span>
            <button className="ep-pagination-btn" disabled={!canNext} onClick={() => setPage(p => p + 1)}>
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
