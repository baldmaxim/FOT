import type { FC } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DateInput } from '../ui/DateInput';

export type SkudViewMode = 'day' | 'week' | 'month' | 'range';

const PERIOD_LABELS: Record<SkudViewMode, string> = {
  day: 'День',
  week: 'Неделя',
  month: 'Месяц',
  range: 'Период',
};

interface IEmployeeSkudControlsProps {
  viewMode: SkudViewMode;
  onViewModeChange: (mode: SkudViewMode) => void;
  rangeStart: string;
  rangeEnd: string;
  onRangeStartChange: (value: string) => void;
  onRangeEndChange: (value: string) => void;
  viewLabel: string;
  onPrev: () => void;
  onNext: () => void;
}

export const EmployeeSkudControls: FC<IEmployeeSkudControlsProps> = ({
  viewMode,
  onViewModeChange,
  rangeStart,
  rangeEnd,
  onRangeStartChange,
  onRangeEndChange,
  viewLabel,
  onPrev,
  onNext,
}) => (
  <div className="ec-stats-period-row">
    <div className="ec-stats-period-selector">
      {(['day', 'week', 'month', 'range'] as SkudViewMode[]).map(mode => (
        <button
          key={mode}
          className={`ec-stats-period-btn ${viewMode === mode ? 'active' : ''}`}
          onClick={() => onViewModeChange(mode)}
        >
          {PERIOD_LABELS[mode]}
        </button>
      ))}
    </div>
    <div className="ec-period-divider" />
    {viewMode === 'range' ? (
      <div className="ec-range-inputs">
        <DateInput value={rangeStart} onChange={onRangeStartChange} />
        <span className="ec-range-sep">—</span>
        <DateInput value={rangeEnd} onChange={onRangeEndChange} />
      </div>
    ) : (
      <div className="ec-date-nav">
        <button className="ec-date-nav-btn" onClick={onPrev}>
          <ChevronLeft size={16} />
        </button>
        <span className="ec-date-nav-label">{viewLabel}</span>
        <button className="ec-date-nav-btn" onClick={onNext}>
          <ChevronRight size={16} />
        </button>
      </div>
    )}
  </div>
);
