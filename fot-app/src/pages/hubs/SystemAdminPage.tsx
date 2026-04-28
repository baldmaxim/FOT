import { lazy, useMemo, type FC } from 'react';
import { Users, Shield, ClipboardCheck, Settings, History, KeyRound } from 'lucide-react';
import { HubShell, type IHubTab } from '../../components/hub/HubShell';

const UserManagementPage = lazy(() => import('../super-admin/UserManagementPage').then(m => ({ default: m.UserManagementPage })));
const RoleManagementPage = lazy(() => import('../super-admin/RoleManagementPage').then(m => ({ default: m.RoleManagementPage })));
const DataAuditPage = lazy(() => import('../super-admin/DataAuditPage').then(m => ({ default: m.DataAuditPage })));
const ActionHistoryPage = lazy(() => import('../super-admin/ActionHistoryPage').then(m => ({ default: m.ActionHistoryPage })));
const SystemSettingsPage = lazy(() => import('../super-admin/SystemSettingsPage').then(m => ({ default: m.SystemSettingsPage })));
const DataApiPage = lazy(() => import('../super-admin/DataApiPage').then(m => ({ default: m.DataApiPage })));

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
      key: 'data-api',
      label: 'API-доступ',
      accessPath: '/admin/data-api',
      icon: KeyRound,
      render: () => <DataApiPage />,
    },
  ], []);

  return <HubShell tabs={tabs} defaultTab="users" />;
};
