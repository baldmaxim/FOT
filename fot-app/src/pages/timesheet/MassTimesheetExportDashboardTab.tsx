import { type FC, useMemo, useState, useCallback, useEffect } from 'react';
import {
  ChevronLeft, ChevronRight, AlertTriangle, CheckCircle2, Clock, Users, Building2,
  SlidersHorizontal, X, RotateCcw, Circle, UserX, type LucideIcon,
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
  ITimesheetDashboardManagerBound,
  ITimesheetDashboardManagerUnbound,
  ITimesheetDashboardNotSubmittedDept,
  ITimesheetDashboardNotSubmittedManager,
  ITimesheetDashboardUnassignedDept,
  ITimesheetDashboardDeptStatus,
  ITimesheetDashboardScopeDept,
  DepartmentSubmissionStatus,
  ManagerRoleCode,
} from '../../services/timesheetApprovalService';
import './MassTimesheetExportDashboardTab.css';

const ROLE_LABEL: Record<ManagerRoleCode, string> = {
  manager: 'Руководитель',
  manager_obj: 'Руководитель строительства',
  site_supervisor: 'Начальник участка',
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
  const notSubmittedDepts: ITimesheetDashboardNotSubmittedDept[] = data?.approvals.not_submitted_departments ?? [];
  const notSubmittedManagers: ITimesheetDashboardNotSubmittedManager[] = data?.approvals.not_submitted_managers ?? [];
  const unassignedDepts: ITimesheetDashboardUnassignedDept[] = data?.approvals.unassigned_departments ?? [];
  const deptStatusMap: ITimesheetDashboardDeptStatus[] = data?.approvals.department_status_map ?? [];
  const registeredBound: ITimesheetDashboardManagerBound[] = data?.managers.registered_bound ?? [];
  const registeredUnbound: ITimesheetDashboardManagerUnbound[] = data?.managers.registered_unbound ?? [];
  const scopeDepts: ITimesheetDashboardScopeDept[] = data?.scope_departments ?? [];

  // Поиск по блокам.
  const [searchHeatmap, setSearchHeatmap] = useState('');
  const [searchNsDept, setSearchNsDept] = useState('');
  const [searchNsMgr, setSearchNsMgr] = useState('');
  const [searchUnassigned, setSearchUnassigned] = useState('');
  const [searchBound, setSearchBound] = useState('');
  const [searchUnbound, setSearchUnbound] = useState('');

  const heatmapShown = useMemo(
    () => deptStatusMap.filter(d => !searchHeatmap || includesQuery(`${d.name} ${d.parent_path}`, searchHeatmap)),
    [deptStatusMap, searchHeatmap],
  );
  const nsDeptShown = useMemo(
    () => notSubmittedDepts.filter(d => !searchNsDept || includesQuery(`${d.department_name} ${d.parent_path} ${d.responsible_name ?? ''}`, searchNsDept)),
    [notSubmittedDepts, searchNsDept],
  );
  const nsMgrShown = useMemo(
    () => notSubmittedManagers.filter(m => !searchNsMgr || includesQuery(`${m.full_name} ${m.department_path}`, searchNsMgr)),
    [notSubmittedManagers, searchNsMgr],
  );
  const unassignedShown = useMemo(
    () => unassignedDepts.filter(d => !searchUnassigned || includesQuery(`${d.department_name} ${d.parent_path}`, searchUnassigned)),
    [unassignedDepts, searchUnassigned],
  );
  const boundShown = useMemo(
    () => registeredBound.filter(m => !searchBound || includesQuery(`${m.full_name} ${m.departments.map(d => d.name).join(' ')}`, searchBound)),
    [registeredBound, searchBound],
  );
  const unboundShown = useMemo(
    () => registeredUnbound.filter(m => !searchUnbound || includesQuery(m.full_name, searchUnbound)),
    [registeredUnbound, searchUnbound],
  );

  // Модалка настроек фильтра.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modalSearch, setModalSearch] = useState('');
  const [draft, setDraft] = useState<Set<string>>(new Set());

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const overlayHandlers = useOverlayDismiss(closeSettings);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettingsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  const openSettings = useCallback(() => {
    const all = scopeDepts.map(d => d.department_id);
    setDraft(new Set(appliedDeptIds ?? all));
    setModalSearch('');
    setSettingsOpen(true);
  }, [scopeDepts, appliedDeptIds]);

  const toggleDraft = useCallback((id: string) => {
    setDraft(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const applySettings = useCallback(() => {
    const all = scopeDepts.map(d => d.department_id);
    const next = all.filter(id => draft.has(id));
    const applied = next.length === all.length ? undefined : next;
    setAppliedDeptIds(applied);
    saveStoredDeptFilter(applied);
    setSettingsOpen(false);
  }, [scopeDepts, draft]);

  const modalDeptsShown = useMemo(
    () => scopeDepts.filter(d => !modalSearch || includesQuery(`${d.name} ${d.parent_path}`, modalSearch)),
    [scopeDepts, modalSearch],
  );

  const filterActive = appliedDeptIds !== undefined;
  const selectedCount = appliedDeptIds?.length ?? scopeDepts.length;

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
        <h2 className="mte-dash__h2">
          Карта отделов · температура подачи
          <span className="mte-dash__badge">{deptStatusMap.length}</span>
          {isLoading && <span className="mte-dash__hint"> · загрузка…</span>}
        </h2>
        {deptStatusMap.length > SEARCH_THRESHOLD && (
          <SearchInput value={searchHeatmap} onValueChange={setSearchHeatmap} placeholder="Поиск отдела…" />
        )}
        {deptStatusMap.length === 0 ? (
          <div className="mte-dash__empty">Нет отделов в выбранном фильтре.</div>
        ) : (
          <>
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
        )}
      </section>

      <section className="mte-dash__section">
        <h2 className="mte-dash__h2">Не подали табель</h2>
        <div className="mte-dash__lists">
          <div className="mte-dash__list-block">
            <h3 className="mte-dash__h3">
              Отделы <span className="mte-dash__badge mte-dash__badge--bad">{notSubmittedDepts.length}</span>
            </h3>
            {notSubmittedDepts.length > SEARCH_THRESHOLD && (
              <SearchInput value={searchNsDept} onValueChange={setSearchNsDept} placeholder="Поиск отдела…" />
            )}
            {notSubmittedDepts.length === 0 ? (
              <div className="mte-dash__empty">Все отделы подали табель за период.</div>
            ) : (
              <ul className="mte-dash__rows">
                {nsDeptShown.map(d => (
                  <li key={d.department_id} className="mte-dash__row">
                    <div className="mte-dash__row-main">{d.parent_path || d.department_name}</div>
                    <div className="mte-dash__row-sub">
                      {d.responsible_name
                        ? `Ответственный: ${d.responsible_name}`
                        : 'Ответственный не назначен'}
                    </div>
                  </li>
                ))}
                {nsDeptShown.length === 0 && <li className="mte-dash__empty">Ничего не найдено.</li>}
              </ul>
            )}
          </div>

          <div className="mte-dash__list-block">
            <h3 className="mte-dash__h3">
              Руководители (личные подачи) <span className="mte-dash__badge mte-dash__badge--bad">{notSubmittedManagers.length}</span>
            </h3>
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
        </div>
      </section>

      <section className="mte-dash__section">
        <h2 className="mte-dash__h2">
          <UserX size={16} className="mte-dash__h3-icon mte-dash__h3-icon--bad" />
          Отделы без ответственного
          <span className="mte-dash__badge mte-dash__badge--bad">{unassignedDepts.length}</span>
        </h2>
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
      </section>

      <section className="mte-dash__section">
        <h2 className="mte-dash__h2">Карта руководителей</h2>

        <div className="mte-dash__manager-block">
          <h3 className="mte-dash__h3">
            <CheckCircle2 size={16} className="mte-dash__h3-icon mte-dash__h3-icon--good" />
            Зарегистрированы в ФОТ, привязаны к отделам
            <span className="mte-dash__badge mte-dash__badge--good">{registeredBound.length}</span>
          </h3>
          {registeredBound.length > SEARCH_THRESHOLD && (
            <SearchInput value={searchBound} onValueChange={setSearchBound} placeholder="Поиск по ФИО / отделу…" />
          )}
          {registeredBound.length === 0 ? (
            <div className="mte-dash__empty">Список пуст.</div>
          ) : (
            <div className="mte-dash__table-wrap">
              <table className="mte-dash__table">
                <thead>
                  <tr>
                    <th>ФИО</th>
                    <th>Роль</th>
                    <th>Отделы</th>
                  </tr>
                </thead>
                <tbody>
                  {boundShown.map(m => (
                    <tr key={m.user_id}>
                      <td className="mte-dash__cell-name">{m.full_name}</td>
                      <td className="mte-dash__cell-role">{ROLE_LABEL[m.role_code]}</td>
                      <td>
                        <div className="mte-dash__chips">
                          {m.departments.map(d => (
                            <span key={d.id} className="mte-dash__chip">{d.name}</span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {boundShown.length === 0 && (
                    <tr><td colSpan={3} className="mte-dash__empty">Ничего не найдено.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="mte-dash__manager-block">
          <h3 className="mte-dash__h3">
            <AlertTriangle size={16} className="mte-dash__h3-icon mte-dash__h3-icon--warn" />
            Зарегистрированы в ФОТ, без привязки к отделам
            <span className="mte-dash__badge mte-dash__badge--warn">{registeredUnbound.length}</span>
          </h3>
          {registeredUnbound.length === 0 ? (
            <div className="mte-dash__empty">Все зарегистрированные руководители привязаны к отделам.</div>
          ) : (
            <>
              <div className="mte-dash__hint mte-dash__hint--block">
                Нужно привязать пользователя к отделам в админке (Доступы → Руководители).
              </div>
              {registeredUnbound.length > SEARCH_THRESHOLD && (
                <SearchInput value={searchUnbound} onValueChange={setSearchUnbound} placeholder="Поиск по ФИО…" />
              )}
              <div className="mte-dash__table-wrap">
                <table className="mte-dash__table">
                  <thead>
                    <tr>
                      <th>ФИО</th>
                      <th>Роль</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unboundShown.map(m => (
                      <tr key={m.user_id}>
                        <td className="mte-dash__cell-name">{m.full_name}</td>
                        <td className="mte-dash__cell-role">{ROLE_LABEL[m.role_code]}</td>
                      </tr>
                    ))}
                    {unboundShown.length === 0 && (
                      <tr><td colSpan={2} className="mte-dash__empty">Ничего не найдено.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
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
                  onClick={() => setDraft(new Set(scopeDepts.map(d => d.department_id)))}
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
            <div className="mte-dash__modal-list">
              {modalDeptsShown.map(d => (
                <label key={d.department_id} className="mte-dash__check-row">
                  <input
                    type="checkbox"
                    checked={draft.has(d.department_id)}
                    onChange={() => toggleDraft(d.department_id)}
                  />
                  <span className="mte-dash__check-box" aria-hidden="true" />
                  <span className="mte-dash__check-label">{d.parent_path || d.name}</span>
                </label>
              ))}
              {modalDeptsShown.length === 0 && <div className="mte-dash__empty">Ничего не найдено.</div>}
            </div>
            <div className="mte-dash__modal-foot">
              <span className="mte-dash__modal-count">Выбрано {draft.size} из {scopeDepts.length}</span>
              <button type="button" className="mte-dash__btn-primary" onClick={applySettings}>Применить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
