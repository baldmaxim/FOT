import React, { useState, useEffect, useCallback } from 'react';
import { Shield, ChevronLeft, ChevronRight, Upload } from 'lucide-react';
import { skudService } from '../../services/skudService';
import { employeeService } from '../../services/employeeService';
import { useAuth } from '../../contexts/AuthContext';
import type { Employee } from '../../types';
import '../../styles/SKUDPage.css';

interface DailySummary {
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
}

export const SKUDPage: React.FC = () => {
  const { hasPosition } = useAuth();
  const canEdit = hasPosition(['super_admin', 'admin', 'header']);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [summaries, setSummaries] = useState<{ [employeeId: number]: DailySummary[] }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();

  const loadEmployees = useCallback(async () => {
    try {
      const data = await employeeService.getAll();
      setEmployees(data.filter(e => !e.is_archived));
    } catch {
      setError('Ошибка загрузки сотрудников');
    }
  }, []);

  const loadSummaries = useCallback(async () => {
    setLoading(true);
    try {
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const data = await skudService.getDailySummary(startDate);

      const grouped = data.reduce((acc, summary) => {
        const empId = (summary as DailySummary).employee_id;
        if (!acc[empId]) acc[empId] = [];
        acc[empId].push(summary as DailySummary);
        return acc;
      }, {} as { [key: number]: DailySummary[] });

      setSummaries(grouped);
    } catch {
      // Error loading data
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  useEffect(() => {
    if (employees.length > 0) {
      loadSummaries();
    }
  }, [employees, loadSummaries]);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const result = await skudService.importEvents(file);
      alert(`Импортировано: ${result.imported} событий`);
      loadSummaries();
    } catch {
      setError('Ошибка импорта');
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  const prevMonth = () => {
    setCurrentDate(new Date(year, month - 2, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(year, month, 1));
  };

  const formatHours = (hours: number | null) => {
    if (!hours) return '—';
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}:${String(m).padStart(2, '0')}`;
  };

  const getDaySummary = (employeeId: number, day: number) => {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return summaries[employeeId]?.find(s => s.date === date);
  };

  const getEmployeeStats = (employeeId: number) => {
    const entries = summaries[employeeId] || [];
    const totalDays = entries.length;
    const totalHours = entries.reduce((sum, e) => sum + (e.total_hours || 0), 0);
    const avgHours = totalDays > 0 ? totalHours / totalDays : 0;

    return { totalDays, totalHours, avgHours };
  };

  const monthName = new Date(year, month - 1).toLocaleDateString('ru-RU', {
    month: 'long',
    year: 'numeric'
  });

  if (loading && employees.length === 0) {
    return (
      <div className="modal-overlay">
        <div className="loading-spinner">
          <div className="spinner"></div>
          <p>Загрузка данных...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="skud-page">
      <div className="skud-header">
        <div className="skud-title">
          <Shield size={24} />
          <h1>СКУД</h1>
        </div>
        <div className="skud-controls">
          <button onClick={prevMonth} className="btn-month-nav">
            <ChevronLeft size={18} />
          </button>
          <h2 style={{ textTransform: 'capitalize' }}>{monthName}</h2>
          <button onClick={nextMonth} className="btn-month-nav">
            <ChevronRight size={18} />
          </button>
        </div>
        {canEdit && (
          <div className="skud-actions">
            <label className="btn-import">
              <Upload size={18} />
              <span>{importing ? 'Загрузка...' : 'Загрузить данные'}</span>
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={handleImport}
                hidden
                disabled={importing}
              />
            </label>
          </div>
        )}
      </div>

      {error && (
        <div style={{ background: '#fef2f2', color: '#dc2626', padding: '12px', borderRadius: '8px', marginBottom: '16px' }}>
          {error}
          <button onClick={() => setError('')} style={{ marginLeft: '12px' }}>×</button>
        </div>
      )}

      <div className="skud-table-header">
        <div className="skud-legend">
          <span><strong>В ячейках:</strong></span>
          <span>верхняя — часы в офисе</span>
          <span>нижняя — время прихода</span>
        </div>
      </div>

      <div className="skud-table-wrapper">
        <table className="skud-table">
          <thead>
            <tr>
              <th className="skud-name-col">ФИО</th>
              {Array.from({ length: daysInMonth }, (_, i) => (
                <th key={i + 1} className="skud-day-col">{i + 1}</th>
              ))}
              <th className="skud-stats-col">Статистика</th>
            </tr>
          </thead>
          <tbody>
            {employees.map(emp => {
              const stats = getEmployeeStats(emp.id);

              return (
                <tr key={emp.id}>
                  <td className="skud-name-cell">{emp.full_name}</td>
                  {Array.from({ length: daysInMonth }, (_, i) => {
                    const day = i + 1;
                    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const dayOfWeek = new Date(date).getDay();
                    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                    const summary = getDaySummary(emp.id, day);

                    let className = 'skud-cell';
                    if (isWeekend) className += ' skud-weekend';
                    if (summary) className += ' skud-present';

                    return (
                      <td key={day} className={className}>
                        {summary && (
                          <div className="skud-cell-content">
                            <span className="skud-hours">{formatHours(summary.total_hours)}</span>
                            {summary.first_entry && (
                              <span className="skud-time">{summary.first_entry.slice(0, 5)}</span>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td className="skud-stats-cell">
                    {stats.totalDays > 0 ? (
                      <div className="skud-stats">
                        <span>Дней: {stats.totalDays}</span>
                        <span>Часов: {formatHours(stats.totalHours)}</span>
                        <span>Среднее: {formatHours(stats.avgHours)}</span>
                      </div>
                    ) : (
                      <span>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {importing && (
        <div className="modal-overlay">
          <div className="loading-spinner">
            <div className="spinner"></div>
            <p>Импорт данных...</p>
          </div>
        </div>
      )}
    </div>
  );
};
