import type { FC } from 'react';
import type { TimesheetStats as ITimesheetStats } from '../../types';

interface ITimesheetStatsProps {
  stats: ITimesheetStats;
  compact?: boolean;
}

export const TimesheetStats: FC<ITimesheetStatsProps> = ({ stats, compact = false }) => {
  return (
    <div className={`ts-stats-row${compact ? ' ts-stats-row--compact' : ''}`}>
      <div className="ts-stat-card">
        <div className="ts-stat-value">{stats.employeeCount}</div>
        <div className="ts-stat-label">{compact ? 'сотрудники' : 'сотрудников'}</div>
      </div>
    </div>
  );
};
