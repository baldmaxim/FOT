import { type FC, useState, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Calendar, ChevronDown } from 'lucide-react';
import { DateInput } from '../../components/ui/DateInput';
import { formatTimesheetRangeLabel, type ITimesheetDateRange } from '../../utils/timesheetApprovalPeriod';
import { getMonthLabel } from '../../utils/calendarUtils';

interface IPeriodPickerProps {
  period: ITimesheetDateRange;
  onChange: (period: ITimesheetDateRange) => void;
}

type Preset = 'today' | 'week' | 'month';

const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtIso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseIso = (iso: string) => new Date(`${iso}T00:00:00`);

const monthRange = (year: number, month: number): ITimesheetDateRange => {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return { startDate: fmtIso(start), endDate: fmtIso(end) };
};

const todayPeriod = (): ITimesheetDateRange => {
  const t = fmtIso(new Date());
  return { startDate: t, endDate: t };
};

const weekPeriod = (): ITimesheetDateRange => {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const mon = new Date(now);
  mon.setDate(now.getDate() + mondayOffset);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { startDate: fmtIso(mon), endDate: fmtIso(sun) };
};

const currentMonthPeriod = (): ITimesheetDateRange => {
  const n = new Date();
  return monthRange(n.getFullYear(), n.getMonth() + 1);
};

const detectActivePreset = (period: ITimesheetDateRange): Preset | null => {
  const t = todayPeriod();
  if (period.startDate === t.startDate && period.endDate === t.endDate) return 'today';
  const w = weekPeriod();
  if (period.startDate === w.startDate && period.endDate === w.endDate) return 'week';
  const m = currentMonthPeriod();
  if (period.startDate === m.startDate && period.endDate === m.endDate) return 'month';
  return null;
};

export const PeriodPicker: FC<IPeriodPickerProps> = ({ period, onChange }) => {
  const [rangeOpen, setRangeOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(period.startDate);
  const [draftEnd, setDraftEnd] = useState(period.endDate);
  const rangeRef = useRef<HTMLDivElement | null>(null);
  const presetsRef = useRef<HTMLDivElement | null>(null);

  const openRange = () => {
    setPresetsOpen(false);
    setDraftStart(period.startDate);
    setDraftEnd(period.endDate);
    setRangeOpen(true);
  };

  useEffect(() => {
    if (!rangeOpen && !presetsOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rangeOpen && rangeRef.current && !rangeRef.current.contains(target)) {
        setRangeOpen(false);
      }
      if (presetsOpen && presetsRef.current && !presetsRef.current.contains(target)) {
        setPresetsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRangeOpen(false);
        setPresetsOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [rangeOpen, presetsOpen]);

  const monthStart = parseIso(period.startDate);
  const labelYear = monthStart.getFullYear();
  const labelMonth = monthStart.getMonth() + 1;

  const goPrevMonth = () => {
    const m = labelMonth === 1 ? 12 : labelMonth - 1;
    const y = labelMonth === 1 ? labelYear - 1 : labelYear;
    onChange(monthRange(y, m));
  };

  const goNextMonth = () => {
    const m = labelMonth === 12 ? 1 : labelMonth + 1;
    const y = labelMonth === 12 ? labelYear + 1 : labelYear;
    onChange(monthRange(y, m));
  };

  const applyRange = () => {
    onChange({ startDate: draftStart, endDate: draftEnd });
    setRangeOpen(false);
  };

  const applyPreset = (preset: Preset) => {
    if (preset === 'today') onChange(todayPeriod());
    else if (preset === 'week') onChange(weekPeriod());
    else onChange(currentMonthPeriod());
    setPresetsOpen(false);
  };

  const activePreset = detectActivePreset(period);
  const presetLabel = activePreset === 'today'
    ? 'Сегодня'
    : activePreset === 'week' ? 'Неделя' : activePreset === 'month' ? 'Месяц' : 'Период';

  return (
    <div className="period-picker">
      <div className="period-picker-nav" role="group" aria-label="Месяц">
        <button
          type="button"
          className="period-picker-nav-btn"
          onClick={goPrevMonth}
          aria-label="Предыдущий месяц"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="period-picker-nav-label">{getMonthLabel(labelYear, labelMonth)}</span>
        <button
          type="button"
          className="period-picker-nav-btn"
          onClick={goNextMonth}
          aria-label="Следующий месяц"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="period-picker-range" ref={rangeRef}>
        <button
          type="button"
          className={`period-picker-range-btn${rangeOpen ? ' is-open' : ''}`}
          onClick={() => { if (rangeOpen) setRangeOpen(false); else openRange(); }}
          aria-expanded={rangeOpen}
          aria-haspopup="dialog"
        >
          <Calendar size={14} />
          <span className="period-picker-range-text">
            {formatTimesheetRangeLabel(period.startDate, period.endDate)}
          </span>
        </button>
        {rangeOpen && (
          <div className="period-picker-popover" role="dialog" aria-label="Произвольный диапазон">
            <label className="period-picker-popover-row">
              <span>С</span>
              <DateInput value={draftStart} onChange={setDraftStart} />
            </label>
            <label className="period-picker-popover-row">
              <span>По</span>
              <DateInput value={draftEnd} onChange={setDraftEnd} />
            </label>
            <div className="period-picker-popover-actions">
              <button
                type="button"
                className="period-picker-popover-cancel"
                onClick={() => setRangeOpen(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="period-picker-popover-apply"
                onClick={applyRange}
                disabled={!draftStart || !draftEnd || draftStart > draftEnd}
              >
                Применить
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="period-picker-presets" role="group" aria-label="Быстрые периоды">
        <button
          type="button"
          className={`period-picker-preset${activePreset === 'today' ? ' is-active' : ''}`}
          onClick={() => applyPreset('today')}
        >
          Сегодня
        </button>
        <button
          type="button"
          className={`period-picker-preset${activePreset === 'week' ? ' is-active' : ''}`}
          onClick={() => applyPreset('week')}
        >
          Неделя
        </button>
        <button
          type="button"
          className={`period-picker-preset${activePreset === 'month' ? ' is-active' : ''}`}
          onClick={() => applyPreset('month')}
        >
          Месяц
        </button>
      </div>

      <div className="period-picker-presets-mobile" ref={presetsRef}>
        <button
          type="button"
          className={`period-picker-preset is-mobile${activePreset ? ' is-active' : ''}`}
          onClick={() => { setRangeOpen(false); setPresetsOpen(o => !o); }}
          aria-expanded={presetsOpen}
          aria-haspopup="menu"
        >
          {presetLabel}
          <ChevronDown size={14} />
        </button>
        {presetsOpen && (
          <div className="period-picker-presets-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className={`period-picker-presets-menu-item${activePreset === 'today' ? ' is-active' : ''}`}
              onClick={() => applyPreset('today')}
            >
              Сегодня
            </button>
            <button
              type="button"
              role="menuitem"
              className={`period-picker-presets-menu-item${activePreset === 'week' ? ' is-active' : ''}`}
              onClick={() => applyPreset('week')}
            >
              Неделя
            </button>
            <button
              type="button"
              role="menuitem"
              className={`period-picker-presets-menu-item${activePreset === 'month' ? ' is-active' : ''}`}
              onClick={() => applyPreset('month')}
            >
              Месяц
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
