import { type FC, useState, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TimesheetCorrectionModal } from './TimesheetCorrectionModal';
import { employeeService } from '../../services/employeeService';
import { timesheetService } from '../../services/timesheetService';
import {
  useEmployeeTimesheetMonth,
  getEmployeeTimesheetMonthQueryKey,
} from '../../hooks/useEmployeeTimesheet';
import {
  getDaysInMonth,
  getWeekdayShort,
  formatDateRu,
  isToday,
  isFutureDay,
} from '../../utils/calendarUtils';
import {
  getWorkHoursForDay,
  getFullDayThresholdHoursForDay,
  isScheduleDayOff,
  isPreHolidayForSchedule,
} from '../../utils/scheduleUtils';
import type {
  TimesheetEntry,
  TimesheetEmployee,
  TimesheetStatus,
  Employee,
} from '../../types';
import type { IResolvedSchedule } from '../../types/schedule';
import s from './EmployeeTimesheetView.module.css';

const WEEKDAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const STATUS_LABELS: Record<string, string> = {
  work: 'Работа',
  manual: 'Работа',
  remote: 'Удалёнка',
  sick: 'Больничный',
  vacation: 'Отпуск',
  dayoff: 'Выходной',
  absent: 'Неявка',
  unpaid: 'За свой счёт',
  educational_leave: 'Учебный отпуск',
};

const STATUS_CSS: Record<string, string> = {
  work: 'statusWork',
  manual: 'statusWork',
  remote: 'statusRemote',
  sick: 'statusSick',
  vacation: 'statusVacation',
  dayoff: 'statusDayoff',
  absent: 'statusAbsent',
  unpaid: 'statusUnpaid',
  educational_leave: 'statusVacation',
};

const WORKED_STATUSES = new Set(['work', 'manual', 'remote']);
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

interface IEmployeeTimesheetViewProps {
  employeeId: number;
  year: number;
  month: number;
  canEdit?: boolean;
}

export const EmployeeTimesheetView: FC<IEmployeeTimesheetViewProps> = ({ employeeId, year, month, canEdit = false }) => {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEmployee, setModalEmployee] = useState<TimesheetEmployee | null>(null);
  const [modalDay, setModalDay] = useState<number>(1);
  const [modalEntry, setModalEntry] = useState<TimesheetEntry | null>(null);

  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const timesheetQuery = useEmployeeTimesheetMonth(employeeId, monthStr, true);
  const employeeQuery = useQuery<Employee | null>({
    queryKey: ['employee', employeeId],
    queryFn: () => employeeService.getById(employeeId),
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

  const salaryData = useMemo(() => {
    const salary = employee?.current_salary ?? 0;
    const sched = schedules[employeeId];

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

  const handleDayClick = (day: number) => {
    const sched = schedules[employeeId];
    if (isScheduleDayOff(sched, calendar, year, month, day)) return;
    const entry = entryMap.get(day) || null;
    setModalEmployee(employees[0] || null);
    setModalDay(day);
    setModalEntry(entry);
    setModalOpen(true);
  };

  const getDayCellCls = (day: number): string => {
    const sched = schedules[employeeId];
    const dayOff = isScheduleDayOff(sched, calendar, year, month, day);
    const preHoliday = isPreHolidayForSchedule(sched, calendar, year, month, day);
    const today = isToday(year, month, day);
    const future = isFutureDay(year, month, day);
    const entry = entryMap.get(day);
    const classes = [s.dayCell];

    if (today) classes.push(s.dayCellToday);
    if (preHoliday) classes.push(s.dayCellPreHoliday);

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
    }

    return classes.join(' ');
  };

  const breakdownRows = useMemo(() => {
    return days.map(day => {
      const sched = schedules[employeeId];
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

  const handleSave = useCallback(async (status: TimesheetStatus, hours: number | null, notes: string) => {
    if (!canEdit || !modalEmployee) {
      setModalOpen(false);
      return;
    }
    try {
      const workDate = `${year}-${String(month).padStart(2, '0')}-${String(modalDay).padStart(2, '0')}`;
      if (modalEntry?.id) {
        await timesheetService.update(modalEntry.id, { status, hours_worked: hours, notes });
      } else {
        await timesheetService.create({
          employee_id: modalEmployee.id,
          work_date: workDate,
          status,
          hours_worked: hours,
          notes,
        });
      }
      setModalOpen(false);
      await queryClient.invalidateQueries({
        queryKey: getEmployeeTimesheetMonthQueryKey(employeeId, monthStr),
      });
    } catch (err) {
      console.error('Save correction error:', err);
    }
  }, [canEdit, modalEmployee, modalEntry, modalDay, year, month, queryClient, employeeId, monthStr]);

  const totalHours = salaryData.actualHours;
  const totalAccrued = salaryData.accrued;

  if (loading) {
    return (
      <div className={s.viewRoot}>
        <div className={s.loading}>Загрузка табеля...</div>
      </div>
    );
  }

  return (
    <div className={s.viewRoot}>
      <div className={s.section}>
        <h3 className={s.sectionTitle}>Табель</h3>
        <div className={s.compactWrap}>
          <div className={s.compactRow}>
            {days.map(day => {
              const sched = schedules[employeeId];
              const preHoliday = isPreHolidayForSchedule(sched, calendar, year, month, day);
              const baseTitle = `${day} ${getWeekdayShort(year, month, day)}`;
              const title = preHoliday ? `${baseTitle} • Предпраздничный (−1ч)` : baseTitle;
              return (
                <button
                  key={day}
                  className={getDayCellCls(day)}
                  onClick={() => handleDayClick(day)}
                  title={title}
                >
                  {day}
                </button>
              );
            })}
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

      <TimesheetCorrectionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
        initialStatus={modalEntry?.status || 'work'}
        initialHours={modalEntry?.hours_worked ?? getWorkHoursForDay(schedules[employeeId], year, month, modalDay)}
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
        allowAccessPointMap={false}
        hideCorrectionTab={!canEdit}
      />
    </div>
  );
};
