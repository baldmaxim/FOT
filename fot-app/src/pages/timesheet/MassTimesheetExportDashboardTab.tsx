import { type FC, useMemo, useState, useCallback, useEffect } from 'react';
import {
  ChevronLeft, ChevronRight, ChevronDown, AlertTriangle, CheckCircle2, Clock, Users, Building2,
  SlidersHorizontal, X, RotateCcw, Circle, UserX, CheckSquare, MinusSquare, Square, type LucideIcon,
} from 'lucide-react';
import { getMonthLabel } from '../../utils/calendarUtils';
import {
  formatHalfLabel,
  getCurrentHalf,
  getHalfRange,
  type TimesheetHalf,
} from '../../utils/timesheetApprovalPeriod';
import { useTimesheetApprovalDashboard } from '../../hooks/useTimesheetApprovalData';
import { SearchInput } from '../../components/ui/SearchInput';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type {
  ITimesheetDashboardManager,
  ITimesheetDashboardNotSubmittedManager,
  ITimesheetDashboardUnassignedDept,
  ITimesheetDashboardDeptStatus,
  ITimesheetDashboardScopeDept,
  DepartmentSubmissionStatus,
} from '../../services/timesheetApprovalService';
import './MassTimesheetExportDashboardTab.css';

const ROLE_LABEL: Record<string, string> = {
  manager: 'Руководитель',
  manager_obj: 'Руководитель строительства',
  site_supervisor: 'Начальник участка',
};
const roleLabel = (code: string): string => ROLE_LABEL[code] ?? code;

const pluralEmployees = (n: number): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'сотрудник';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'сотрудника';
  return 'сотрудников';
};

const STATUS_META: Record<DepartmentSubmissionStatus, { label: string; cls: string; icon: LucideIcon }> = {
  approved: { label: 'Утверждён', cls: 'approved', icon: CheckCircle2 },
  submitted: { label: 'Подан', cls: 'submitted', icon: Clock },
  returned: { label: 'Возвращён', cls: 'returned', icon: RotateCcw },
  not_submitted: { label: 'Не подан', cls: 'not', icon: Circle },
};
const STATUS_ORDER: DepartmentSubmissionStatus[] = ['approved', 'submitted', 'returned', 'not_submitted'];

const SEARCH_THRESHOLD = 8;
const DEPT_FILTER_STORAGE_KEY = 'timesheet_dashboard_departments_v1';

