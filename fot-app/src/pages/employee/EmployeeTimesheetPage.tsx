import { type FC, useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { TimesheetCorrectionModal } from '../../components/timesheet/TimesheetCorrectionModal';
import { timesheetService } from '../../services/timesheetService';
import { employeeService } from '../../services/employeeService';
import { useAuth } from '../../contexts/AuthContext';
import {
  getDaysInMonth,
  getWeekdayShort,
  getMonthLabel,
  formatDateRu,
  isToday,
  isFutureDay,
} from '../../utils/calendarUtils';
import type {
  TimesheetEntry,
  TimesheetEmployee,
  Employee,
} from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import s from './EmployeeTimesheet.module.css';

const WEEKDAY_FULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
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

const getISODow = (date: Date): number => {
  const d = date.getDay();
  return d === 0 ? 7 : d;
};

const isScheduleDayOff = (sched: IResolvedSchedule | undefined, year: number, month: number, day: number): boolean => {
  if (!sched) {
    const dow = new Date(year, month - 1, day).getDay();
    return dow === 0 || dow === 6;
  }
  return !sched.work_days.includes(getISODow(new Date(year, month - 1, day)));
};

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

  const [allEmployees, setAllEmployees] = useState<TimesheetEmployee[]>([]);
  const [allEntries, setAllEntries] = useState<TimesheetEntry[]>([]);
  const [schedules, setSchedules] = useState<Record<number, IResolvedSchedule>>({});
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [loading, setLoading] = useState(false);

  // Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEmployee, setModalEmployee] = useState<TimesheetEmployee | null>(null);
  const [modalDay, setModalDay] = useState<number>(1);
  const [modalEntry, setModalEntry] = useState<TimesheetEntry | null>(null);

  const employeeId = profile?.employee_id;
  const departmentId = profile?.department_id;

  const loadData = useCallback(async () => {
    if (!departmentId || !employeeId) return;
    setLoading(true);
    try {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const [res, emp] = await Promise.all([
        timesheetService.getAll({ month: monthStr, department_id: departmentId }),
        employeeService.getById(employeeId),
      ]);
      setAllEmployees(res.employees || []);
      setAllEntries(res.entries || []);
      setSchedules(res.schedules || {});
      setEmployee(emp);
    } catch {
      setAllEmployees([]);
      setAllEntries([]);
      setEmployee(null);
    } finally {
      setLoading(false);
    }
  }, [year, month, departmentId, employeeId]);

  useEffect(() => { loadData(); }, [loadData]);

  const employees = useMemo(() => {
    if (!employeeId) return [];
    return allEmployees.filter(e => e.id === employeeId);
  }, [allEmployees, employeeId]);

  const entries = useMemo(() => {
    if (!employeeId) return [];
    return allEntries.filter(e => e.employee_id === employeeId);
  }, [allEntries, employeeId]);

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
    const salary = employee?.salary_actual ?? employee?.current_salary ?? 0;
    const units = employee?.staff_units ?? 1;
    const effective = salary * units;
    const sched = employeeId ? schedules[employeeId] : undefined;

    let normDays = 0;
    for (let d = 1; d <= daysCount; d++) {
      if (!isScheduleDayOff(sched, year, month, d)) normDays++;
    }

    const workedDays = entries.filter(e => WORKED_STATUSES.has(e.status)).length;
    const actualHours = entries.reduce((sum, e) => sum + (e.hours_worked || 0), 0);
    const workHoursPerDay = sched?.work_hours ?? 8;
    const normHours = normDays * workHoursPerDay;
    const dailyRate = normDays > 0 ? effective / normDays : 0;
    const accrued = dailyRate * workedDays;

    return { salary, units, effective, normDays, workedDays, dailyRate, accrued, actualHours, normHours };
  }, [employee, entries, schedules, employeeId, year, month, daysCount]);

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
    if (isScheduleDayOff(sched, year, month, day)) return;
    const entry = entryMap.get(day) || null;
    setModalEmployee(employees[0] || null);
    setModalDay(day);
    setModalEntry(entry);
    setModalOpen(true);
  };

  const getDayCellCls = (day: number): string => {
    const sched = employeeId ? schedules[employeeId] : undefined;
    const dayOff = isScheduleDayOff(sched, year, month, day);
    const today = isToday(year, month, day);
    const future = isFutureDay(year, month, day);
    const entry = entryMap.get(day);
    const classes = [s.dayCell];

    if (today) classes.push(s.dayCellToday);

    if (dayOff) {
      classes.push(s.dayCellWeekend);
      return classes.join(' ');
    }

    if (!entry) {
      if (future) classes.push(s.dayCellEmpty);
      else classes.push(s.dayCellEmpty);
      return classes.join(' ');
    }

    const workHoursNorm = sched?.work_hours ?? 8;
    switch (entry.status) {
      case 'work':
      case 'manual':
        classes.push(entry.hours_worked && entry.hours_worked >= workHoursNorm ? s.dayCellFull : s.dayCellPartial);
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
      const dayOff = isScheduleDayOff(sched, year, month, day);
      const future = isFutureDay(year, month, day);
      const entry = entryMap.get(day);
      const date = new Date(year, month - 1, day);
      const weekday = WEEKDAY_SHORT[date.getDay()];
      const isWorked = entry ? WORKED_STATUSES.has(entry.status) : false;
      const dailyAccrual = isWorked ? salaryData.dailyRate : 0;

      return { day, weekday, dayOff, future, entry, isWorked, dailyAccrual };
    });
  }, [days, entryMap, schedules, employeeId, year, month, salaryData.dailyRate]);

  const totalHours = salaryData.actualHours;
  const totalAccrued = salaryData.accrued;
  const diff = salaryData.actualHours - salaryData.normHours;

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
          <div className={s.compactSummary}>
            <div className={s.summaryItem}>
              <div className={s.summaryValue}>{formatHM(salaryData.actualHours)}</div>
              <div className={s.summaryLabel}>Факт</div>
            </div>
            <div className={s.summaryItem}>
              <div className={s.summaryValue}>{formatHM(salaryData.normHours)}</div>
              <div className={s.summaryLabel}>Норма</div>
            </div>
            <div className={s.summaryItem}>
              <div className={`${s.summaryValue} ${diff >= 0 ? s.summaryValuePositive : s.summaryValueNegative}`}>
                {diff >= 0 ? '+' : '−'}{formatHM(Math.abs(diff))}
              </div>
              <div className={s.summaryLabel}>+/−</div>
            </div>
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
          <span className={s.operator}>×</span>
          <div className={s.pill}>
            <span className={s.pillLabel}>Ставка</span>
            <span className={s.pillValue}>{salaryData.units}</span>
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
              <th style={{ textAlign: 'right' }}>Начислено</th>
              <th className={s.cellFormula}>Формула</th>
            </tr>
          </thead>
          <tbody>
            {breakdownRows.map(row => {
              const dateLabel = `${String(row.day).padStart(2, '0')}.${String(month).padStart(2, '0')}`;
              const status = row.dayOff ? 'Выходной' : (row.entry ? STATUS_LABELS[row.entry.status] || '—' : '—');
              const statusCls = row.dayOff ? 'statusDayoff' : (row.entry ? STATUS_CSS[row.entry.status] : '');
              const hours = row.entry?.hours_worked ? formatHM(row.entry.hours_worked) : '—';
              const rowCls = row.dayOff ? s.rowWeekend : (row.future && !row.entry ? s.rowFuture : '');

              return (
                <tr key={row.day} className={rowCls}>
                  <td>{dateLabel}</td>
                  <td>{row.weekday}</td>
                  <td>
                    {statusCls ? (
                      <span className={`${s.statusBadge} ${s[statusCls] || ''}`}>{status}</span>
                    ) : status}
                  </td>
                  <td className={s.cellHours}>{row.dayOff ? '—' : hours}</td>
                  <td className={s.cellMoney}>
                    {row.dayOff ? '—' : (row.isWorked ? `${formatMoney(row.dailyAccrual)} ₽` : '0,00 ₽')}
                  </td>
                  <td className={s.cellFormula}>
                    {row.isWorked
                      ? `${formatMoneyShort(salaryData.effective)}÷${salaryData.normDays}`
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
        initialHours={modalEntry?.hours_worked}
        dayLabel={`${formatDateRu(modalDay, month)}`}
        employeeName={modalEmployee?.full_name}
        employeeId={modalEmployee?.id}
        workDate={`${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`}
        hideCorrectionTab
      />
    </div>
  );
};
