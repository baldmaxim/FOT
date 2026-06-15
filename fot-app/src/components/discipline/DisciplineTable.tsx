import { type FC } from 'react';

type ViolationType = 'late' | 'underwork' | 'early' | 'absence';

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
  worked_hours: number;
  norm_hours: number;
}

const formatHours = (h: number | null | undefined): string => {
  if (h === null || h === undefined || h <= 0) return '0ч';
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return mins > 0 ? `${hrs}ч ${mins}м` : `${hrs}ч`;
};

const TYPE_COLORS: Record<ViolationType, string> = {
  late: 'var(--warning)', underwork: '#8b5cf6', early: 'var(--primary)', absence: 'var(--error)',
};
const TYPE_BG: Record<ViolationType, string> = {
  late: 'var(--warning-muted)', underwork: 'rgba(139, 92, 246, 0.1)', early: 'var(--primary-light)', absence: 'var(--error-muted)',
};

const CountBadge: FC<{ count: number; type: ViolationType }> = ({ count, type }) => {
  if (count === 0) return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>;
  return (
    <span className="da-count-badge" style={{ background: TYPE_BG[type], color: TYPE_COLORS[type] }}>
      {count}
    </span>
  );
};

interface IDisciplineTableProps {
  filtered: IEmployeeSummary[];
  isMobile: boolean;
  onSelectEmployee: (id: number) => void;
}

export const DisciplineTable: FC<IDisciplineTableProps> = ({ filtered, isMobile, onSelectEmployee }) => {
  if (filtered.length === 0) {
    return (
      <div className="da-table-wrap">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Сотрудников не найдено</div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="da-table-wrap">
        <div className="da-mobile-cards">
          {filtered.map(emp => (
            <div key={emp.employee_id} className="da-mobile-card" onClick={() => onSelectEmployee(emp.employee_id)}>
              <div className="da-mobile-card-header">
                <div className="da-emp-avatar">{emp.initials}</div>
                <div className="da-mobile-card-info">
                  <div className="da-emp-name">{emp.name}</div>
                  <div className="da-emp-meta">{emp.position} · {emp.department}</div>
                </div>
                <div className="da-mobile-card-total">
                  {formatHours(emp.worked_hours)}
                  <span className="da-mobile-card-norm"> / {formatHours(emp.norm_hours)}</span>
                </div>
              </div>
              <div className="da-mobile-card-badges">
                {emp.late > 0 && <CountBadge count={emp.late} type="late" />}
                {emp.underwork > 0 && <CountBadge count={emp.underwork} type="underwork" />}
                {emp.early > 0 && <CountBadge count={emp.early} type="early" />}
                {emp.absence > 0 && <CountBadge count={emp.absence} type="absence" />}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="da-table-wrap">
      <table className="da-table">
        <thead>
          <tr>
            <th>Отдел</th>
            <th>Сотрудник</th>
            <th style={{ textAlign: 'center' }}>Опоздания</th>
            <th style={{ textAlign: 'center' }}>Недоработки</th>
            <th style={{ textAlign: 'center' }}>Ранние уходы</th>
            <th style={{ textAlign: 'center' }}>Отсутствия</th>
            <th style={{ textAlign: 'center' }}>Часов отработано</th>
            <th style={{ textAlign: 'center' }}>Часов по графику</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(emp => (
            <tr key={emp.employee_id} onClick={() => onSelectEmployee(emp.employee_id)}>
              <td>{emp.department}</td>
              <td>
                <div className="da-emp-cell">
                  <div className="da-emp-avatar">{emp.initials}</div>
                  <div>
                    <div className="da-emp-name">{emp.name}</div>
                    <div className="da-emp-meta">{emp.position}</div>
                  </div>
                </div>
              </td>
              <td style={{ textAlign: 'center' }}><CountBadge count={emp.late} type="late" /></td>
              <td style={{ textAlign: 'center' }}><CountBadge count={emp.underwork} type="underwork" /></td>
              <td style={{ textAlign: 'center' }}><CountBadge count={emp.early} type="early" /></td>
              <td style={{ textAlign: 'center' }}><CountBadge count={emp.absence} type="absence" /></td>
              <td style={{ textAlign: 'center', fontWeight: 600, fontSize: 14 }}>{formatHours(emp.worked_hours)}</td>
              <td style={{ textAlign: 'center', fontSize: 14, color: 'var(--text-secondary)' }}>{formatHours(emp.norm_hours)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
