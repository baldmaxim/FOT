import type { FC } from 'react';
import type { TimesheetStats as ITimesheetStats } from '../../types';

interface ITimesheetStatsProps {
  stats: ITimesheetStats;
  onLateClick?: () => void;
  compact?: boolean;
}

export const TimesheetStats: FC<ITimesheetStatsProps> = ({ stats, onLateClick, compact = false }) => {
  const totalDeviations = stats.deviations.late + stats.deviations.absent + stats.deviations.sick;

  const deviationParts: string[] = [];
  if (stats.deviations.late > 0) deviationParts.push(`${stats.deviations.late} опозд.`);
  if (stats.deviations.absent > 0) deviationParts.push(`${stats.deviations.absent} неявок`);
  if (stats.deviations.sick > 0) deviationParts.push(`${stats.deviations.sick} больн.`);
  const deviationLabel = compact
    ? 'отклонения'
    : (deviationParts.length > 0 ? deviationParts.join(', ') : 'отклонений');

  return (
    <div className={`ts-stats-row${compact ? ' ts-stats-row--compact' : ''}`}>
      <div className="ts-stat-card">
        <div className="ts-stat-value">{stats.employeeCount}</div>
        <div className="ts-stat-label">{compact ? 'сотрудники' : 'сотрудников'}</div>
      </div>
      <div className="ts-stat-card">
        <div className="ts-stat-value">{Math.round(stats.normHours)}ч</div>
        <div className="ts-stat-label">
          {compact ? 'норма' : `норма (${stats.workingDays} дн.)`}
        </div>
      </div>
      <div className="ts-stat-card">
        <div className="ts-stat-value ts-stat-value--green">{Math.round(stats.actualHours)}ч</div>
        <div className="ts-stat-label">факт</div>
      </div>
      <div
        className={`ts-stat-card${onLateClick ? ' ts-stat-card--clickable' : ''}`}
        onClick={onLateClick}
        title={deviationParts.length > 0 ? deviationParts.join(', ') : 'Без отклонений'}
      >
        <div className="ts-stat-value ts-stat-value--orange">{totalDeviations}</div>
        <div className="ts-stat-label">{deviationLabel}</div>
      </div>
    </div>
  );
};
