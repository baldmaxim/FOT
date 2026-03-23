import { type FC, useMemo } from 'react';
import { X } from 'lucide-react';
import type { TimesheetEntry, TimesheetEmployee } from '../../types';
import {
  getDaysInMonth,
  isWeekend,
  formatDateRu,
  getWeekdayFull,
  isToday,
  getWorkingDaysCount,
} from '../../utils/calendarUtils';

interface ISidePanelProps {
  open: boolean;
  onClose: () => void;
  employee: TimesheetEmployee | null;
  entries: TimesheetEntry[];
  year: number;
  month: number;
}

const getInitials = (name: string): string => {
  const parts = name.split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
};


export const TimesheetSidePanel: FC<ISidePanelProps> = ({
  open,
  onClose,
  employee,
  entries,
  year,
  month,
}) => {
  const dayDetails = useMemo(() => {
    if (!employee) return [];
    const daysCount = getDaysInMonth(year, month);
    const details: Array<{
      day: number;
      entry: TimesheetEntry | null;
      isWeekend: boolean;
    }> = [];

    for (let d = 1; d <= daysCount; d++) {
      const weekend = isWeekend(year, month, d);
      if (weekend) continue;

      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const entry = entries.find(e => e.work_date === dateStr) || null;

      // Only show days up to today
      const dayDate = new Date(year, month - 1, d);
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      if (dayDate > today) continue;

      details.push({ day: d, entry, isWeekend: weekend });
    }

    return details;
  }, [employee, entries, year, month]);

  const stats = useMemo(() => {
    const normHours = getWorkingDaysCount(year, month) * 8;
    let factHours = 0;
    let lateCount = 0;
    let absentCount = 0;

    for (const entry of entries) {
      if (entry.hours_worked) factHours += entry.hours_worked;
      if (entry.status === 'absent') absentCount++;
      if (entry.status === 'work' && entry.hours_worked && entry.hours_worked < 8) lateCount++;
    }

    return { factHours, normHours, lateCount, absentCount };
  }, [entries, year, month]);

  const getHoursClass = (entry: TimesheetEntry | null): string => {
    if (!entry) return 'ts-day-detail-hours--absent';
    if (entry.status === 'absent') return 'ts-day-detail-hours--absent';
    if (entry.status === 'sick') return 'ts-day-detail-hours--sick';
    if (entry.status === 'vacation') return 'ts-day-detail-hours--vacation';
    if (entry.hours_worked && entry.hours_worked >= 8) return 'ts-day-detail-hours--full';
    return 'ts-day-detail-hours--partial';
  };

  const getHoursLabel = (entry: TimesheetEntry | null): string => {
    if (!entry) return '—';
    if (entry.status === 'absent') return 'Неявка';
    if (entry.status === 'sick') return 'Б/л';
    if (entry.status === 'vacation') return 'Отпуск';
    if (entry.status === 'business_trip') return 'Ком-ка';
    if (entry.hours_worked != null) return `${entry.hours_worked}ч`;
    return '—';
  };

  if (!employee) return null;

  return (
    <>
      <div
        className={`ts-backdrop ${open ? 'ts-backdrop--open' : ''}`}
        onClick={onClose}
      />
      <div className={`ts-side-panel ${open ? 'ts-side-panel--open' : ''}`}>
        <div className="ts-panel-header">
          <h3 className="ts-panel-title">Детализация</h3>
          <button className="ts-panel-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="ts-panel-content">
          <div className="ts-panel-employee">
            <div className="ts-panel-avatar">{getInitials(employee.full_name)}</div>
            <div>
              <div className="ts-panel-emp-name">{employee.full_name}</div>
              <div className="ts-panel-emp-role">{employee.position_name || '—'}</div>
            </div>
          </div>

          <div className="ts-panel-stats">
            <div className="ts-panel-stat">
              <div className="ts-panel-stat-value" style={{ color: 'var(--success)' }}>
                {Math.round(stats.factHours)}ч
              </div>
              <div className="ts-panel-stat-label">Отработано</div>
            </div>
            <div className="ts-panel-stat">
              <div className="ts-panel-stat-value">{stats.normHours}ч</div>
              <div className="ts-panel-stat-label">Норма</div>
            </div>
            <div className="ts-panel-stat">
              <div className="ts-panel-stat-value" style={{ color: 'var(--warning)' }}>
                {stats.lateCount}
              </div>
              <div className="ts-panel-stat-label">Опозданий</div>
            </div>
            <div className="ts-panel-stat">
              <div className="ts-panel-stat-value" style={{ color: 'var(--error)' }}>
                {stats.absentCount}
              </div>
              <div className="ts-panel-stat-label">Неявок</div>
            </div>
          </div>

          <div className="ts-panel-section">
            <div className="ts-panel-section-title">Детализация по дням</div>
            {dayDetails.map(({ day, entry }) => (
              <div
                key={day}
                className={`ts-day-detail ${entry?.status === 'absent' ? 'ts-day-detail--absent' : ''}`}
              >
                <div className="ts-day-detail-left">
                  <div>
                    <div className="ts-day-detail-date">{formatDateRu(day, month)}</div>
                    <div className="ts-day-detail-day">
                      {getWeekdayFull(year, month, day)}
                      {isToday(year, month, day) ? ' (сегодня)' : ''}
                    </div>
                  </div>
                </div>
                <div className={`ts-day-detail-hours ${getHoursClass(entry)}`}>
                  {getHoursLabel(entry)}
                </div>
              </div>
            ))}
            {dayDetails.length === 0 && (
              <div className="ts-loading">Нет данных за этот период</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
