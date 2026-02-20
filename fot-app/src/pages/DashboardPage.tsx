import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { StatCard } from '../components/ui/StatCard';
import { ActivityList } from '../components/dashboard/ActivityList';
import { PresenceProgress } from '../components/dashboard/PresenceProgress';
import { QuickActions } from '../components/dashboard/QuickActions';
import { usePresence } from '../hooks/usePresence';
import { apiClient } from '../api/client';
import {
  UsersIcon,
  MapPinIcon,
  CheckCircleIcon,
} from '../components/ui/Icons';
import '../styles/DashboardPage.css';

interface IDbDepartment {
  id: string;
  name: string;
  parent_id: string | null;
  children: IDbDepartment[];
}

interface IDeptFlatOption {
  id: string;
  name: string;
  level: number;
}

const flattenDbTree = (nodes: IDbDepartment[], level = 0): IDeptFlatOption[] => {
  const result: IDeptFlatOption[] = [];
  for (const node of nodes) {
    result.push({ id: node.id, name: node.name, level });
    result.push(...flattenDbTree(node.children, level + 1));
  }
  return result;
};

export const DashboardPage: React.FC = () => {
  const today = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  // Department selector
  const [deptOptions, setDeptOptions] = useState<IDeptFlatOption[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [deptDropdownOpen, setDeptDropdownOpen] = useState(false);
  const [deptSearchQuery, setDeptSearchQuery] = useState('');
  const deptDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiClient.get<{ success: boolean; data: { departments: IDbDepartment[] } }>('/structure')
      .then(res => {
        const departments = res.data?.departments || [];
        setDeptOptions(flattenDbTree(departments));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (deptDropdownRef.current && !deptDropdownRef.current.contains(e.target as Node)) {
        setDeptDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedDept = useMemo(
    () => selectedDeptId ? deptOptions.find(d => d.id === selectedDeptId) : null,
    [selectedDeptId, deptOptions],
  );

  const filteredDeptOptions = useMemo(() => {
    if (!deptSearchQuery) return deptOptions;
    const q = deptSearchQuery.toLowerCase();
    return deptOptions.filter(d => d.name.toLowerCase().includes(q));
  }, [deptOptions, deptSearchQuery]);

  // Presence data
  const { employees, loading } = usePresence(selectedDeptId);

  const onlineCount = useMemo(
    () => employees.filter(e => e.status === 'online').length,
    [employees],
  );

  const offlineCount = useMemo(
    () => employees.filter(e => e.status === 'offline').length,
    [employees],
  );

  return (
    <>
      <div className="content-header">
        <div className="date-display">{today}</div>
        <div className="dash-dept-dropdown" ref={deptDropdownRef}>
          <button
            className={`dash-dept-trigger ${selectedDeptId ? 'has-value' : ''}`}
            onClick={() => { setDeptDropdownOpen(!deptDropdownOpen); setDeptSearchQuery(''); }}
          >
            <span className="dash-dept-label">
              {selectedDept ? selectedDept.name : 'Все отделы'}
            </span>
            <ChevronDown size={14} className={`dash-dept-chevron ${deptDropdownOpen ? 'open' : ''}`} />
          </button>
          {deptDropdownOpen && (
            <div className="dash-dept-menu">
              <div className="dash-dept-search">
                <Search size={14} />
                <input
                  type="text"
                  placeholder="Поиск отдела..."
                  value={deptSearchQuery}
                  onChange={e => setDeptSearchQuery(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="dash-dept-list">
                <div
                  className={`dash-dept-item ${!selectedDeptId ? 'selected' : ''}`}
                  onClick={() => { setSelectedDeptId(null); setDeptDropdownOpen(false); }}
                >
                  Все отделы
                </div>
                {filteredDeptOptions.map(dept => (
                  <div
                    key={dept.id}
                    className={`dash-dept-item ${selectedDeptId === dept.id ? 'selected' : ''}`}
                    style={{ paddingLeft: 12 + dept.level * 16 }}
                    onClick={() => { setSelectedDeptId(dept.id); setDeptDropdownOpen(false); }}
                  >
                    {dept.name}
                  </div>
                ))}
                {filteredDeptOptions.length === 0 && (
                  <div className="dash-dept-empty">Не найдено</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="stats-grid">
        <StatCard
          label="Всего сотрудников"
          value={employees.length > 0 ? String(employees.length) : '—'}
          icon={<UsersIcon />}
          iconType="blue"
        />
        <StatCard
          label="На работе"
          value={onlineCount > 0 ? String(onlineCount) : '—'}
          icon={<MapPinIcon />}
          iconType="green"
        />
        <StatCard
          label="Ушли"
          value={offlineCount > 0 ? String(offlineCount) : '—'}
          icon={<CheckCircleIcon />}
          iconType="orange"
        />
      </div>

      <div className="content-grid">
        <ActivityList employees={employees} loading={loading} />
        <div className="right-column">
          <PresenceProgress employees={employees} loading={loading} />
          <QuickActions />
        </div>
      </div>
    </>
  );
};
