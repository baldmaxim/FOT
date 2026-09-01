import { lazy, useMemo, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, Briefcase, ShieldCheck, UserPlus } from 'lucide-react';
import { HubShell, type IHubTab } from '../components/hub/HubShell';
import { useAuth } from '../contexts/AuthContext';
import { hrProfileService } from '../services/hrProfileService';
// Панель фильтров общая для вкладок раздела. Импорт здесь, а не в ленивых вкладках:
// хаб грузится раньше любой из них, поэтому стили на месте при любом порядке открытия.
import '../styles/FilterBar.css';

const StaffControlPage = lazy(() => import('./StaffControlPage').then(m => ({ default: m.StaffControlPage })));
const HiringRequestsBoard = lazy(() => import('../components/staff/hiring/HiringRequestsBoard').then(m => ({ default: m.HiringRequestsBoard })));
const EmployeeInductionTab = lazy(() => import('../components/staff/EmployeeInductionTab').then(m => ({ default: m.EmployeeInductionTab })));
const NewEmployeeTab = lazy(() => import('../components/staff/hr/NewEmployeeTab').then(m => ({ default: m.NewEmployeeTab })));

export const StaffControlHubPage: FC = () => {
  const { isAdmin, canEditPage, canViewPage } = useAuth();

  // Вкладка «Новый сотрудник» требует оба права: создание идёт существующим
  // POST /api/employees (edit на /staff-control), профиль и сканы пишет HR API
  // (edit на ключ «Реквизиты»). Проверить только одно — значит пустить человека
  // в мастер, где он упрётся в 403 на последнем шаге.
  const canCreateEmployee = isAdmin || canEditPage('/staff-control');
  const hasHrEdit = isAdmin || canEditPage('/staff-control/hr-profiles');
  const hrCatalogQuery = useQuery({
    queryKey: ['hr-catalog'],
    queryFn: () => hrProfileService.getCatalog(),
    enabled: canCreateEmployee && (isAdmin || canViewPage('/staff-control/hr-profiles')),
    staleTime: 30 * 60_000,
    retry: false,
  });
  // Гейт по флагу раскатки обязателен здесь, а не только в HubShell: canViewPage
  // отдаёт админу true на любом ключе, поэтому иначе вкладка появилась бы у всех
  // администраторов сразу после деплоя, в обход hr_profiles_enabled.
  const newEmployeeTabAvailable = canCreateEmployee && hasHrEdit && hrCatalogQuery.data?.enabled === true;

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
    ...(newEmployeeTabAvailable ? [{
      key: 'new-employee',
      label: 'Новый сотрудник',
      accessPath: '/staff-control/hr-profiles',
      icon: UserPlus,
      render: () => <NewEmployeeTab />,
    } satisfies IHubTab] : []),
  ], [newEmployeeTabAvailable]);

  // persistInUrl={false}: StaffControlPage перезаписывает query string (dept/q/schedule)
  // и затирает ?tab=, что при URL-вкладках давало цикл навигации (Throttling navigation).
  return <HubShell tabs={tabs} defaultTab="roster" persistInUrl={false} />;
};