const loadStoredDeptFilter = (): string[] | undefined => {
  try {
    const raw = localStorage.getItem(DEPT_FILTER_STORAGE_KEY);
    if (raw == null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // ignore
  }
  return undefined;
};

const saveStoredDeptFilter = (ids: string[] | undefined): void => {
  try {
    if (ids === undefined) localStorage.removeItem(DEPT_FILTER_STORAGE_KEY);
    else localStorage.setItem(DEPT_FILTER_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
};

const includesQuery = (haystack: string, query: string): boolean =>
  haystack.toLowerCase().includes(query.trim().toLowerCase());

// Сворачиваемые нижние блоки. По умолчанию свёрнуты; выбор хранится в localStorage.
const COLLAPSE_STORAGE_KEY = 'timesheet_dashboard_collapsed_v1';
const COLLAPSIBLE_SECTIONS = ['heatmap', 'not_submitted', 'unassigned'] as const;

const loadCollapsed = (): Set<string> => {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (raw == null) return new Set(COLLAPSIBLE_SECTIONS);
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    // ignore
  }
  return new Set(COLLAPSIBLE_SECTIONS);
};

interface IScopeTreeNode {
  id: string;
  name: string;
  countable: boolean;
  children: IScopeTreeNode[];
}

/** Дерево отделов из плоского scope_departments (по parent_id). Ветки без countable-узлов вырезаются. */
const buildScopeTree = (depts: ITimesheetDashboardScopeDept[]): IScopeTreeNode[] => {
  const byId = new Map<string, IScopeTreeNode>();
  for (const d of depts) {
    byId.set(d.department_id, { id: d.department_id, name: d.name, countable: d.countable, children: [] });
  }
  const roots: IScopeTreeNode[] = [];
  for (const d of depts) {
    const node = byId.get(d.department_id);
    if (!node) continue;
    const parent = d.parent_id ? byId.get(d.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes: IScopeTreeNode[]): void => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    nodes.forEach(n => sortRec(n.children));
  };
  sortRec(roots);
  const prune = (nodes: IScopeTreeNode[]): IScopeTreeNode[] =>
    nodes
      .map(n => ({ ...n, children: prune(n.children) }))
      .filter(n => n.countable || n.children.length > 0);
  return prune(roots);
};

/** Countable-id поддерева (включая сам узел, если countable) — для каскада и tri-state. */
const collectCountableIds = (node: IScopeTreeNode): string[] => {
  const ids: string[] = [];
  if (node.countable) ids.push(node.id);
  for (const c of node.children) ids.push(...collectCountableIds(c));
  return ids;
};

const filterScopeTree = (nodes: IScopeTreeNode[], query: string): IScopeTreeNode[] => {
  if (!query) return nodes;
  const res: IScopeTreeNode[] = [];
  for (const n of nodes) {
    const kids = filterScopeTree(n.children, query);
    if (n.name.toLowerCase().includes(query) || kids.length > 0) res.push({ ...n, children: kids });
  }
  return res;
};

interface IScopeTreeNodeProps {
  node: IScopeTreeNode;
  checked: Set<string>;
  onToggle: (ids: string[], checked: boolean) => void;
  expanded: Set<string>;
  onExpand: (id: string) => void;
}

const ScopeTreeNode: FC<IScopeTreeNodeProps> = ({ node, checked, onToggle, expanded, onExpand }) => {
  const countableIds = useMemo(() => collectCountableIds(node), [node]);
  const checkedCount = countableIds.reduce((acc, id) => acc + (checked.has(id) ? 1 : 0), 0);
  const isAll = countableIds.length > 0 && checkedCount === countableIds.length;
  const isPartial = checkedCount > 0 && !isAll;
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.id);
  const active = isAll || isPartial;
  const CheckIcon = isAll ? CheckSquare : isPartial ? MinusSquare : Square;
  const handleCheck = () => { if (countableIds.length > 0) onToggle(countableIds, !isAll); };

  return (
    <div className="mte-tree-node">
      <div className={`mte-tree-row ${active ? 'mte-tree-row--checked' : ''}`}>
        {hasChildren ? (
          <button type="button" className="mte-tree-expand" onClick={() => onExpand(node.id)}>
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="mte-tree-expand mte-tree-expand--placeholder" />
        )}
        <button type="button" className="mte-tree-check" onClick={handleCheck} disabled={countableIds.length === 0}>
          <CheckIcon size={18} className={active ? 'mte-check-active' : 'mte-check-inactive'} />
        </button>
        <span className="mte-tree-name" onClick={handleCheck}>{node.name}</span>
      </div>
      {hasChildren && isExpanded && (
        <div className="mte-tree-children">
          {node.children.map(c => (
            <ScopeTreeNode
              key={c.id}
              node={c}
              checked={checked}
              onToggle={onToggle}
              expanded={expanded}
              onExpand={onExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface IStatCardProps {
  label: string;
  value: number;
  total?: number;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  icon: React.ReactNode;
}

const StatCard: FC<IStatCardProps> = ({ label, value, total, tone, icon }) => (
  <div className={`mte-dash-stat mte-dash-stat--${tone}`}>
    <div className="mte-dash-stat__icon" aria-hidden="true">{icon}</div>
    <div className="mte-dash-stat__body">
      <div className="mte-dash-stat__value">
        {value}
        {typeof total === 'number' && <span className="mte-dash-stat__total"> / {total}</span>}
      </div>
      <div className="mte-dash-stat__label">{label}</div>
    </div>
  </div>
);

interface ICollapsibleHeaderProps {
  title: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
}

const CollapsibleHeader: FC<ICollapsibleHeaderProps> = ({ title, collapsed, onToggle }) => (
  <button
    type="button"
    className="mte-dash__h2 mte-dash__h2--toggle"
    onClick={onToggle}
    aria-expanded={!collapsed}
  >
    {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
    {title}
  </button>
);

export const MassTimesheetExportDashboardTab: FC = () => {
  const now = useMemo(() => new Date(), []);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [half, setHalf] = useState<TimesheetHalf>(() => {
    const current = getCurrentHalf(now);
    return (current.year === now.getFullYear() && current.month === now.getMonth() + 1) ? current.half : 'H1';
  });

  const range = useMemo(() => getHalfRange(year, month, half), [year, month, half]);

  const prevMonth = useCallback(() => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }, [month]);

  const nextMonth = useCallback(() => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }, [month]);

  // Фильтр отделов (кнопка «Настройки»). undefined — без фильтра; массив (в т.ч. []) — фильтр.
  const [appliedDeptIds, setAppliedDeptIds] = useState<string[] | undefined>(() => loadStoredDeptFilter());

  const { data, isLoading, isError } = useTimesheetApprovalDashboard(range.startDate, range.endDate, appliedDeptIds);

  const totals = data?.approvals.totals;
  const notSubmittedManagers: ITimesheetDashboardNotSubmittedManager[] = data?.approvals.not_submitted_managers ?? [];
  const unassignedDepts: ITimesheetDashboardUnassignedDept[] = data?.approvals.unassigned_departments ?? [];
  const deptStatusMap: ITimesheetDashboardDeptStatus[] = data?.approvals.department_status_map ?? [];
  const managers: ITimesheetDashboardManager[] = data?.managers.list ?? [];
  const scopeDepts: ITimesheetDashboardScopeDept[] = data?.scope_departments ?? [];

  // Поиск по блокам.
  const [searchHeatmap, setSearchHeatmap] = useState('');
  const [searchNsMgr, setSearchNsMgr] = useState('');
  const [searchUnassigned, setSearchUnassigned] = useState('');
  const [searchManagers, setSearchManagers] = useState('');

  const heatmapShown = useMemo(
    () => deptStatusMap.filter(d => !searchHeatmap || includesQuery(`${d.name} ${d.parent_path}`, searchHeatmap)),
    [deptStatusMap, searchHeatmap],
  );
  const nsMgrShown = useMemo(
    () => notSubmittedManagers.filter(m => !searchNsMgr || includesQuery(`${m.full_name} ${m.department_path}`, searchNsMgr)),
    [notSubmittedManagers, searchNsMgr],
  );
  const unassignedShown = useMemo(
    () => unassignedDepts.filter(d => !searchUnassigned || includesQuery(`${d.department_name} ${d.parent_path}`, searchUnassigned)),
    [unassignedDepts, searchUnassigned],
  );
  const managersShown = useMemo(
    () => managers.filter(m => !searchManagers || includesQuery(
      `${m.full_name} ${m.departments.map(d => d.name).join(' ')} ${m.assigned_employees.map(e => e.full_name).join(' ')}`,
      searchManagers,
    )),
    [managers, searchManagers],
  );

  // Сворачивание нижних блоков (свёрнуты по умолчанию, состояние в localStorage).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
  const toggleSection = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Дерево отделов для пикера + список countable-id (только уровень ≥ 3 участвует в отборе).
  const scopeTree = useMemo(() => buildScopeTree(scopeDepts), [scopeDepts]);
  const countableIdList = useMemo(
    () => scopeDepts.filter(d => d.countable).map(d => d.department_id),
    [scopeDepts],
  );

  // Модалка настроек фильтра.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modalSearch, setModalSearch] = useState('');
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [expandedTree, setExpandedTree] = useState<Set<string>>(new Set());

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const overlayHandlers = useOverlayDismiss(closeSettings);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettingsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  const openSettings = useCallback(() => {
    setDraft(new Set(appliedDeptIds ?? countableIdList));
    setExpandedTree(new Set(scopeDepts.map(d => d.department_id)));
    setModalSearch('');
    setSettingsOpen(true);
  }, [appliedDeptIds, countableIdList, scopeDepts]);

  const onTreeToggle = useCallback((ids: string[], checked: boolean) => {
    setDraft(prev => {
      const next = new Set(prev);
      for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
      return next;
    });
  }, []);

  const toggleTreeExpand = useCallback((id: string) => {
    setExpandedTree(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const applySettings = useCallback(() => {
    const next = countableIdList.filter(id => draft.has(id));
    const applied = next.length === countableIdList.length ? undefined : next;
    setAppliedDeptIds(applied);
    saveStoredDeptFilter(applied);
    setSettingsOpen(false);
  }, [countableIdList, draft]);

  const treeShown = useMemo(
    () => filterScopeTree(scopeTree, modalSearch.trim().toLowerCase()),
    [scopeTree, modalSearch],
  );
  const draftCountableCount = useMemo(
    () => countableIdList.reduce((acc, id) => acc + (draft.has(id) ? 1 : 0), 0),
    [countableIdList, draft],
  );

  const filterActive = appliedDeptIds !== undefined;
  const selectedCount = appliedDeptIds?.length ?? countableIdList.length;

  return (
    <div className="mte-dash">
      <div className="mte-dash__toolbar">
        <div className="mte-month-nav">
          <button className="mte-month-btn" onClick={prevMonth} aria-label="Предыдущий месяц">
            <ChevronLeft size={16} />
          </button>
          <span className="mte-month-label">{getMonthLabel(year, month)}</span>
          <button className="mte-month-btn" onClick={nextMonth} aria-label="Следующий месяц">
            <ChevronRight size={16} />
          </button>
        </div>
        <section className="mte-half-toggle" aria-label="Период">
          <button
            type="button"
            className={`mte-half-chip ${half === 'H1' ? 'mte-half-chip--active' : ''}`}
            onClick={() => setHalf('H1')}
          >
            {formatHalfLabel(year, month, 'H1')}
          </button>
          <button
            type="button"
            className={`mte-half-chip ${half === 'H2' ? 'mte-half-chip--active' : ''}`}
            onClick={() => setHalf('H2')}
          >
            {formatHalfLabel(year, month, 'H2')}
          </button>
          <button
            type="button"
            className={`mte-half-chip ${half === 'FULL' ? 'mte-half-chip--active' : ''}`}
            onClick={() => setHalf('FULL')}
          >
            {formatHalfLabel(year, month, 'FULL')}
          </button>
        </section>
        <div className="mte-dash__toolbar-spacer" />
        <button
          type="button"
          className={`mte-dash__settings-btn ${filterActive ? 'mte-dash__settings-btn--active' : ''}`}
          onClick={openSettings}
          title="Отделы для статистики"
        >
          <SlidersHorizontal size={16} />
          <span>Настройки</span>
          {filterActive && <span className="mte-dash__settings-badge">{selectedCount}</span>}
        </button>
      </div>

      {isError && (
        <div className="mte-dash__error">Не удалось загрузить дашборд. Попробуйте обновить страницу.</div>
      )}

      <section className="mte-dash__section">
        <h2 className="mte-dash__h2">
          Карта руководителей
          <span className="mte-dash__badge">{managers.length}</span>
          {isLoading && <span className="mte-dash__hint"> · загрузка…</span>}
        </h2>
        {managers.length > SEARCH_THRESHOLD && (
          <SearchInput
            value={searchManagers}
            onValueChange={setSearchManagers}
            placeholder="Поиск по ФИО / отделу / сотруднику…"
          />
        )}
        {managers.length === 0 ? (
          <div className="mte-dash__empty">Нет руководителей в выбранном фильтре.</div>
        ) : (
          <div className="mte-dash__table-wrap">
            <table className="mte-dash__table">
              <thead>
                <tr>
                  <th>ФИО</th>
                  <th>Роль</th>
                  <th>Привязка</th>
                </tr>
              </thead>
              <tbody>
                {managersShown.map(m => (
                  <tr key={m.user_id}>
                    <td className="mte-dash__cell-name">{m.full_name}</td>
                    <td className="mte-dash__cell-role">{roleLabel(m.role_code)}</td>
                    <td>
                      {m.departments.length > 0 ? (
                        <div className="mte-dash__chips">
                          {m.departments.map(d => (
                            <span key={d.id} className="mte-dash__chip">{d.name}</span>
                          ))}
                        </div>
                      ) : m.assigned_employees.length > 0 ? (
                        <span
                          className="mte-dash__assigned"
                          title={m.assigned_employees.map(e => e.full_name).join(', ')}
                        >
                          {m.assigned_employees.length} {pluralEmployees(m.assigned_employees.length)}
                        </span>
                      ) : (
                        <span className="mte-dash__no-assign">нет назначений</span>
                      )}
                    </td>
                  </tr>
                ))}
                {managersShown.length === 0 && (
                  <tr><td colSpan={3} className="mte-dash__empty">Ничего не найдено.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mte-dash__section">
        <h2 className="mte-dash__h2">Подача табелей</h2>
        <div className="mte-dash__stats">
          <StatCard
            label="Отделы: подано"
            value={totals?.departments_submitted ?? 0}
            total={totals?.departments_total ?? 0}
            tone="neutral"
            icon={<Building2 size={18} />}
          />
          <StatCard
            label="Отделы: утверждено"
            value={totals?.departments_approved ?? 0}
            total={totals?.departments_total ?? 0}
            tone="good"
            icon={<CheckCircle2 size={18} />}
          />
          <StatCard
            label="Отделы: возвращено"
            value={totals?.departments_returned ?? 0}
            tone="warn"
            icon={<Clock size={18} />}
          />
          <StatCard
            label="Отделы: не подано"
            value={totals?.departments_not_submitted ?? 0}
            tone="bad"
            icon={<AlertTriangle size={18} />}
          />
          <StatCard
            label="Личные подачи руководителей"
            value={totals?.managers_personal_submitted ?? 0}
            total={totals?.managers_personal_total ?? 0}
            tone="neutral"
            icon={<Users size={18} />}
          />
          <StatCard
            label="Личные: утверждено"
            value={totals?.managers_personal_approved ?? 0}
            total={totals?.managers_personal_total ?? 0}
            tone="good"
            icon={<CheckCircle2 size={18} />}
          />
        </div>
      </section>

      <section className="mte-dash__section">
        <CollapsibleHeader
          collapsed={collapsed.has('heatmap')}
          onToggle={() => toggleSection('heatmap')}
          title={<>
            Карта отделов · температура подачи
            <span className="mte-dash__badge">{deptStatusMap.length}</span>
            {isLoading && <span className="mte-dash__hint"> · загрузка…</span>}
          </>}
        />
        {!collapsed.has('heatmap') && (
          deptStatusMap.length === 0 ? (
            <div className="mte-dash__empty">Нет отделов в выбранном фильтре.</div>
          ) : (
            <>
              {deptStatusMap.length > SEARCH_THRESHOLD && (
                <SearchInput value={searchHeatmap} onValueChange={setSearchHeatmap} placeholder="Поиск отдела…" />
              )}
              <div className="mte-dash__heatmap">
                {heatmapShown.map(d => {
                  const meta = STATUS_META[d.status];
                  const Icon = meta.icon;
                  return (
                    <div
                      key={d.department_id}
                      className={`mte-dash__tile mte-dash__tile--${meta.cls}`}
                      title={`${d.parent_path || d.name} — ${meta.label}`}
                    >
                      <Icon size={13} className="mte-dash__tile-icon" />
                      <span className="mte-dash__tile-name">{d.name}</span>
                    </div>
                  );
                })}
                {heatmapShown.length === 0 && <div className="mte-dash__empty">Ничего не найдено.</div>}
              </div>
              <div className="mte-dash__legend">
                {STATUS_ORDER.map(s => (
                  <span key={s} className={`mte-dash__legend-item mte-dash__legend-item--${STATUS_META[s].cls}`}>
                    <span className="mte-dash__legend-dot" aria-hidden="true" />
                    {STATUS_META[s].label}
                  </span>
                ))}
              </div>
            </>
          )
        )}
      </section>

      <section className="mte-dash__section">
        <CollapsibleHeader
          collapsed={collapsed.has('not_submitted')}
          onToggle={() => toggleSection('not_submitted')}
          title={<>
            Не подали табель · руководители (личные подачи)
            <span className="mte-dash__badge mte-dash__badge--bad">{notSubmittedManagers.length}</span>
          </>}
        />
        {!collapsed.has('not_submitted') && (
          <div className="mte-dash__list-block">
            {notSubmittedManagers.length > SEARCH_THRESHOLD && (
              <SearchInput value={searchNsMgr} onValueChange={setSearchNsMgr} placeholder="Поиск руководителя…" />
            )}
            {notSubmittedManagers.length === 0 ? (
              <div className="mte-dash__empty">Все руководители с прямыми подчинёнными подали табель.</div>
            ) : (
              <ul className="mte-dash__rows">
                {nsMgrShown.map(m => (
                  <li key={m.employee_id} className="mte-dash__row">
                    <div className="mte-dash__row-main">{m.full_name || `ID ${m.employee_id}`}</div>
                    <div className="mte-dash__row-sub">{m.department_path || '—'}</div>
                  </li>
                ))}
                {nsMgrShown.length === 0 && <li className="mte-dash__empty">Ничего не найдено.</li>}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="mte-dash__section">
        <CollapsibleHeader
          collapsed={collapsed.has('unassigned')}
          onToggle={() => toggleSection('unassigned')}
          title={<>
            <UserX size={16} className="mte-dash__h3-icon mte-dash__h3-icon--bad" />
            Отделы без ответственного
            <span className="mte-dash__badge mte-dash__badge--bad">{unassignedDepts.length}</span>
          </>}
        />
        {!collapsed.has('unassigned') && (
          <div className="mte-dash__list-block">
            <div className="mte-dash__hint mte-dash__hint--block">
              Отделу не назначен ни ответственный за табель, ни привязанный руководитель — некому подавать табель.
            </div>
            {unassignedDepts.length > SEARCH_THRESHOLD && (
              <SearchInput value={searchUnassigned} onValueChange={setSearchUnassigned} placeholder="Поиск отдела…" />
            )}
            {unassignedDepts.length === 0 ? (
              <div className="mte-dash__empty">У всех отделов есть ответственный или привязанный руководитель.</div>
            ) : (
              <ul className="mte-dash__rows mte-dash__rows--tall">
                {unassignedShown.map(d => (
                  <li key={d.department_id} className="mte-dash__row">
                    <div className="mte-dash__row-main">{d.parent_path || d.department_name}</div>
                  </li>
                ))}
                {unassignedShown.length === 0 && <li className="mte-dash__empty">Ничего не найдено.</li>}
              </ul>
            )}
          </div>
        )}
      </section>

      {settingsOpen && (
        <div className="mte-dash__modal-overlay" {...overlayHandlers}>
          <div className="mte-dash__modal" role="dialog" aria-modal="true" aria-label="Отделы для статистики">
            <div className="mte-dash__modal-head">
              <span className="mte-dash__modal-title">Отделы для статистики</span>
              <button className="mte-dash__icon-btn" onClick={closeSettings} aria-label="Закрыть">
                <X size={18} />
              </button>
            </div>
            <div className="mte-dash__modal-tools">
              <SearchInput value={modalSearch} onValueChange={setModalSearch} placeholder="Поиск отдела…" />
              <div className="mte-dash__modal-actions">
                <button
                  type="button"
                  className="mte-dash__link-btn"
                  onClick={() => setDraft(new Set(countableIdList))}
                >
                  Выбрать все
                </button>
                <button
                  type="button"
                  className="mte-dash__link-btn"
                  onClick={() => setDraft(new Set())}
                >
                  Снять все
                </button>
              </div>
            </div>
            <div className="mte-dash__modal-hint">
              Корневые каталоги (компании, объект) не считаются — отметка по ним выбирает вложенные отделы.
            </div>
            <div className="mte-dash__modal-list mte-dash__modal-tree">
              {treeShown.map(n => (
                <ScopeTreeNode
                  key={n.id}
                  node={n}
                  checked={draft}
                  onToggle={onTreeToggle}
                  expanded={expandedTree}
                  onExpand={toggleTreeExpand}
                />
              ))}
              {treeShown.length === 0 && <div className="mte-dash__empty">Ничего не найдено.</div>}
            </div>
            <div className="mte-dash__modal-foot">
              <span className="mte-dash__modal-count">Выбрано {draftCountableCount} из {countableIdList.length}</span>
              <button type="button" className="mte-dash__btn-primary" onClick={applySettings}>Применить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
