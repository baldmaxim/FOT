import type { FC } from 'react';
import type { TimesheetStats as ITimesheetStats } from '../../types';

interface ITimesheetStatsProps {
  stats: ITimesheetStats;
}

export const TimesheetStats: FC<ITimesheetStatsProps> = ({ stats }) => {
  const totalDeviations = stats.deviations.late + stats.deviations.absent + stats.deviations.sick;

  const deviationParts: string[] = [];
  if (stats.deviations.late > 0) deviationParts.push(`${stats.deviations.late} опозд.`);
  if (stats.deviations.absent > 0) deviationParts.push(`${stats.deviations.absent} неявок`);
  if (stats.deviations.sick > 0) deviationParts.push(`${stats.deviations.sick} больн.`);

  return (
    <div className="ts-stats-row">
      <div className="ts-stat-card">
        <div className="ts-stat-value">{stats.employeeCount}</div>
        <div className="ts-stat-label">сотрудников</div>
      </div>
      <div className="ts-stat-card">
        <div className="ts-stat-value">{Math.round(stats.normHours)}ч</div>
        <div className="ts-stat-label">норма ({stats.workingDays} дн.)</div>
      </div>
      <div className="ts-stat-card">
        <div className="ts-stat-value ts-stat-value--green">{Math.round(stats.actualHours)}ч</div>
        <div className="ts-stat-label">факт</div>
      </div>
      <div className="ts-stat-card">
        <div className="ts-stat-value ts-stat-value--orange">{totalDeviations}</div>
        <div className="ts-stat-label">
          {deviationParts.length > 0 ? deviationParts.join(', ') : 'отклонений'}
        </div>
      </div>
    </div>
  );
};
