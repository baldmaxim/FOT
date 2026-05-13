import { type FC } from 'react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';

type ViolationType = 'late' | 'underwork' | 'early' | 'absence';

interface IViolationMapped {
  employee_id: number;
  date: string;
  type: ViolationType;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  deviation: string;
  dateFormatted: string;
  typeLabel: string;
  summary: string;
}

interface IEmployeeSummary {
  employee_id: number;
  name: string;
  position: string;
  department: string;
  initials: string;
  late: number;
  underwork: number;
  early: number;
  absence: number;
  total: number;
  violations: IViolationMapped[];
}

const TYPE_COLORS: Record<ViolationType, string> = {
  late: 'var(--warning)', underwork: '#8b5cf6', early: 'var(--primary)', absence: 'var(--error)',
};
const TYPE_BG: Record<ViolationType, string> = {
  late: 'var(--warning-muted)', underwork: 'rgba(139, 92, 246, 0.1)', early: 'var(--primary-light)', absence: 'var(--error-muted)',
};

interface IDisciplineDetailPanelProps {
  employee: IEmployeeSummary | null;
  onClose: () => void;
}

export const DisciplineDetailPanel: FC<IDisciplineDetailPanelProps> = ({ employee, onClose }) => {
  const overlayHandlers = useOverlayDismiss(onClose);
  return (
    <>
      {employee && <div className="da-backdrop" {...overlayHandlers} />}
      <div className={`da-panel ${employee ? 'open' : ''}`}>
        {employee && (
          <>
            <div className="da-panel-header">
              <span className="da-panel-title">Нарушения сотрудника</span>
              <button className="da-panel-close" onClick={onClose}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="da-panel-body">
              <div className="da-panel-emp">
                <div className="da-panel-avatar">{employee.initials}</div>
                <div>
                  <div className="da-panel-emp-name">{employee.name}</div>
                  <div className="da-panel-emp-position">{employee.position}</div>
                  <div className="da-panel-emp-dept">{employee.department}</div>
                </div>
              </div>

              <div className="da-panel-summary">
                {employee.late > 0 && <span className="da-badge" style={{ background: TYPE_BG.late, color: TYPE_COLORS.late }}>Опоздания: {employee.late}</span>}
                {employee.underwork > 0 && <span className="da-badge" style={{ background: TYPE_BG.underwork, color: TYPE_COLORS.underwork }}>Недоработки: {employee.underwork}</span>}
                {employee.early > 0 && <span className="da-badge" style={{ background: TYPE_BG.early, color: TYPE_COLORS.early }}>Ранние уходы: {employee.early}</span>}
                {employee.absence > 0 && <span className="da-badge" style={{ background: TYPE_BG.absence, color: TYPE_COLORS.absence }}>Отсутствия: {employee.absence}</span>}
              </div>

              <div className="da-panel-section">
                <div className="da-panel-section-title">Нарушения за период ({employee.total})</div>
                {employee.violations.map((v, i) => (
                  <a
                    key={i}
                    className="da-violation-item da-violation-link"
                    href={`/employees/${employee.employee_id}?tab=skud&date=${v.date}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Открыть СКУД сотрудника за этот день"
                  >
                    <div className="da-violation-date">{v.dateFormatted}</div>
                    <span className="da-badge" style={{ background: TYPE_BG[v.type], color: TYPE_COLORS[v.type], fontSize: 11 }}>{v.typeLabel}</span>
                    <span className="da-violation-summary">{v.summary}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ flexShrink: 0 }}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
};
