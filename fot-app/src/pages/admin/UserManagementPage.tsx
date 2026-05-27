import React, { lazy, Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminService, type IUserSlim, type IPasswordResetRequest } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import type { IPendingUser } from '../../components/admin/PendingUsersTab';
import styles from './Admin.module.css';

const PendingUsersTab = lazy(() => import('../../components/admin/PendingUsersTab').then(module => ({
  default: module.PendingUsersTab,
})));
const AllUsersTab = lazy(() => import('../../components/admin/AllUsersTab').then(module => ({
  default: module.AllUsersTab,
})));
const DepartmentAccessImportTab = lazy(() => import('../../components/admin/DepartmentAccessImportTab').then(module => ({
  default: module.DepartmentAccessImportTab,
})));
const EmployeeDepartmentAssignmentsTab = lazy(() => import('../../components/admin/EmployeeDepartmentAssignmentsTab').then(module => ({
  default: module.EmployeeDepartmentAssignmentsTab,
})));
const PasswordResetRequestsTab = lazy(() => import('../../components/admin/PasswordResetRequestsTab').then(module => ({
  default: module.PasswordResetRequestsTab,
})));

export const UserManagementPage: React.FC = () => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'pending' | 'all' | 'employee-access' | 'import' | 'password-reset'>('pending');
  const pendingUsersQuery = useQuery<IPendingUser[]>({
    queryKey: ['admin-users', 'pending'],
    queryFn: () => adminService.getPendingUsers(),
    staleTime: 30_000,
  });
  const passwordResetRequestsQuery = useQuery<IPasswordResetRequest[]>({
    queryKey: ['admin-users', 'password-reset-requests'],
    queryFn: () => adminService.getPasswordResetRequests(),
    staleTime: 30_000,
  });
  // Лёгкий COUNT(*) для бейджа «Все пользователи (N)» — грузим всегда (≤ десятки мс).
  const allUsersCountQuery = useQuery<number>({
    queryKey: ['admin-users', 'count'],
    queryFn: () => adminService.getAllUsersCount(),
    staleTime: 60_000,
  });
  // Полный slim-список нужен только вкладкам assignments/import — лениво.
  const needsSlim = activeTab === 'employee-access' || activeTab === 'import';
  const allUsersSlimQuery = useQuery<IUserSlim[]>({
    queryKey: ['admin-users', 'slim'],
    queryFn: () => adminService.getAllUsersSlim(),
    staleTime: 30_000,
    enabled: needsSlim,
  });
  const pendingUsers = pendingUsersQuery.data || [];
  const allUsersSlim = allUsersSlimQuery.data || [];
  const allUsersCount = allUsersCountQuery.data ?? 0;
  const pendingLoading = pendingUsersQuery.isPending;
  const allCountLoading = allUsersCountQuery.isPending;
  const allSlimLoading = needsSlim && allUsersSlimQuery.isPending;
  const hasQueryError = pendingUsersQuery.isError || allUsersCountQuery.isError || allUsersSlimQuery.isError || passwordResetRequestsQuery.isError;
  const passwordResetRequests = passwordResetRequestsQuery.data || [];
  const passwordResetLoading = passwordResetRequestsQuery.isPending;

  const reloadUsers = async () => {
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-employees', 'department-access'] }),
      ]);
    } catch {
      toast.error('Ошибка загрузки данных');
    }
  };

  const patchPendingCache = (updater: (prev: IPendingUser[]) => IPendingUser[]) => {
    queryClient.setQueryData<IPendingUser[]>(['admin-users', 'pending'], (old) => updater(old || []));
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Управление пользователями</h1>
      </div>

      {hasQueryError && (
        <div className={styles.error}>Ошибка загрузки данных</div>
      )}

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'pending' ? styles.active : ''}`}
          onClick={() => setActiveTab('pending')}
        >
          Ожидающие ({pendingLoading ? '…' : pendingUsers.length})
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'all' ? styles.active : ''}`}
          onClick={() => setActiveTab('all')}
        >
          Все пользователи ({allCountLoading ? '…' : allUsersCount})
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'employee-access' ? styles.active : ''}`}
          onClick={() => setActiveTab('employee-access')}
        >
          Назначения сотрудников
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'import' ? styles.active : ''}`}
          onClick={() => setActiveTab('import')}
        >
          Импорт назначений
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'password-reset' ? styles.active : ''}`}
          onClick={() => setActiveTab('password-reset')}
        >
          Запросы на сброс пароля ({passwordResetLoading ? '…' : passwordResetRequests.length})
        </button>
      </div>

      {activeTab === 'pending' && (
        <Suspense fallback={<div className={styles.loading}>Загрузка вкладки...</div>}>
          <PendingUsersTab
            pendingUsers={pendingUsers}
            loading={pendingLoading}
            onReload={reloadUsers}
            patchPendingCache={patchPendingCache}
          />
        </Suspense>
      )}

      {activeTab === 'all' && (
        <Suspense fallback={<div className={styles.loading}>Загрузка вкладки...</div>}>
          <AllUsersTab onReload={reloadUsers} />
        </Suspense>
      )}

      {activeTab === 'employee-access' && (
        <Suspense fallback={<div className={styles.loading}>Загрузка вкладки...</div>}>
          <EmployeeDepartmentAssignmentsTab
            allUsers={allUsersSlim}
            allUsersLoading={allSlimLoading}
            onReload={reloadUsers}
          />
        </Suspense>
      )}

      {activeTab === 'import' && (
        <Suspense fallback={<div className={styles.loading}>Загрузка вкладки...</div>}>
          <DepartmentAccessImportTab
            allUsers={allUsersSlim}
            onReload={reloadUsers}
          />
        </Suspense>
      )}

      {activeTab === 'password-reset' && (
        <Suspense fallback={<div className={styles.loading}>Загрузка вкладки...</div>}>
          <PasswordResetRequestsTab
            requests={passwordResetRequests}
            loading={passwordResetLoading}
            onReload={reloadUsers}
          />
        </Suspense>
      )}
    </div>
  );
};
