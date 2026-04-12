import { type FC, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, Route, Search } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useStructureTree } from '../../hooks/useStructure';
import { travelTimeService } from '../../services/travelTimeService';
import type { ITravelSegment, OrgDepartmentNode, TravelSegmentStatus } from '../../types';
import './TravelSegmentsPage.css';

interface IDeptOption {
  id: string;
  name: string;
}

const STATUS_OPTIONS: Array<{ value: TravelSegmentStatus | 'all' | 'problem'; label: string }> = [
  { value: 'problem', label: 'Только проблемы' },
  { value: 'all', label: 'Все сегменты' },
  { value: 'auto_approved', label: 'Автозачтено' },
  { value: 'delayed', label: 'Есть задержка' },
  { value: 'needs_object', label: 'Нет объекта' },
  { value: 'needs_route', label: 'Нет маршрута' },
];

const STATUS_LABELS: Record<TravelSegmentStatus, string> = {
  auto_approved: 'Автозачтено',
  delayed: 'Задержка',
  needs_object: 'Нет объекта',
  needs_route: 'Нет маршрута',
};

const flattenTree = (nodes: OrgDepartmentNode[]): IDeptOption[] => {
  const result: IDeptOption[] = [];
  for (const node of nodes) {
    result.push({ id: node.id, name: node.name });
    if (node.children?.length) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
};

const formatMinutes = (minutes: number | null): string => {
  if (minutes == null) return '—';
  if (minutes === 0) return '0 мин';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} мин`;
  if (mins === 0) return `${hours}ч`;
  return `${hours}ч ${mins}м`;
};

const formatDate = (iso: string): string => {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
};

const formatTime = (value: string): string => value.slice(0, 5);

const statusClassName = (status: TravelSegmentStatus): string => {
  switch (status) {
    case 'auto_approved':
      return 'travel-segments-status auto';
    case 'delayed':
      return 'travel-segments-status delayed';
    case 'needs_object':
    case 'needs_route':
      return 'travel-segments-status problem';
  }
};
const EMPTY_SEGMENTS: ITravelSegment[] = [];

export const TravelSegmentsPage: FC = () => {
  const { hasPermission, profile } = useAuth();
  const queryClient = useQueryClient();
  const structureQuery = useStructureTree();
  const isDepartmentScope = hasPermission('data.scope.department') && !hasPermission('data.scope.all');
  const scopePending = isDepartmentScope && !profile?.department_id;
  const now = new Date();
  const initialMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const [month, setMonth] = useState(initialMonth);
  const [status, setStatus] = useState<TravelSegmentStatus | 'all' | 'problem'>('problem');
  const [search, setSearch] = useState('');
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const effectiveDepartmentId = isDepartmentScope
    ? (profile?.department_id || null)
    : selectedDeptId;
  const deptOptions = useMemo(
    () => flattenTree(structureQuery.data?.departments || []),
    [structureQuery.data],
  );

  const segmentsQuery = useQuery({
    queryKey: ['travel-segments', month, effectiveDepartmentId || 'all', status],
    queryFn: () => travelTimeService.getSegments({
      month,
      department_id: effectiveDepartmentId || undefined,
      status,
    }),
    enabled: !scopePending,
    staleTime: 60_000,
    placeholderData: previousData => previousData,
  });

  const segments = segmentsQuery.data ?? EMPTY_SEGMENTS;
  const loading = scopePending || (segmentsQuery.isLoading && !segmentsQuery.data);
  const error = actionError || (segmentsQuery.error instanceof Error ? segmentsQuery.error.message : null);

  const filteredSegments = useMemo(() => {
    if (!search.trim()) return segments;
    const query = search.trim().toLowerCase();
    return segments.filter(segment => [
      segment.employee_name,
      segment.department_name,
      segment.from_object_name,
      segment.to_object_name,
      segment.from_access_point_name,
      segment.to_access_point_name,
    ].some(value => (value || '').toLowerCase().includes(query)));
  }, [segments, search]);

  const summary = useMemo(() => {
    const totalCredited = filteredSegments.reduce((sum, segment) => sum + segment.credited_minutes, 0);
    const totalDelay = filteredSegments.reduce((sum, segment) => sum + segment.delay_minutes, 0);
    const autoApproved = filteredSegments.filter(segment => segment.status === 'auto_approved').length;
    const delayed = filteredSegments.filter(segment => segment.status === 'delayed').length;
    const problems = filteredSegments.filter(segment => segment.status === 'needs_object' || segment.status === 'needs_route').length;
    return {
      total: filteredSegments.length,
      autoApproved,
      delayed,
      problems,
      totalCredited,
      totalDelay,
    };
  }, [filteredSegments]);

  const handleRebuild = async () => {
    setRebuilding(true);
    setActionError(null);
    try {
      await travelTimeService.rebuildSegments({
        month,
        department_id: effectiveDepartmentId || undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ['travel-segments'] });
    } catch (rebuildError) {
      setActionError(rebuildError instanceof Error ? rebuildError.message : 'Ошибка пересчёта');
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="travel-segments-page">
      <div className="travel-segments-header">
        <div>
          <h1>Передвижения между объектами</h1>
          <p>Система автоматически засчитывает дорогу по правилу 1.5 x T и выделяет отклонения.</p>
        </div>
        <button className="travel-segments-btn travel-segments-btn-primary" onClick={handleRebuild} disabled={rebuilding}>
          <RefreshCw size={16} className={rebuilding ? 'travel-spin' : ''} />
          {rebuilding ? 'Пересчёт...' : 'Пересчитать'}
        </button>
      </div>

      <div className="travel-segments-toolbar">
        <div className="travel-segments-filters">
          <label>
            <span>Месяц</span>
            <input type="month" value={month} onChange={event => setMonth(event.target.value)} />
          </label>

          {!isDepartmentScope && (
            <label>
              <span>Отдел</span>
              <select value={selectedDeptId || ''} onChange={event => setSelectedDeptId(event.target.value || null)}>
                <option value="">Все отделы</option>
                {deptOptions.map(option => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </label>
          )}

          <label>
            <span>Статус</span>
            <select value={status} onChange={event => setStatus(event.target.value as TravelSegmentStatus | 'all' | 'problem')}>
              {STATUS_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="travel-segments-search">
          <Search size={15} />
          <input
            type="text"
            placeholder="Поиск по сотруднику, объекту, точке"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </label>
      </div>

      {error && (
        <div className="travel-segments-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="travel-segments-summary">
        <div className="travel-segments-card">
          <span>Сегментов</span>
          <strong>{summary.total}</strong>
        </div>
        <div className="travel-segments-card">
          <span>Автозачтено</span>
          <strong>{summary.autoApproved}</strong>
        </div>
        <div className="travel-segments-card">
          <span>С задержкой</span>
          <strong>{summary.delayed}</strong>
        </div>
        <div className="travel-segments-card">
          <span>Без настройки</span>
          <strong>{summary.problems}</strong>
        </div>
        <div className="travel-segments-card">
          <span>Засчитано времени</span>
          <strong>{formatMinutes(summary.totalCredited)}</strong>
        </div>
        <div className="travel-segments-card">
          <span>Суммарная задержка</span>
          <strong>{formatMinutes(summary.totalDelay)}</strong>
        </div>
      </div>

      <div className="travel-segments-table-wrap">
        <table className="travel-segments-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Сотрудник</th>
              <th>Маршрут</th>
              <th>Время</th>
              <th>Факт</th>
              <th>T / лимит</th>
              <th>Засчитано</th>
              <th>Задержка</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="travel-segments-empty">Загрузка...</td>
              </tr>
            ) : filteredSegments.length === 0 ? (
              <tr>
                <td colSpan={9} className="travel-segments-empty">
                  Нет данных по текущим фильтрам. Если сегменты ещё не рассчитаны, нажмите «Пересчитать».
                </td>
              </tr>
            ) : filteredSegments.map(segment => (
              <tr key={segment.id}>
                <td>{formatDate(segment.work_date)}</td>
                <td>
                  <div className="travel-segments-employee">{segment.employee_name}</div>
                  <div className="travel-segments-secondary">{segment.department_name || '—'}</div>
                </td>
                <td>
                  <div className="travel-segments-route">
                    <Route size={14} />
                    <span>{segment.from_object_name || 'Не назначено'} {'->'} {segment.to_object_name || 'Не назначено'}</span>
                  </div>
                  <div className="travel-segments-secondary">
                    {segment.from_access_point_name || '—'} {'->'} {segment.to_access_point_name || '—'}
                  </div>
                </td>
                <td>
                  {formatTime(segment.exit_time)} - {formatTime(segment.entry_time)}
                </td>
                <td>{formatMinutes(segment.actual_minutes)}</td>
                <td>
                  <div>{formatMinutes(segment.norm_minutes)}</div>
                  <div className="travel-segments-secondary">{formatMinutes(segment.max_credit_minutes)}</div>
                </td>
                <td>{formatMinutes(segment.credited_minutes)}</td>
                <td>{formatMinutes(segment.delay_minutes)}</td>
                <td>
                  <span className={statusClassName(segment.status)}>
                    {STATUS_LABELS[segment.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
