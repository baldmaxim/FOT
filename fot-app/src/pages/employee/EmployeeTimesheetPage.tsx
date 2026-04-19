import { type FC, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { EmployeeTimesheetView } from '../../components/timesheet/EmployeeTimesheetView';
import { useAuth } from '../../contexts/AuthContext';
import { getMonthLabel } from '../../utils/calendarUtils';
import s from '../../components/timesheet/EmployeeTimesheetView.module.css';

export const EmployeeTimesheetPage: FC = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const employeeId = profile?.employee_id;

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  return (
    <div className={s.page}>
      <div className={s.header}>
        <button className={s.backBtn} onClick={() => navigate('/employee')}>
          <ChevronLeft size={16} />
          Назад
        </button>
        <div className={s.monthNav}>
          <button className={s.monthBtn} onClick={prevMonth}>
            <ChevronLeft size={16} />
          </button>
          <span className={s.monthLabel}>{getMonthLabel(year, month)}</span>
          <button className={s.monthBtn} onClick={nextMonth}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {employeeId ? (
        <EmployeeTimesheetView employeeId={employeeId} year={year} month={month} />
      ) : (
        <div className={s.loading}>Нет данных о сотруднике</div>
      )}
    </div>
  );
};
