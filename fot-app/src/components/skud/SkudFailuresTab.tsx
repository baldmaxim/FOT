import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, RefreshCw, Search, X } from 'lucide-react';
import { skudService } from '../../services/skudService';
import { employeeService } from '../../services/employeeService';
import type { SkudEventFailure } from '../../types';
import '../../styles/SkudFailuresTab.css';

interface IEmployeeOption {
  id: number;
  full_name: string;
  position?: string | null;
  department_name?: string | null;
}

const formatDate = (dateStr: string): string => {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
};

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const monthAgoIso = (): string => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const SkudFailuresTab: FC = () => {
  const [data, setData] = useState<SkudEventFailure[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(monthAgoIso);
  const [endDate, setEndDate] = useState(todayIso);
  const [failureTypeFilter, setFailureTypeFilter] = useState('');

  // Поиск сотрудника по ФИО
  const [employeeQuery, setEmployeeQuery] = useState('');
  const [employeeOptions, setEmployeeOptions] = useState<IEmployeeOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<IEmployeeOption | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFailures = useCallback(async (employeeId: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await skudService.getEventFailures({
        employeeId,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        failureType: failureTypeFilter.trim() || undefined,
        limit: 2000,
      });
      setData(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, failureTypeFilter]);

  // Debounced поиск сотрудников
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const trimmed = employeeQuery.trim();
    if (trimmed.length < 2) {
      setEmployeeOptions([]);
      setSearching(false);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await employeeService.getPaginated({
          page: 1,
          pageSize: 10,
          search: trimmed,
          status: 'active',
        });
        const opts: IEmployeeOption[] = (res.data || []).map(e => {
          const r = e as unknown as Record<string, unknown>;
          return {
            id: Number(r.id),
            full_name: String(r.full_name || ''),
            position: (r.position as string | null) ?? null,
            department_name: (r.department_name as string | null) ?? null,
          };
        });
        setEmployeeOptions(opts);
      } catch {
        setEmployeeOptions([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [employeeQuery]);

  // Перезагрузка при смене дат / типа ошибки, если сотрудник уже выбран
  useEffect(() => {
    if (selectedEmployee) {
      void loadFailures(selectedEmployee.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFailures стабилен (его deps в нём)
  }, [selectedEmployee, startDate, endDate, failureTypeFilter]);

  const handleSelectEmployee = (emp: IEmployeeOption) => {
    setSelectedEmployee(emp);
    setEmployeeQuery(emp.full_name);
    setEmployeeOptions([]);
    setShowDropdown(false);
  };

  const handleClearEmployee = () => {
    setSelectedEmployee(null);
    setEmployeeQuery('');
    setEmployeeOptions([]);
    setData([]);
    setError(null);
  };

  return (
    <div className="sigur-raw">
      <div className="sigur-raw-header">
        <div className="sigur-raw-title">
          <AlertCircle size={20} />
          <h2 style={{ margin: 0 }}>Ошибочные события Sigur</h2>
          {selectedEmployee && !loading && (
            <span className="sigur-raw-count">{data.length} событий</span>
          )}
        </div>
        {selectedEmployee && (
          <button
            className="sigur-raw-refresh"
            onClick={() => { void loadFailures(selectedEmployee.id); }}
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? 'spinning' : ''} />
            Обновить
          </button>
        )}
      </div>

      <div className="sigur-raw-events-filters">
        <div className="sigur-raw-events-dates">
          <label>
            С:
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="sigur-raw-date-input"
            />
          </label>
          <label>
            По:
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="sigur-raw-date-input"
            />
          </label>
        </div>

        <div style={{ position: 'relative', flex: '1 1 280px', minWidth: 240 }}>
          <label className="sigur-raw-employee-label" style={{ width: '100%' }}>
            Сотрудник:
            <input
              type="text"
              placeholder="Начни вводить ФИО..."
              value={employeeQuery}
              onChange={e => {
                setEmployeeQuery(e.target.value);
                setShowDropdown(true);
                if (selectedEmployee && e.target.value !== selectedEmployee.full_name) {
                  setSelectedEmployee(null);
                  setData([]);
                }
              }}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
              className="sigur-raw-employee-input"
              style={{ flex: 1 }}
            />
            {employeeQuery && (
              <button
                className="sigur-raw-employee-clear"
                onClick={handleClearEmployee}
                type="button"
              >
                <X size={14} />
              </button>
            )}
          </label>
          {showDropdown && employeeQuery.trim().length >= 2 && (employeeOptions.length > 0 || searching) && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                background: 'var(--bg-elevated, #fff)',
                border: '1px solid var(--border, #e2e8f0)',
                borderRadius: 6,
                marginTop: 4,
                maxHeight: 320,
                overflowY: 'auto',
                zIndex: 1000,
                boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
              }}
            >
              {searching && (
                <div style={{ padding: 8, fontSize: 12, color: 'var(--text-tertiary)' }}>Поиск...</div>
              )}
              {!searching && employeeOptions.map(emp => (
                <div
                  key={emp.id}
                  onMouseDown={() => handleSelectEmployee(emp)}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--border-subtle, #f1f5f9)',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover, #f1f5f9)')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}
                >
                  <div style={{ fontWeight: 500 }}>{emp.full_name}</div>
                  {(emp.position || emp.department_name) && (
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {[emp.position, emp.department_name].filter(Boolean).join(' • ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="sigur-raw-employee-label">
          Тип ошибки:
          <input
            type="text"
            placeholder="PASS_DENY..."
            value={failureTypeFilter}
            onChange={e => setFailureTypeFilter(e.target.value)}
            className="sigur-raw-employee-input"
          />
          {failureTypeFilter && (
            <button className="sigur-raw-employee-clear" onClick={() => setFailureTypeFilter('')}>
              <X size={14} />
            </button>
          )}
        </label>
      </div>

      {error && (
        <div className="sigur-raw-error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {!selectedEmployee ? (
        <div className="sigur-raw-empty">
          <Search size={20} style={{ opacity: 0.5, marginBottom: 8 }} />
          <div>Выберите сотрудника, чтобы увидеть ошибочные события</div>
        </div>
      ) : loading ? (
        <div className="sigur-raw-loading">
          <div className="spinner"></div>
          <p>Загрузка ошибочных событий...</p>
        </div>
      ) : data.length === 0 && !error ? (
        <div className="sigur-raw-empty">
          Нет ошибочных событий за выбранный период у{' '}
          <strong>{selectedEmployee.full_name}</strong>
        </div>
      ) : (
        <div className="sigur-raw-table-wrap">
          <table className="sigur-raw-table">
            <thead>
              <tr>
                <th className="sigur-raw-th-num">#</th>
                <th>Дата</th>
                <th>Время</th>
                <th>Карта</th>
                <th>Точка доступа</th>
                <th>Направление</th>
                <th>Тип ошибки</th>
                <th>Причина</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row, idx) => (
                <tr key={row.id}>
                  <td className="sigur-raw-td-num">{idx + 1}</td>
                  <td>{formatDate(row.event_date)}</td>
                  <td>{row.event_time.slice(0, 8)}</td>
                  <td>{row.card_number || '—'}</td>
                  <td>{row.access_point || '—'}</td>
                  <td>
                    {row.direction === 'entry' ? 'Вход' : row.direction === 'exit' ? 'Выход' : '—'}
                  </td>
                  <td>
                    <span className="skud-failure-badge">{row.failure_type}</span>
                  </td>
                  <td title={row.reason || ''}>{row.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
