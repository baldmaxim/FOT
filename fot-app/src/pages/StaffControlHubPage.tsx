import { lazy, useMemo, type FC } from 'react';
import { Users, Briefcase } from 'lucide-react';
import { HubShell, type IHubTab } from '../components/hub/HubShell';

const StaffControlPage = lazy(() => import('./StaffControlPage').then(m => ({ default: m.StaffControlPage })));
const HiringRequestsBoard = lazy(() => import('../components/staff/hiring/HiringRequestsBoard').then(m => ({ default: m.HiringRequestsBoard })));

export const StaffControlHubPage: FC = () => {
  const tabs = useMemo<IHubTab[]>(() => [
    {
      key: 'roster',
      label: 'Текущие сотрудники',
      accessPath: '/staff-control',
      icon: Users,
      render: () => <StaffControlPage />,
    },
    {
      key: 'hiring',
      label: 'Заявки на поиск сотрудников',
      accessPath: '/staff-control/hiring',
      icon: Briefcase,
      render: () => <HiringRequestsBoard />,
    },
  ], []);

  // persistInUrl={false}: StaffControlPage перезаписывает query string (dept/q/schedule)
  // и затирает ?tab=, что при URL-вкладках давало цикл навигации (Throttling navigation).
  return <HubShell tabs={tabs} defaultTab="roster" persistInUrl={false} />;
};
