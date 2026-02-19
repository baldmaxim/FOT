import React, { useState, useEffect, useCallback } from 'react';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import type { Organization, EmployeePositionType } from '../../types';
import styles from './SuperAdmin.module.css';

interface OrganizationWithStats extends Organization {
  member_count?: number;
}

interface UserInOrg {
  id: string;
  full_name: string | null;
  position_type: EmployeePositionType;
  is_approved: boolean;
  two_factor_enabled: boolean;
  organization_id: string | null;
}

export const OrganizationsPage: React.FC = () => {
  const toast = useToast();
  const [organizations, setOrganizations] = useState<OrganizationWithStats[]>([]);
  const [allUsers, setAllUsers] = useState<UserInOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null);

  // Create modal state
  const [createModal, setCreateModal] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [creating, setCreating] = useState(false);

  // Edit state (inline)
  const [editingOrg, setEditingOrg] = useState<{ id: string; name: string } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);

    try {
      const [orgs, users] = await Promise.all([
        adminService.getOrganizationsWithStats(),
        adminService.getAllUsers(),
      ]);

      setOrganizations(orgs);
      setAllUsers(users.map(u => ({
        id: u.id,
        full_name: u.full_name,
        position_type: u.position_type,
        is_approved: u.is_approved,
        two_factor_enabled: u.two_factor_enabled,
        organization_id: u.organization_id,
      })));
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

  const toggleExpand = (orgId: string) => {
    setExpandedOrgId(prev => prev === orgId ? null : orgId);
    setEditingOrg(null);
  };

  const getUsersInOrg = (orgId: string): UserInOrg[] => {
    return allUsers.filter(u => u.organization_id === orgId);
  };

  const getPositionName = (positionType: EmployeePositionType) => {
    const positionNames: Record<EmployeePositionType, string> = {
      super_admin: 'Супер-админ',
      admin: 'Администратор',
      header: 'Руководитель',
      worker: 'Сотрудник',
    };
    return positionNames[positionType] || positionType;
  };

  const handleCreate = async () => {
    if (!newOrgName.trim()) return;

    setCreating(true);

    try {
      await adminService.createOrganization(newOrgName.trim());
      toast.success('Отдел создан');
      setNewOrgName('');
      setCreateModal(false);
      await loadData();
    } catch {
      toast.error('Ошибка создания отдела');
    } finally {
      setCreating(false);
    }
  };

  const handleEditStart = (org: OrganizationWithStats) => {
    setEditingOrg({ id: org.id, name: org.name });
  };

  const handleEditSave = async () => {
    if (!editingOrg || !editingOrg.name.trim()) return;

    try {
      await adminService.updateOrganization(editingOrg.id, editingOrg.name.trim());
      toast.success('Отдел обновлён');
      setEditingOrg(null);
      await loadData();
    } catch {
      toast.error('Ошибка обновления отдела');
    }
  };

  const handleEditCancel = () => {
    setEditingOrg(null);
  };

  const handleDelete = async (org: OrganizationWithStats) => {
    if (org.member_count && org.member_count > 0) {
      toast.error('Нельзя удалить отдел с сотрудниками. Сначала переместите или удалите сотрудников.');
      return;
    }

    if (!confirm(`Удалить отдел "${org.name}"?`)) return;

    try {
      await adminService.deleteOrganization(org.id);
      toast.success('Отдел удалён');
      await loadData();
    } catch {
      toast.error('Ошибка удаления отдела');
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
        <h1>Управление отделами</h1>
        <button className={styles.primaryBtn} onClick={() => setCreateModal(true)}>
          + Создать отдел
        </button>
      </div>

      {organizations.length === 0 ? (
        <div className={styles.empty}>
          Нет отделов. Создайте первый отдел.
        </div>
      ) : (
        <div className={styles.userListCompact}>
          {organizations.map(org => {
            const isExpanded = expandedOrgId === org.id;
            const usersInOrg = getUsersInOrg(org.id);

            return (
              <div key={org.id} className={`${styles.userRow} ${isExpanded ? styles.expanded : ''}`}>
                {/* Header row */}
                <div className={styles.userRowHeader} onClick={() => toggleExpand(org.id)}>
                  <div className={styles.userRowInfo}>
                    <div className={styles.userRowName}>
                      {org.name}
                    </div>
                    <div className={styles.userRowEmail}>
                      Создан: {new Date(org.created_at).toLocaleDateString('ru-RU')}
                    </div>
                  </div>

                  <div className={styles.userRowMeta}>
                    <span className={styles.userRowRole}>
                      {org.member_count || 0} сотрудников
                    </span>
                  </div>

                  <div className={styles.expandIcon}>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div className={styles.userRowControls}>
                    {/* Edit name */}
                    <div className={styles.controlGroup}>
                      <label>Название:</label>
                      {editingOrg?.id === org.id ? (
                        <div className={styles.nameEditGroup}>
                          <input
                            type="text"
                            value={editingOrg.name}
                            onChange={(e) => setEditingOrg({ ...editingOrg, name: e.target.value })}
                            className={styles.nameInput}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleEditSave();
                              if (e.key === 'Escape') handleEditCancel();
                            }}
                          />
                          <button className={styles.saveBtn} onClick={handleEditSave}>Сохранить</button>
                          <button className={styles.cancelBtn} onClick={handleEditCancel}>Отмена</button>
                        </div>
                      ) : (
                        <button
                          className={styles.editNameBtn}
                          onClick={() => handleEditStart(org)}
                        >
                          {org.name}
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                      )}
                    </div>

                    <div className={styles.controlActions}>
                      <button
                        className={styles.dangerBtn}
                        onClick={() => handleDelete(org)}
                        disabled={Boolean(org.member_count && org.member_count > 0)}
                      >
                        Удалить отдел
                      </button>
                    </div>

                    {/* Users list */}
                    {usersInOrg.length > 0 && (
                      <div className={styles.orgUsersList}>
                        <div className={styles.orgUsersHeader}>Сотрудники отдела:</div>
                        {usersInOrg.map(user => (
                          <div key={user.id} className={styles.orgUserItem}>
                            <span className={styles.orgUserName}>
                              {user.full_name || 'Без имени'}
                            </span>
                            <span className={styles.orgUserRole}>
                              {getPositionName(user.position_type)}
                            </span>
                            {!user.is_approved ? (
                              <span className={styles.notApproved}>Не одобрен</span>
                            ) : !user.two_factor_enabled ? (
                              <span className={styles.twoFaDisabled}>Ожидает 2FA</span>
                            ) : (
                              <span className={styles.approved}>Активен</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {usersInOrg.length === 0 && (
                      <div className={styles.orgUsersEmpty}>
                        В этом отделе пока нет сотрудников
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create Modal */}
      {createModal && (
        <div className={styles.modalOverlay} onClick={() => setCreateModal(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>Создание отдела</h2>
              <button className={styles.closeBtn} onClick={() => setCreateModal(false)}>
                &times;
              </button>
            </div>

            <div className={styles.modalContent}>
              <div className={styles.controlGroup} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <label>Название отдела</label>
                <input
                  type="text"
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  placeholder="Отдел продаж"
                  style={{
                    padding: '12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                    marginTop: '8px',
                  }}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
                <button
                  className={styles.rejectBtn}
                  onClick={() => setCreateModal(false)}
                  style={{ flex: 1 }}
                >
                  Отмена
                </button>
                <button
                  className={styles.primaryBtn}
                  onClick={handleCreate}
                  disabled={creating || !newOrgName.trim()}
                  style={{ flex: 1 }}
                >
                  {creating ? 'Создание...' : 'Создать'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
