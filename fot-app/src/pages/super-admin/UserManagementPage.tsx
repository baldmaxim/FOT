import React, { useState, useEffect, useCallback } from 'react';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import type { Organization } from '../../types';
import { PendingUsersTab } from '../../components/super-admin/PendingUsersTab';
import type { IPendingUser } from '../../components/super-admin/PendingUsersTab';
import { AllUsersTab } from '../../components/super-admin/AllUsersTab';
import type { IUserFromApi } from '../../components/super-admin/AllUsersTab';
import styles from './SuperAdmin.module.css';

export const UserManagementPage: React.FC = () => {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<'pending' | 'all'>('pending');
  const [pendingUsers, setPendingUsers] = useState<IPendingUser[]>([]);
  const [allUsers, setAllUsers] = useState<IUserFromApi[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);

    try {
      const [pending, users, orgs] = await Promise.all([
        adminService.getPendingUsers(),
        adminService.getAllUsers(),
        adminService.getOrganizations(),
      ]);

      setPendingUsers(pending);
      setAllUsers(users);
      setOrganizations(orgs);
    } catch {
      toast.error('Ошибка загрузки данных');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Пустой массив - загружаем только при монтировании

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
        <PendingUsersTab
          pendingUsers={pendingUsers}
          organizations={organizations}
          onReload={loadData}
        />
      )}

      {activeTab === 'all' && (
        <AllUsersTab
          allUsers={allUsers}
          organizations={organizations}
          onReload={loadData}
        />
      )}
    </div>
  );
};
