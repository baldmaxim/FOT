import { useState, useEffect, useCallback, useMemo, type FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import type { PaginatedMeta } from '../../services/employeeService';
import { useAuth } from '../../contexts/AuthContext';
import type { Employee } from '../../types';
import '../../styles/EmployeesPage.css';

const PAGE_SIZE = 50;

export const HeaderEmployeesPage: FC = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const departmentId = profile?.department_id || null;

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState<PaginatedMeta>({ page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 });

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset page on search change
  useEffect(() => { setPage(1); }, [debouncedSearch]);

  const loadEmployees = useCallback(async () => {
    if (!departmentId) return;
    setLoading(true);
    try {
      const res = await employeeService.getPaginated({
        page,
        pageSize: PAGE_SIZE,
        search: debouncedSearch || undefined,
        status: 'active',
        departmentId,
      });
      setEmployees(res.data);
      setMeta(res.meta);
    } catch {
      setEmployees([]);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, departmentId]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  const getInitials = (name: string) => {
    const parts = name.split(' ');
    return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
  };

  return (
    <div className="emp-page">
      <div className="emp-page__header">
        <h1 className="emp-page__title">Сотрудники</h1>
        <span className="emp-page__count">{meta.total} чел.</span>
      </div>

      <div className="emp-page__toolbar">
        <div className="emp-search-wrap">
          <Search size={16} className="emp-search-icon" />
          <input
            className="emp-search-input"
            type="text"
            placeholder="Поиск по ФИО..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="emp-page__content" style={{ padding: 0 }}>
        {loading ? (
          <div className="emp-loading">Загрузка...</div>
        ) : employees.length === 0 ? (
          <div className="emp-loading">Нет сотрудников</div>
        ) : (
          <div className="header-emp-list">
            {employees.map(emp => (
              <div
                key={emp.id}
                className="header-emp-row"
                onClick={() => navigate(`/tender/${emp.id}`)}
              >
                <div className="header-emp-avatar">{getInitials(emp.full_name)}</div>
                <div className="header-emp-info">
                  <div className="header-emp-name">{emp.full_name}</div>
                  <div className="header-emp-position">{emp.position_name || '—'}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {meta.totalPages > 1 && (
          <div className="emp-pagination">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="emp-pagination__btn">Назад</button>
            <span className="emp-pagination__info">{page} / {meta.totalPages}</span>
            <button disabled={page >= meta.totalPages} onClick={() => setPage(p => p + 1)} className="emp-pagination__btn">Далее</button>
          </div>
        )}
      </div>
    </div>
  );
};
