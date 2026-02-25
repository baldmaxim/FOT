import type { FC } from 'react';
import { BarChart3, AlertTriangle, Info, Clock, CalendarX } from 'lucide-react';
import type { Employee } from '../../types';
import type { IWeekdayPattern, IAlert } from '../../utils/attendanceCalc';

interface IEmployeeCardSidebarProps {
  weeklyPattern: IWeekdayPattern[];
  alerts: IAlert[];
  employee: Employee;
}

const formatDate = (dateStr: string | null) => {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('ru-RU');
};

export const EmployeeCardSidebar: FC<IEmployeeCardSidebarProps> = ({
  weeklyPattern, alerts, employee,
}) => {
  const hasWeeklyData = weeklyPattern.some(p => p.heightPercent > 0);

  return (
    <div className="ec-right-col">
      {/* Weekly Pattern */}
      <div className="ec-card">
        <div className="ec-card-header">
          <div className="ec-card-title">
            <BarChart3 size={18} />
            Паттерн приходов
          </div>
        </div>
        <div className="ec-weekly">
          <div className="ec-weekly-title">Среднее время прихода по дням недели</div>
          {hasWeeklyData ? (
            <>
              <div className="ec-weekly-bars">
                {weeklyPattern.map(p => (
                  <div
                    key={p.day}
                    className="ec-weekly-bar"
                    style={{ height: `${p.heightPercent}%` }}
                    data-time={p.avgTime || '—'}
                  />
                ))}
              </div>
              <div className="ec-weekly-labels">
                {weeklyPattern.map(p => (
                  <span key={p.day} className="ec-weekly-label">{p.day}</span>
                ))}
              </div>
            </>
          ) : (
            <div className="ec-tl-empty">Нет данных за этот месяц</div>
          )}
        </div>
      </div>

      {/* Alerts */}
      <div className="ec-card">
        <div className="ec-card-header">
          <div className="ec-card-title">
            <AlertTriangle size={18} />
            Внимание
          </div>
        </div>
        {alerts.length > 0 ? (
          <div className="ec-alerts-list">
            {alerts.map((a, i) => (
              <div key={i} className={`ec-alert-item ${a.type}`}>
                <div className="ec-alert-icon">
                  {a.type === 'warning' ? <Clock size={16} /> : <CalendarX size={16} />}
                </div>
                <div className="ec-alert-content">
                  <div className="ec-alert-title">{a.title}</div>
                  <div className="ec-alert-desc">{a.description}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="ec-alerts-empty">Нет предупреждений</div>
        )}
      </div>

      {/* Quick Info */}
      <div className="ec-card">
        <div className="ec-card-header">
          <div className="ec-card-title">
            <Info size={18} />
            Информация
          </div>
        </div>
        <div className="ec-info-list">
          {employee.email && (
            <div className="ec-info-item">
              <span className="ec-info-label">Email</span>
              <span className="ec-info-value">{employee.email}</span>
            </div>
          )}
          <div className="ec-info-item">
            <span className="ec-info-label">Дата найма</span>
            <span className="ec-info-value">{formatDate(employee.hire_date)}</span>
          </div>
          {employee.birth_date && (
            <div className="ec-info-item">
              <span className="ec-info-label">Дата рождения</span>
              <span className="ec-info-value">{formatDate(employee.birth_date)}</span>
            </div>
          )}
          {employee.country && (
            <div className="ec-info-item">
              <span className="ec-info-label">Страна</span>
              <span className="ec-info-value">{employee.country}</span>
            </div>
          )}
          {employee.pension_number && (
            <div className="ec-info-item">
              <span className="ec-info-label">СНИЛС</span>
              <span className="ec-info-value">{employee.pension_number}</span>
            </div>
          )}
          <div className="ec-info-item">
            <span className="ec-info-label">Статус</span>
            <span className="ec-info-value">
              {employee.employment_status === 'active' ? 'Активен' : 'Уволен'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
