import React, { lazy, Suspense, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import type { IPendingUser } from '../../components/super-admin/PendingUsersTab';
import type { IUserFromApi } from '../../components/super-admin/AllUsersTab';
import styles from './SuperAdmin.module.css';

const PendingUsersTab = lazy(() => import('../../components/super-admin/PendingUsersTab').then(module => ({
  default: module.PendingUsersTab,
})));
const AllUsersTab = lazy(() => import('../../components/super-admin/AllUsersTab').then(module => ({
  default: module.AllUsersTab,
})));

export const UserManagementPage: React.FC = () => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'pending' | 'all'>('pending');
  const pendingUsersQuery = useQuery<IPendingUser[]>({
    queryKey: ['admin-users', 'pending'],
    queryFn: () => adminService.getPendingUsers(),
    staleTime: 30_000,
  });
  const allUsersQuery = useQuery<IUserFromApi[]>({
    queryKey: ['admin-users', 'all'],
    queryFn: () => adminService.getAllUsers(),
    staleTime: 30_000,
  });
  const pendingUsers = pendingUsersQuery.data || [];
  const allUsers = allUsersQuery.data || [];
  const loading = pendingUsersQuery.isPending || allUsersQuery.isPending;
  const hasQueryError = pendingUsersQuery.isError || allUsersQuery.isError;

  const reloadUsers = async () => {
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-users', 'pending'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-users', 'all'] }),
      ]);
    } catch {
      toast.error('Ошибка загрузки данных');
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Загрузка...</div>
      </div>
    );
  }

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
          Ожидающие ({pendingUsers.length})
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'all' ? styles.active : ''}`}
          onClick={() => setActiveTab('all')}
        >
          Все пользователи ({allUsers.length})
        </button>
      </div>

      {activeTab === 'pending' && (
        <Suspense fallback={<div className={styles.loading}>Загрузка вкладки...</div>}>
          <PendingUsersTab
            pendingUsers={pendingUsers}
            onReload={reloadUsers}
          />
        </Suspense>
      )}

      {activeTab === 'all' && (
        <Suspense fallback={<div className={styles.loading}>Загрузка вкладки...</div>}>
          <AllUsersTab
            allUsers={allUsers}
            onReload={reloadUsers}
          />
        </Suspense>
      )}
    </div>
  );
};
