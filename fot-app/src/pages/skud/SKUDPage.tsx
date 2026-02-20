import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Shield, Search, ChevronLeft, ChevronRight, LogIn, LogOut, Clock, MapPin, ChevronDown, X, Users } from 'lucide-react';
import { skudService } from '../../services/skudService';
import { employeeService } from '../../services/employeeService';
import { adminService } from '../../services/adminService';
import { useAuth } from '../../contexts/AuthContext';
import type { Employee, SkudEvent, Organization } from '../../types';
import '../../styles/SKUDPage.css';

const formatDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const formatDateRu = (d: Date): string =>
  d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'short' });

const formatTime = (t: string | null): string => t ? t.slice(0, 5) : '—';

const formatHours = (hours: number | null): string => {
  if (!hours) return '—';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}:${String(m).padStart(2, '0')}`;
};

interface DayEvent {
  events: SkudEvent[];
  firstEntry: string | null;
  lastExit: string | null;
  totalHours: number | null;
}

const computeDaySummary = (events: SkudEvent[]): DayEvent => {
  const sorted = [...events].sort((a, b) => a.event_time.localeCompare(b.event_time));
  const entries = sorted.filter(e => e.direction === 'entry');
  const exits = sorted.filter(e => e.direction !== 'entry');
  const firstEntry = entries[0]?.event_time ?? null;
  const lastExit = exits[exits.length - 1]?.event_time ?? null;
  let totalHours: number | null = null;
  if (firstEntry && lastExit && lastExit > firstEntry) {
    const [h1, m1] = firstEntry.split(':').map(Number);
    const [h2, m2] = lastExit.split(':').map(Number);
    totalHours = (h2 * 60 + m2 - h1 * 60 - m1) / 60;
  }
  return { events: sorted, firstEntry, lastExit, totalHours };
};

export const SKUDPage: React.FC = () => {
  const { hasPosition, profile } = useAuth();
  const isSuperAdmin = hasPosition('super_admin');
  const needsOrgSelector = isSuperAdmin && !profile?.organization_id;

  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const effectiveOrgId = needsOrgSelector ? (selectedOrgId ?? undefined) : undefined;

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [events, setEvents] = useState<SkudEvent[]>([]);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [orgFilter, setOrgFilter] = useState('');
  const [deptDropdownOpen, setDeptDropdownOpen] = useState(false);
  const [deptSearch, setDeptSearch] = useState('');
  const deptRef = useRef<HTMLDivElement>(null);

  // Закрытие dropdown при клике вне
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (deptRef.current && !deptRef.current.contains(e.target as Node)) {
        setDeptDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Загрузка организаций
  useEffect(() => {
    adminService.getOrganizations().then(orgs => {
      setOrganizations(orgs);
      if (needsOrgSelector && orgs.length === 1) {
        setSelectedOrgId(orgs[0].id);
      }
    }).catch(() => {});
  }, [needsOrgSelector]);

  // Карта org_id → name
  const orgMap = useMemo(() => {
    const m = new Map<string, string>();
    organizations.forEach(o => m.set(o.id, o.name));
    return m;
  }, [organizations]);

  const loadEmployees = useCallback(async () => {
    if (needsOrgSelector && !selectedOrgId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await employeeService.getAll(effectiveOrgId);
      const active = data.filter(e => !e.is_archived);
      active.sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'));
      setEmployees(active);
      setSelectedEmployee(prev => {
        if (prev && active.some(e => e.id === prev.id)) return prev;
        return active[0] || null;
      });
    } catch {
      // ошибка загрузки
    } finally {
      setLoading(false);
    }
  }, [effectiveOrgId, needsOrgSelector, selectedOrgId]);

  const loadEvents = useCallback(async (employeeId: number, date: Date) => {
    setLoadingEvents(true);
    try {
      const dateStr = formatDate(date);
      const data = await skudService.getEvents({
        startDate: dateStr,
        endDate: dateStr,
        employeeId: String(employeeId),
        organizationId: effectiveOrgId,
      });
      setEvents(data);
    } catch {
      setEvents([]);
    } finally {
      setLoadingEvents(false);
    }
  }, [effectiveOrgId]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  useEffect(() => {
    if (selectedEmployee) {
      loadEvents(selectedEmployee.id, selectedDate);
    } else {
      setEvents([]);
    }
  }, [selectedEmployee, selectedDate, loadEvents]);

  // Уникальные организации сотрудников (= отделы Sigur)
  const employeeOrgs = useMemo(() => {
    const ids = new Set(employees.map(e => e.organization_id));
    return organizations.filter(o => ids.has(o.id));
  }, [employees, organizations]);

  // Фильтрация сотрудников
  const filteredEmployees = useMemo(() => {
    let list = employees;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(e => e.full_name.toLowerCase().includes(q));
    }
    if (orgFilter) {
      list = list.filter(e => e.organization_id === orgFilter);
    }
    return list;
  }, [employees, searchQuery, orgFilter]);

  // Фильтрация организаций в dropdown
  const filteredOrgs = useMemo(() => {
    if (!deptSearch) return employeeOrgs;
    const q = deptSearch.toLowerCase();
    return employeeOrgs.filter(o => o.name.toLowerCase().includes(q));
  }, [employeeOrgs, deptSearch]);

  const prevDay = () => setSelectedDate(d => { const n = new Date(d); n.setDate(n.getDate() - 1); return n; });
  const nextDay = () => setSelectedDate(d => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; });

  const daySummary = useMemo(() => computeDaySummary(events), [events]);

  if (loading) {
    return (
      <div className="modal-overlay">
        <div className="loading-spinner">
          <div className="spinner"></div>
          <p>Загрузка данных...</p>
        </div>
      </div>
    );
  }

  // Super_admin без организации — селектор
  if (needsOrgSelector && !selectedOrgId) {
    return (
      <div className="skud-page">
        <div className="skud-header">
          <div className="skud-title">
            <Shield size={24} />
            <h1>СКУД</h1>
          </div>
        </div>
        <div className="skud-org-selector">
          <p>Выберите организацию:</p>
          <div className="skud-org-list">
            {organizations.map(org => (
              <button
                key={org.id}
                className="skud-org-item"
                onClick={() => setSelectedOrgId(org.id)}
              >
                {org.name}
              </button>
            ))}
          </div>
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
          <span className="skud-emp-count">{filteredEmployees.length}</span>
        </div>
        {needsOrgSelector && selectedOrgId && (
          <button
            className="skud-change-org"
            onClick={() => { setSelectedOrgId(null); setEmployees([]); setSelectedEmployee(null); }}
          >
            {orgMap.get(selectedOrgId) || 'Организация'} ✕
          </button>
        )}
      </div>

      {/* Фильтры */}
      <div className="skud-filters">
        <div className="skud-search-wrap">
          <Search size={16} className="skud-search-icon" />
          <input
            type="text"
            placeholder="Поиск по ФИО..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="skud-search-input"
          />
          {searchQuery && (
            <button className="skud-search-clear" onClick={() => setSearchQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>

        {employeeOrgs.length > 1 && (
          <div className="skud-dept-filter" ref={deptRef}>
            <button
              className={`skud-dept-btn ${orgFilter ? 'active' : ''}`}
              onClick={() => { setDeptDropdownOpen(v => !v); setDeptSearch(''); }}
            >
              <Users size={15} />
              <span>{orgFilter ? orgMap.get(orgFilter) || 'Отдел' : 'Все отделы'}</span>
              <ChevronDown size={14} className={`skud-dept-chevron ${deptDropdownOpen ? 'open' : ''}`} />
            </button>
            {orgFilter && (
              <button
                className="skud-dept-clear"
                onClick={e => { e.stopPropagation(); setOrgFilter(''); setDeptDropdownOpen(false); }}
              >
                <X size={14} />
              </button>
            )}
            {deptDropdownOpen && (
              <div className="skud-dept-dropdown">
                <div className="skud-dept-dropdown-search">
                  <Search size={14} />
                  <input
                    type="text"
                    placeholder="Найти отдел..."
                    value={deptSearch}
                    onChange={e => setDeptSearch(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="skud-dept-dropdown-list">
                  <div
                    className={`skud-dept-option ${!orgFilter ? 'selected' : ''}`}
                    onClick={() => { setOrgFilter(''); setDeptDropdownOpen(false); }}
                  >
                    Все отделы
                  </div>
                  {filteredOrgs.map(o => (
                    <div
                      key={o.id}
                      className={`skud-dept-option ${orgFilter === o.id ? 'selected' : ''}`}
                      onClick={() => { setOrgFilter(o.id); setDeptDropdownOpen(false); }}
                    >
                      {o.name}
                    </div>
                  ))}
                  {filteredOrgs.length === 0 && (
                    <div className="skud-dept-empty">Не найдено</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Контент: список + детали */}
      <div className="skud-cards-layout">
        {/* Левая панель: сотрудники */}
        <div className="skud-cards-list">
          {filteredEmployees.length === 0 ? (
            <div className="skud-empty-list">Сотрудники не найдены</div>
          ) : (
            filteredEmployees.map(emp => (
              <div
                key={emp.id}
                className={`skud-card-item ${selectedEmployee?.id === emp.id ? 'selected' : ''}`}
                onClick={() => setSelectedEmployee(emp)}
              >
                <div className="skud-card-info">
                  <span className="skud-card-name">{emp.full_name}</span>
                  <span className="skud-card-position">
                    {orgMap.get(emp.organization_id) || emp.position}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Правая панель: карточка сотрудника */}
        <div className="skud-cards-detail">
          {selectedEmployee ? (
            <div className="skud-detail-content">
              <div className="skud-detail-header">
                <div>
                  <h3>{selectedEmployee.full_name}</h3>
                  <span className="skud-detail-position">
                    {[orgMap.get(selectedEmployee.organization_id), selectedEmployee.position].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </div>

              {/* Навигация по дням */}
              <div className="skud-date-nav">
                <button onClick={prevDay} className="btn-month-nav"><ChevronLeft size={18} /></button>
                <span className="skud-date-label">{formatDateRu(selectedDate)}</span>
                <button onClick={nextDay} className="btn-month-nav"><ChevronRight size={18} /></button>
                <button className="skud-date-today" onClick={() => setSelectedDate(new Date())}>
                  Сегодня
                </button>
              </div>

              {/* Сводка дня */}
              {!loadingEvents && events.length > 0 && (
                <div className="skud-day-summary-bar">
                  {daySummary.firstEntry && (
                    <span className="time-badge entry"><LogIn size={12} />{formatTime(daySummary.firstEntry)}</span>
                  )}
                  {daySummary.lastExit && (
                    <span className="time-badge exit"><LogOut size={12} />{formatTime(daySummary.lastExit)}</span>
                  )}
                  {daySummary.totalHours && (
                    <span className="time-badge total"><Clock size={12} />{formatHours(daySummary.totalHours)}</span>
                  )}
                </div>
              )}

              {/* События */}
              <div className="skud-events-section">
                {loadingEvents ? (
                  <div className="events-loading"><div className="spinner small"></div></div>
                ) : events.length === 0 ? (
                  <div className="events-empty">Нет событий за этот день</div>
                ) : (
                  <div className="skud-events-list">
                    {daySummary.events.map((event, idx) => {
                      const isExit = event.direction !== 'entry';
                      let gapTime: string | null = null;
                      if (isExit && idx < daySummary.events.length - 1) {
                        const next = daySummary.events[idx + 1];
                        if (next.direction === 'entry') {
                          const [h1, m1] = event.event_time.split(':').map(Number);
                          const [h2, m2] = next.event_time.split(':').map(Number);
                          const diff = h2 * 60 + m2 - h1 * 60 - m1;
                          if (diff > 0) {
                            const hours = Math.floor(diff / 60);
                            const mins = diff % 60;
                            gapTime = hours > 0 ? `${hours}ч ${mins}м` : `${mins}м`;
                          }
                        }
                      }
                      return (
                        <div key={idx} className="event-row-wrapper">
                          <div className="event-row">
                            <span className="event-time">{formatTime(event.event_time)}</span>
                            <span className={`event-direction ${event.direction === 'entry' ? 'entry' : 'exit'}`}>
                              {event.direction === 'entry' ? 'вход' : 'выход'}
                            </span>
                            {event.access_point && (
                              <span className="event-location"><MapPin size={12} />{event.access_point}</span>
                            )}
                          </div>
                          {gapTime && (
                            <div className="event-gap">
                              <span className="gap-line"></span>
                              <span className="gap-time">{gapTime}</span>
                              <span className="gap-line"></span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="skud-detail-placeholder">Выберите сотрудника из списка</div>
          )}
        </div>
      </div>
    </div>
  );
};
