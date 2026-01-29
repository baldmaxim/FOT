import React from 'react';
import { StatCard } from '../components/ui/StatCard';
import { Button } from '../components/ui/Button';
import { ActivityList } from '../components/dashboard/ActivityList';
import { PresenceProgress } from '../components/dashboard/PresenceProgress';
import { QuickActions } from '../components/dashboard/QuickActions';
import {
  UsersIcon,
  MapPinIcon,
  DollarIcon,
  CheckCircleIcon,
  PlusIcon
} from '../components/ui/Icons';

export const DashboardPage: React.FC = () => {
  const today = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  return (
    <>
      <div className="content-header">
        <div className="date-display">{today}</div>
        <Button icon={<PlusIcon />}>Добавить сотрудника</Button>
      </div>

      <div className="stats-grid">
        <StatCard
          label="Всего сотрудников"
          value="—"
          icon={<UsersIcon />}
          iconType="blue"
        />
        <StatCard
          label="На объектах"
          value="—"
          icon={<MapPinIcon />}
          iconType="green"
        />
        <StatCard
          label="ФОТ за месяц"
          value="— ₽"
          icon={<DollarIcon />}
          iconType="orange"
        />
        <StatCard
          label="Выработка"
          value="—%"
          icon={<CheckCircleIcon />}
          iconType="green"
        />
      </div>

      <div className="content-grid">
        <ActivityList />
        <div className="right-column">
          <PresenceProgress />
          <QuickActions />
        </div>
      </div>
    </>
  );
};
