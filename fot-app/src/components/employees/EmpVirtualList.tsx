import { useRef, type FC } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Users } from 'lucide-react';
import type { Employee, IEmployeePresence } from '../../types';

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.[0] || '?').toUpperCase();
};

const formatTime = (val: string): string => {
  if (val.includes('T')) return val.slice(11, 16);
  return val.slice(0, 5);
};

interface IEmpVirtualListProps {
  employees: Employee[];
  loading: boolean;
  selectedEmps: Set<number>;
  presenceMap: Map<number, IEmployeePresence>;
  canEdit: boolean;
  onEmpClick: (emp: Employee) => void;
  onToggleSelection: (id: number, e: React.MouseEvent) => void;
  onFire: (emp: Employee, e: React.MouseEvent) => void;
  onRehire: (emp: Employee, e: React.MouseEvent) => void;
  onMove: (id: number, e: React.MouseEvent) => void;
}

export const EmpVirtualList: FC<IEmpVirtualListProps> = ({
  employees, loading, selectedEmps, presenceMap, canEdit,
  onEmpClick, onToggleSelection, onFire, onRehire, onMove,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: employees.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 72,
    overscan: 10,
  });

  if (loading) return <div className="ep-emp-list"><div className="ep-loading">Загрузка...</div></div>;
  if (employees.length === 0) {
    return (
      <div className="ep-emp-list">
        <div className="ep-empty">
          <div className="ep-empty-icon"><Users size={28} /></div>
          <h3>Сотрудники не найдены</h3>
          <p>Попробуйте изменить фильтры или выбрать другой отдел</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ep-emp-list" ref={listRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vRow => {
          const emp = employees[vRow.index];
          return (
            <div
              key={emp.id}
              className={`ep-emp-card ${selectedEmps.has(emp.id) ? 'selected' : ''}`}
              onClick={() => onEmpClick(emp)}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vRow.start}px)` }}
            >
              <div
                className={`ep-emp-checkbox ${selectedEmps.has(emp.id) ? 'checked' : ''}`}
                onClick={e => onToggleSelection(emp.id, e)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div className="ep-emp-avatar">{getInitials(emp.full_name)}</div>
              <div className="ep-emp-info">
                <div className="ep-emp-name">
                  {emp.full_name}
                  {presenceMap.has(emp.id) && (
                    <span
                      className={`ep-emp-badge ${presenceMap.get(emp.id)!.status}`}
                      title={presenceMap.get(emp.id)!.status === 'online' ? 'На месте' : 'Отсутствует'}
                    />
                  )}
                </div>
                <div className="ep-emp-position">{emp.position_name || '—'}</div>
              </div>
              {emp.employment_status !== 'fired' && presenceMap.has(emp.id) && (
                <div className="ep-emp-meta">
                  {presenceMap.get(emp.id)!.total_hours != null && (
                    <div className="ep-emp-stat">
                      <span className="ep-emp-stat-value">
                        {presenceMap.get(emp.id)!.total_hours!.toFixed(1)}ч
                      </span>
                      <span className="ep-emp-stat-label">Сегодня</span>
                    </div>
                  )}
                  {presenceMap.get(emp.id)!.first_entry && (
                    <div className="ep-emp-stat">
                      <span className="ep-emp-stat-value">
                        {formatTime(presenceMap.get(emp.id)!.first_entry!)}
                      </span>
                      <span className="ep-emp-stat-label">Вход</span>
                    </div>
                  )}
                </div>
              )}
              {canEdit && emp.employment_status !== 'fired' && (
                <div className="ep-emp-actions">
                  <button className="ep-action-btn dismiss" onClick={e => onFire(emp, e)}>
                    Уволить
                  </button>
                  <button className="ep-action-btn move" onClick={e => onMove(emp.id, e)}>
                    Переместить
                  </button>
                </div>
              )}
              {emp.employment_status === 'fired' && (
                <div className="ep-emp-actions">
                  <button className="ep-action-btn move" onClick={e => onRehire(emp, e)}>
                    Восстановить
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
