import type { FC } from 'react';
import { AlertTriangle, Clock, CalendarX } from 'lucide-react';
import type { IAlert } from '../../utils/attendanceCalc';

interface IEmployeeCardSidebarProps {
  alerts: IAlert[];
}

export const EmployeeCardSidebar: FC<IEmployeeCardSidebarProps> = ({ alerts }) => {
  return (
    <div className="ec-right-col">
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
    </div>
  );
};
