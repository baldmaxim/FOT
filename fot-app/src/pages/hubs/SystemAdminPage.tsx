import { lazy, useMemo, type FC } from 'react';
import { Users, Shield, ClipboardCheck, Settings, History, KeyRound, Activity, HardHat } from 'lucide-react';
import { HubShell, type IHubTab } from '../../components/hub/HubShell';

const UserManagementPage = lazy(() => import('../admin/UserManagementPage').then(m => ({ default: m.UserManagementPage })));
const BrigadeAssignmentsTab = lazy(() => import('../../components/admin/BrigadeAssignmentsTab').then(m => ({ default: m.BrigadeAssignmentsTab })));
const RoleManagementPage = lazy(() => import('../admin/RoleManagementPage').then(m => ({ default: m.RoleManagementPage })));
const DataAuditPage = lazy(() => import('../admin/DataAuditPage').then(m => ({ default: m.DataAuditPage })));
const ActionHistoryPage = lazy(() => import('../admin/ActionHistoryPage').then(m => ({ default: m.ActionHistoryPage })));
const SystemSettingsPage = lazy(() => import('../admin/SystemSettingsPage').then(m => ({ default: m.SystemSettingsPage })));
const SystemResourcesPage = lazy(() => import('../admin/SystemResourcesPage').then(m => ({ default: m.SystemResourcesPage })));
const DataApiPage = lazy(() => import('../admin/DataApiPage').then(m => ({ default: m.DataApiPage })));

export const SystemAdminPage: FC = () => {
  const tabs = useMemo<IHubTab[]>(() => [
    {
      key: 'users',
      label: 'Пользователи',
      accessPath: '/admin/users',
      icon: Users,
      render: () => <UserManagementPage />,
    },
    {
      key: 'brigades',
      label: 'Бригады',
      accessPath: '/admin/users',
      icon: HardHat,
      render: () => <BrigadeAssignmentsTab />,
    },
    {
      key: 'roles',
      label: 'Роли',
      accessPath: '/admin/roles',
      icon: Shield,
      render: () => <RoleManagementPage />,
    },
    {
      key: 'audit',
      label: 'Аудит',
      accessPath: '/admin/audit',
      icon: ClipboardCheck,
      render: () => <DataAuditPage />,
    },
    {
      key: 'action-history',
      label: 'История действий',
      accessPath: '/admin/action-history',
      icon: History,
      render: () => <ActionHistoryPage />,
    },
    {
      key: 'settings',
      label: 'Настройки',
      accessPath: '/admin/settings',
      icon: Settings,
      render: () => <SystemSettingsPage />,
    },
    {
      key: 'resources',
      label: 'Ресурсы',
      accessPath: '/admin/settings',
      icon: Activity,
      render: () => <SystemResourcesPage />,
    },
    {
      key: 'data-api',
      label: 'API-доступ',
      accessPath: '/admin/data-api',
      icon: KeyRound,
      render: () => <DataApiPage />,
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="users" />;
};
