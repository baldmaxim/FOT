import { type FC, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { TimesheetCorrectionModal } from '../../components/timesheet/TimesheetCorrectionModal';
import { employeeService } from '../../services/employeeService';
import { useAuth } from '../../contexts/AuthContext';
import { useEmployeeTimesheetMonth } from '../../hooks/useEmployeeTimesheet';
import {
  getDaysInMonth,
  getWeekdayShort,
  getMonthLabel,
  formatDateRu,
  isToday,
  isFutureDay,
} from '../../utils/calendarUtils';
import {
  getWorkHoursForDay,
  getFullDayThresholdHoursForDay,
  isScheduleDayOff,
} from '../../utils/scheduleUtils';
import type {
  TimesheetEntry,
  TimesheetEmployee,
  Employee,
} from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import s from './EmployeeTimesheet.module.css';

const WEEKDAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const STATUS_LABELS: Record<string, string> = {
  work: 'Работа',
  manual: 'Работа',
  remote: 'Удалёнка',
  sick: 'Больничный',
  vacation: 'Отпуск',
  dayoff: 'Выходной',
  absent: 'Неявка',
  business_trip: 'Командировка',
  unpaid: 'Без содержания',
};

const STATUS_CSS: Record<string, string> = {
  work: 'statusWork',
  manual: 'statusWork',
  remote: 'statusRemote',
  sick: 'statusSick',
  vacation: 'statusVacation',
  dayoff: 'statusDayoff',
  absent: 'statusAbsent',
  business_trip: 'statusTrip',
  unpaid: 'statusUnpaid',
};

const WORKED_STATUSES = new Set(['work', 'manual', 'remote', 'business_trip']);
const EMPTY_SCHEDULES: Record<number, IResolvedSchedule> = {};

const formatHM = (decimal: number): string => {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

const formatMoney = (v: number): string =>
  v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatMoneyShort = (v: number): string =>
  v.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export const EmployeeTimesheetPage: FC = () => {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEmployee, setModalEmployee] = useState<TimesheetEmployee | null>(null);
  const [modalDay, setModalDay] = useState<number>(1);
  const [modalEntry, setModalEntry] = useState<TimesheetEntry | null>(null);

  const employeeId = profile?.employee_id;
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const timesheetQuery = useEmployeeTimesheetMonth(employeeId, monthStr, !!employeeId);
  const employeeQuery = useQuery<Employee | null>({
    queryKey: ['employee', employeeId],
    queryFn: () => employeeService.getById(employeeId as number),
    enabled: !!employeeId,
    staleTime: 60_000,
  });

  const employees = useMemo<TimesheetEmployee[]>(
    () => timesheetQuery.data?.employees || [],
    [timesheetQuery.data],
  );
  const entries = useMemo<TimesheetEntry[]>(
    () => timesheetQuery.data?.entries || [],
    [timesheetQuery.data],
  );
  const schedules = timesheetQuery.data?.schedules || EMPTY_SCHEDULES;
  const calendar = timesheetQuery.data?.calendar || null;
  const employee = employeeQuery.data ?? null;
  const loading = timesheetQuery.isLoading || employeeQuery.isLoading;

  // Build entry map for quick lookup
  const entryMap = useMemo(() => {
    const map = new Map<number, TimesheetEntry>();
    for (const e of entries) {
      const d = new Date(e.work_date).getDate();
      map.set(d, e);
    }
    return map;
  }, [entries]);

  const daysCount = getDaysInMonth(year, month);
  const days = useMemo(() => Array.from({ length: daysCount }, (_, i) => i + 1), [daysCount]);

  // Salary calculation
  const salaryData = useMemo(() => {
    const salary = employee?.current_salary ?? 0;
    const sched = employeeId ? schedules[employeeId] : undefined;

    let normDays = 0;
    for (let d = 1; d <= daysCount; d++) {
      if (!isScheduleDayOff(sched, calendar, year, month, d)) {
        normDays++;
      }
    }

    const workedDays = entries.filter(e => WORKED_STATUSES.has(e.status)).length;
    const actualHours = entries.reduce((sum, e) => sum + (e.hours_worked || 0), 0);
    const dailyRate = normDays > 0 ? salary / normDays : 0;
    const accrued = dailyRate * workedDays;

    return { salary, normDays, workedDays, dailyRate, accrued, actualHours };
  }, [employee, entries, schedules, employeeId, calendar, year, month, daysCount]);

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  const handleDayClick = (day: number) => {
    const sched = employeeId ? schedules[employeeId] : undefined;
    if (isScheduleDayOff(sched, calendar, year, month, day)) return;
    const entry = entryMap.get(day) || null;
    setModalEmployee(employees[0] || null);
    setModalDay(day);
    setModalEntry(entry);
    setModalOpen(true);
  };

  const getDayCellCls = (day: number): string => {
    const sched = employeeId ? schedules[employeeId] : undefined;
    const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
    const today = isToday(year, month, day);
    const future = isFutureDay(year, month, day);
    const entry = entryMap.get(day);
    const classes = [s.dayCell];

    if (today) classes.push(s.dayCellToday);

    if (dayOff && !entry) {
      classes.push(s.dayCellWeekend);
      return classes.join(' ');
    }

    if (!entry) {
      if (future) classes.push(s.dayCellEmpty);
      else classes.push(s.dayCellEmpty);
      return classes.join(' ');
    }

    const thresholdHours = getFullDayThresholdHoursForDay(sched, calendar, year, month, day);
    switch (entry.status) {
      case 'work':
      case 'manual':
        classes.push(entry.hours_worked && entry.hours_worked >= thresholdHours ? s.dayCellFull : s.dayCellPartial);
        break;
      case 'remote':
        classes.push(s.dayCellRemote);
        break;
      case 'sick':
        classes.push(s.dayCellSick);
        break;
      case 'vacation':
      case 'dayoff':
        classes.push(s.dayCellVacation);
        break;
      case 'absent':
        classes.push(s.dayCellAbsent);
        break;
      case 'business_trip':
        classes.push(s.dayCellTrip);
        break;
    }

    return classes.join(' ');
  };

  // Breakdown rows
  const breakdownRows = useMemo(() => {
    return days.map(day => {
      const sched = employeeId ? schedules[employeeId] : undefined;
      const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
      const future = isFutureDay(year, month, day);
      const entry = entryMap.get(day);
      const date = new Date(year, month - 1, day);
      const weekday = WEEKDAY_SHORT[date.getDay()];
      const isWorked = entry ? WORKED_STATUSES.has(entry.status) : false;
      const dailyAccrual = isWorked ? salaryData.dailyRate : 0;

      return { day, weekday, dayOff, future, entry, isWorked, dailyAccrual };
    });
  }, [days, entryMap, schedules, employeeId, calendar, year, month, salaryData.dailyRate]);

  const totalHours = salaryData.actualHours;
  const totalAccrued = salaryData.accrued;

  if (loading) {
    return (
      <div className={s.page}>
        <div className={s.loading}>Загрузка табеля...</div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      {/* Header */}
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

      {/* Section 1: Compact Timesheet */}
      <div className={s.section}>
        <h3 className={s.sectionTitle}>Табель</h3>
        <div className={s.compactWrap}>
          <div className={s.compactRow}>
            {days.map(day => (
              <button
                key={day}
                className={getDayCellCls(day)}
                onClick={() => handleDayClick(day)}
                title={`${day} ${getWeekdayShort(year, month, day)}`}
              >
                {day}
              </button>
            ))}
          </div>
        </div>
        <div className={s.legend}>
          <div className={s.legendItem}>
            <span className={`${s.legendDot} ${s.dayCellFull}`} />Полный день
          </div>
          <div className={s.legendItem}>
            <span className={`${s.legendDot} ${s.dayCellPartial}`} />Неполный
          </div>
          <div className={s.legendItem}>
            <span className={`${s.legendDot} ${s.dayCellSick}`} />Больничный
          </div>
          <div className={s.legendItem}>
            <span className={`${s.legendDot} ${s.dayCellVacation}`} />Отпуск
          </div>
          <div className={s.legendItem}>
            <span className={`${s.legendDot} ${s.dayCellRemote}`} />Удалёнка
          </div>
          <div className={s.legendItem}>
            <span className={`${s.legendDot} ${s.dayCellAbsent}`} />Неявка
          </div>
          <div className={s.legendItem}>
            <span className={`${s.legendDot} ${s.dayCellWeekend}`} />Выходной
          </div>
        </div>
      </div>

      {/* Section 2: Salary Calculation */}
      <div className={s.section}>
        <h3 className={s.sectionTitle}>Расчёт зарплаты</h3>
        <div className={s.salaryTotal}>
          <span className={s.salaryTotalLabel}>Начислено за месяц:</span>
          <span className={s.salaryTotalValue}>{formatMoney(salaryData.accrued)} ₽</span>
        </div>
        <div className={s.formulaRow}>
          <div className={s.pill}>
            <span className={s.pillLabel}>Оклад</span>
            <span className={s.pillValue}>{formatMoneyShort(salaryData.salary)} ₽</span>
          </div>
          <span className={s.operator}>÷</span>
          <div className={s.pill}>
            <span className={s.pillLabel}>Норма дней</span>
            <span className={s.pillValue}>{salaryData.normDays} дн.</span>
          </div>
          <span className={s.operator}>×</span>
          <div className={s.pill}>
            <span className={s.pillLabel}>Отработано</span>
            <span className={s.pillValue}>{salaryData.workedDays} дн.</span>
          </div>
          <span className={s.operator}>=</span>
          <div className={`${s.pill} ${s.pillResult}`}>
            <span className={s.pillLabel}>Начислено</span>
            <span className={`${s.pillValue} ${s.pillResultValue}`}>{formatMoney(salaryData.accrued)} ₽</span>
          </div>
        </div>
        <div className={s.dailyRate}>
          Дневная ставка: <span className={s.dailyRateValue}>{formatMoney(salaryData.dailyRate)} ₽/день</span>
        </div>
      </div>

      {/* Section 3: Daily Breakdown */}
      <div className={s.section}>
        <h3 className={s.sectionTitle}>Детализация по дням</h3>
        <table className={s.breakdownTable}>
          <thead>
            <tr>
              <th>Дата</th>
              <th>День</th>
              <th>Статус</th>
              <th>Часы</th>
              <th>Начислено</th>
              <th className={s.cellFormula}>Формула</th>
            </tr>
          </thead>
          <tbody>
            {breakdownRows.map(row => {
              const dateLabel = `${String(row.day).padStart(2, '0')}.${String(month).padStart(2, '0')}`;
              const showAsDayOff = row.dayOff && !row.entry;
              const status = showAsDayOff
                ? 'Выходной'
                : (row.entry ? STATUS_LABELS[row.entry.status] || '—' : '—');
              const statusCls = showAsDayOff
                ? 'statusDayoff'
                : (row.entry ? STATUS_CSS[row.entry.status] : '');
              const hours = row.entry?.hours_worked ? formatHM(row.entry.hours_worked) : '—';
              const rowCls = showAsDayOff ? s.rowWeekend : (row.future && !row.entry ? s.rowFuture : '');

              return (
                <tr key={row.day} className={rowCls}>
                  <td>{dateLabel}</td>
                  <td>{row.weekday}</td>
                  <td>
                    {statusCls ? (
                      <span className={`${s.statusBadge} ${s[statusCls] || ''}`}>{status}</span>
                    ) : status}
                  </td>
                  <td className={s.cellHours}>{showAsDayOff ? '—' : hours}</td>
                  <td className={s.cellMoney}>
                    {showAsDayOff ? '—' : (row.isWorked ? `${formatMoney(row.dailyAccrual)} ₽` : '0,00 ₽')}
                  </td>
                  <td className={s.cellFormula}>
                    {row.isWorked
                      ? `${formatMoneyShort(salaryData.salary)}÷${salaryData.normDays}`
                      : '—'
                    }
                  </td>
                </tr>
              );
            })}
            <tr className={s.totalRow}>
              <td colSpan={3}>Итого</td>
              <td className={s.cellHours}>{formatHM(totalHours)}</td>
              <td className={s.totalMoney}>{formatMoney(totalAccrued)} ₽</td>
              <td className={s.cellFormula} />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Modal */}
      <TimesheetCorrectionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={async () => { setModalOpen(false); }}
        initialStatus={modalEntry?.status || 'work'}
        initialHours={modalEntry?.hours_worked ?? getWorkHoursForDay(employeeId ? schedules[employeeId] : undefined, year, month, modalDay)}
        dayLabel={`${formatDateRu(modalDay, month)}`}
        employeeName={modalEmployee?.full_name}
        employeeId={modalEmployee?.id}
        workDate={`${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`}
        timesheetEntry={modalEntry}
        correctionInfo={modalEntry?.is_correction ? {
          is_correction: true,
          corrected_at: modalEntry.corrected_at,
          corrected_by_name: modalEntry.corrected_by_name,
        } : null}
        hideCorrectionTab
      />
    </div>
  );
};
