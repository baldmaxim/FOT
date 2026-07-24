import { lazy, useMemo, type FC } from 'react';
import { Users, Briefcase, ShieldCheck } from 'lucide-react';
import { HubShell, type IHubTab } from '../components/hub/HubShell';

const StaffControlPage = lazy(() => import('./StaffControlPage').then(m => ({ default: m.StaffControlPage })));
const HiringRequestsBoard = lazy(() => import('../components/staff/hiring/HiringRequestsBoard').then(m => ({ default: m.HiringRequestsBoard })));
const EmployeeInductionTab = lazy(() => import('../components/staff/EmployeeInductionTab').then(m => ({ default: m.EmployeeInductionTab })));

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
    {
      key: 'induction',
      label: 'Вводный инструктаж',
      // Виден и по общему праву «Управление кадрами» (просмотр), и по узкому ключу
      // вкладки — им открывается раздел роли ОТиТБ, у которой /staff-control нет.
      accessPath: ['/staff-control', '/staff-control/induction'],
      icon: ShieldCheck,
      render: () => <EmployeeInductionTab />,
    },
  ], []);

  // persistInUrl={false}: StaffControlPage перезаписывает query string (dept/q/schedule)
  // и затирает ?tab=, что при URL-вкладках давало цикл навигации (Throttling navigation).
  return <HubShell tabs={tabs} defaultTab="roster" persistInUrl={false} />;
};
