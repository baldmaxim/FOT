import { type FC, useMemo, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, AlertTriangle, CheckCircle2, Clock, Users, Building2, UserX } from 'lucide-react';
import { getMonthLabel } from '../../utils/calendarUtils';
import {
  formatHalfLabel,
  getCurrentHalf,
  getHalfRange,
  type TimesheetHalf,
} from '../../utils/timesheetApprovalPeriod';
import { useTimesheetApprovalDashboard } from '../../hooks/useTimesheetApprovalData';
import type {
  ITimesheetDashboardManagerBound,
  ITimesheetDashboardManagerUnbound,
  ITimesheetDashboardUnregisteredManager,
  ITimesheetDashboardNotSubmittedDept,
  ITimesheetDashboardNotSubmittedManager,
  ManagerRoleCode,
} from '../../services/timesheetApprovalService';
import './MassTimesheetExportDashboardTab.css';

const ROLE_LABEL: Record<ManagerRoleCode, string> = {
  manager: 'Руководитель',
  manager_obj: 'Руководитель строительства',
  site_supervisor: 'Начальник участка',
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

  const { data, isLoading, isError } = useTimesheetApprovalDashboard(range.startDate, range.endDate);

  const totals = data?.approvals.totals;
  const notSubmittedDepts: ITimesheetDashboardNotSubmittedDept[] = data?.approvals.not_submitted_departments ?? [];
  const notSubmittedManagers: ITimesheetDashboardNotSubmittedManager[] = data?.approvals.not_submitted_managers ?? [];
  const registeredBound: ITimesheetDashboardManagerBound[] = data?.managers.registered_bound ?? [];
  const registeredUnbound: ITimesheetDashboardManagerUnbound[] = data?.managers.registered_unbound ?? [];
  const unregistered: ITimesheetDashboardUnregisteredManager[] = data?.managers.unregistered ?? [];

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
          Не подали табель
          {isLoading && <span className="mte-dash__hint"> · загрузка…</span>}
        </h2>
        <div className="mte-dash__lists">
          <div className="mte-dash__list-block">
            <h3 className="mte-dash__h3">
              Отделы <span className="mte-dash__badge mte-dash__badge--bad">{notSubmittedDepts.length}</span>
            </h3>
            {notSubmittedDepts.length === 0 ? (
              <div className="mte-dash__empty">Все отделы подали табель за период.</div>
            ) : (
              <ul className="mte-dash__rows">
                {notSubmittedDepts.map(d => (
                  <li key={d.department_id} className="mte-dash__row">
                    <div className="mte-dash__row-main">{d.parent_path || d.department_name}</div>
                    <div className="mte-dash__row-sub">
                      {d.responsible_name
                        ? `Ответственный: ${d.responsible_name}`
                        : 'Ответственный не назначен'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mte-dash__list-block">
            <h3 className="mte-dash__h3">
              Руководители (личные подачи) <span className="mte-dash__badge mte-dash__badge--bad">{notSubmittedManagers.length}</span>
            </h3>
            {notSubmittedManagers.length === 0 ? (
              <div className="mte-dash__empty">Все руководители с прямыми подчинёнными подали табель.</div>
            ) : (
              <ul className="mte-dash__rows">
                {notSubmittedManagers.map(m => (
                  <li key={m.employee_id} className="mte-dash__row">
                    <div className="mte-dash__row-main">{m.full_name || `ID ${m.employee_id}`}</div>
                    <div className="mte-dash__row-sub">{m.department_path || '—'}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section className="mte-dash__section">
        <h2 className="mte-dash__h2">Карта руководителей</h2>

        <div className="mte-dash__manager-block">
          <h3 className="mte-dash__h3">
            <CheckCircle2 size={16} className="mte-dash__h3-icon mte-dash__h3-icon--good" />
            Зарегистрированы в ФОТ, привязаны к отделам
            <span className="mte-dash__badge mte-dash__badge--good">{registeredBound.length}</span>
          </h3>
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
                  {registeredBound.map(m => (
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
              <div className="mte-dash__table-wrap">
                <table className="mte-dash__table">
                  <thead>
                    <tr>
                      <th>ФИО</th>
                      <th>Роль</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registeredUnbound.map(m => (
                      <tr key={m.user_id}>
                        <td className="mte-dash__cell-name">{m.full_name}</td>
                        <td className="mte-dash__cell-role">{ROLE_LABEL[m.role_code]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="mte-dash__manager-block">
          <h3 className="mte-dash__h3">
            <UserX size={16} className="mte-dash__h3-icon mte-dash__h3-icon--bad" />
            Не зарегистрированы в ФОТ
            <span className="mte-dash__badge mte-dash__badge--bad">{unregistered.length}</span>
          </h3>
          {unregistered.length === 0 ? (
            <div className="mte-dash__empty">Все руководители из Sigur имеют учётную запись в ФОТ.</div>
          ) : (
            <>
              <div className="mte-dash__hint mte-dash__hint--block">
                Сотрудник числится руководителем в Sigur, но у него нет учётной записи в ФОТ.
              </div>
              <div className="mte-dash__table-wrap">
                <table className="mte-dash__table">
                  <thead>
                    <tr>
                      <th>ФИО</th>
                      <th>Должность</th>
                      <th>Отдел</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unregistered.map(m => (
                      <tr key={m.employee_id}>
                        <td className="mte-dash__cell-name">{m.full_name || `ID ${m.employee_id}`}</td>
                        <td className="mte-dash__cell-role">{m.position_name || '—'}</td>
                        <td>{m.department_path || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
};
