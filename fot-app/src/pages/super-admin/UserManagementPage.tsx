import React, { useState, useEffect, useCallback } from 'react';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import type { TwoFactorData, EmployeePositionType, Organization } from '../../types';
import { POSITION_LABELS } from '../../types';
import styles from './SuperAdmin.module.css';

interface UserFromApi {
  id: string;
  email?: string;
  full_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  position_type: EmployeePositionType;
  imported_position: string | null;
  employee_id: string | null;
  supervisor_id: string | null;
  is_approved: boolean;
  two_factor_enabled: boolean;
  approved_at: string | null;
  created_at: string;
}

interface PendingUserFromApi {
  id: string;
  email: string;
  full_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  position_type: EmployeePositionType;
  imported_position: string | null;
  created_at: string;
}

export const UserManagementPage: React.FC = () => {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<'pending' | 'all'>('pending');
  const [pendingUsers, setPendingUsers] = useState<PendingUserFromApi[]>([]);
  const [allUsers, setAllUsers] = useState<UserFromApi[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<{ userId: string; value: string } | null>(null);

  const toggleExpand = (userId: string) => {
    setExpandedUserId(prev => prev === userId ? null : userId);
    setEditingName(null);
  };

  const handleNameEdit = (userId: string, currentName: string | null) => {
    setEditingName({ userId, value: currentName || '' });
  };

  const handleNameSave = async () => {
    if (!editingName || !editingName.value.trim()) return;

    try {
      await adminService.updateUserName(editingName.userId, editingName.value.trim());
      toast.success('ФИО обновлено');
      setEditingName(null);
      await loadData();
    } catch {
      toast.error('Ошибка обновления ФИО');
    }
  };

  const handleNameCancel = () => {
    setEditingName(null);
  };

  const getOrgName = (orgId: string | null) => {
    if (!orgId) return 'Не назначена';
    const org = organizations.find(o => o.id === orgId);
    return org?.name || 'Неизвестная';
  };

  const getPositionName = (positionType: EmployeePositionType) => {
    return POSITION_LABELS[positionType] || positionType;
  };

  // 2FA modal state
  const [twoFactorModal, setTwoFactorModal] = useState<{
    visible: boolean;
    userId: string;
    userName: string;
    data: TwoFactorData | null;
    loading: boolean;
  }>({
    visible: false,
    userId: '',
    userName: '',
    data: null,
    loading: false,
  });

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

  const handleApprove = async (userId: string) => {
    try {
      await adminService.approveUser(userId);
      toast.success('Пользователь одобрен. Теперь выдайте ему 2FA.');
      await loadData();
    } catch {
      toast.error('Ошибка одобрения пользователя');
    }
  };

  const handleReject = async (userId: string) => {
    if (!confirm('Отклонить заявку пользователя?')) return;

    try {
      await adminService.rejectUser(userId);
      toast.success('Заявка отклонена');
      await loadData();
    } catch {
      toast.error('Ошибка отклонения пользователя');
    }
  };

  const handleConfirmEmail = async (userId: string) => {
    try {
      await adminService.confirmUserEmail(userId);
      toast.success('Email подтверждён');
      await loadData();
    } catch {
      toast.error('Ошибка подтверждения email');
    }
  };

  const handleGenerate2FA = async (userId: string, userName: string) => {
    setTwoFactorModal({
      visible: true,
      userId,
      userName,
      data: null,
      loading: true,
    });

    try {
      const data = await adminService.generate2FA(userId);
      setTwoFactorModal(prev => ({
        ...prev,
        data,
        loading: false,
      }));
      toast.success('2FA успешно сгенерирован');
      await loadData();
    } catch {
      toast.error('Ошибка генерации 2FA');
      setTwoFactorModal(prev => ({ ...prev, visible: false }));
    }
  };

  const handleDisable2FA = async (userId: string) => {
    if (!confirm('Отключить 2FA для пользователя? Это снизит безопасность аккаунта.')) return;

    try {
      await adminService.disable2FA(userId);
      toast.warning('2FA отключен');
      await loadData();
    } catch {
      toast.error('Ошибка отключения 2FA');
    }
  };

  const handlePositionChange = async (userId: string, positionType: EmployeePositionType) => {
    try {
      await adminService.updateUserPosition(userId, positionType);
      toast.success('Должность изменена');
      await loadData();
    } catch {
      toast.error('Ошибка изменения должности');
    }
  };

  const handleOrgChange = async (userId: string, orgId: string) => {
    try {
      await adminService.assignOrganization(userId, orgId);
      toast.success('Организация назначена');
      await loadData();
    } catch {
      toast.error('Ошибка назначения организации');
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!confirm('Удалить пользователя из системы? Это действие необратимо.')) return;

    try {
      await adminService.deleteUser(userId);
      toast.success('Пользователь удалён');
      await loadData();
    } catch {
      toast.error('Ошибка удаления пользователя');
    }
  };

  const closeTwoFactorModal = () => {
    setTwoFactorModal({
      visible: false,
      userId: '',
      userName: '',
      data: null,
      loading: false,
    });
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
        <div className={styles.userList}>
          {pendingUsers.length === 0 ? (
            <div className={styles.empty}>Нет ожидающих заявок</div>
          ) : (
            pendingUsers.map(user => (
              <div key={user.id} className={styles.userCard}>
                <div className={styles.userInfo}>
                  <div className={styles.userName}>{user.full_name || 'Без имени'}</div>
                  <div className={styles.userEmail}>{user.email}</div>
                  <div className={styles.userMeta}>
                    {user.organization_name && (
                      <span className={styles.twoFaEnabled}>
                        {user.organization_name}
                      </span>
                    )}
                    <span className={styles.userDate}>
                      Заявка от: {new Date(user.created_at).toLocaleDateString('ru-RU')}
                    </span>
                  </div>
                </div>
                <div className={styles.userActions}>
                  <button
                    className={styles.primaryBtn}
                    onClick={() => handleConfirmEmail(user.id)}
                    title="Если пользователь не может войти из-за неподтверждённого email"
                  >
                    Подтвердить email
                  </button>
                  <button
                    className={styles.approveBtn}
                    onClick={() => handleApprove(user.id)}
                  >
                    Одобрить
                  </button>
                  <button
                    className={styles.rejectBtn}
                    onClick={() => handleReject(user.id)}
                  >
                    Отклонить
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'all' && (
        <div className={styles.userListCompact}>
          {allUsers.map(user => {
            const isExpanded = expandedUserId === user.id;
            const isSuperAdmin = user.position_type === 'super_admin';

            return (
              <div key={user.id} className={`${styles.userRow} ${isExpanded ? styles.expanded : ''}`}>
                {/* Основная строка */}
                <div className={styles.userRowHeader} onClick={() => toggleExpand(user.id)}>
                  <div className={styles.userRowInfo}>
                    <div className={styles.userRowName}>
                      {user.full_name || 'Без имени'}
                      {isSuperAdmin && <span className={styles.adminBadge}>Super Admin</span>}
                    </div>
                    <div className={styles.userRowEmail}>{user.email || ''}</div>
                  </div>

                  <div className={styles.userRowMeta}>
                    <span className={styles.userRowRole}>{getPositionName(user.position_type)}</span>
                    <span className={styles.userRowOrg}>{getOrgName(user.organization_id)}</span>
                    {!user.is_approved ? (
                      <span className={styles.notApproved}>Не одобрен</span>
                    ) : !user.two_factor_enabled ? (
                      <span className={styles.twoFaDisabled}>Ожидает 2FA</span>
                    ) : (
                      <span className={styles.approved}>Активен</span>
                    )}
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

                {/* Раскрывающееся меню */}
                {isExpanded && (
                  <div className={styles.userRowControls}>
                    {/* Редактирование ФИО */}
                    <div className={styles.controlGroup}>
                      <label>ФИО:</label>
                      {editingName?.userId === user.id ? (
                        <div className={styles.nameEditGroup}>
                          <input
                            type="text"
                            value={editingName.value}
                            onChange={(e) => setEditingName({ ...editingName, value: e.target.value })}
                            className={styles.nameInput}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleNameSave();
                              if (e.key === 'Escape') handleNameCancel();
                            }}
                          />
                          <button className={styles.saveBtn} onClick={handleNameSave}>Сохранить</button>
                          <button className={styles.cancelBtn} onClick={handleNameCancel}>Отмена</button>
                        </div>
                      ) : (
                        <button
                          className={styles.editNameBtn}
                          onClick={() => handleNameEdit(user.id, user.full_name)}
                        >
                          {user.full_name || 'Без имени'}
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                          </svg>
                        </button>
                      )}
                    </div>

                    {!isSuperAdmin && (
                      <>
                        <div className={styles.controlGroup}>
                          <label>Должность:</label>
                          <select
                            value={user.position_type}
                            onChange={(e) => handlePositionChange(user.id, e.target.value as EmployeePositionType)}
                          >
                            <option value="worker">Сотрудник</option>
                            <option value="header">Руководитель</option>
                            <option value="admin">Администратор</option>
                          </select>
                        </div>

                        <div className={styles.controlGroup}>
                          <label>Организация:</label>
                          <select
                            value={user.organization_id || ''}
                            onChange={(e) => handleOrgChange(user.id, e.target.value)}
                          >
                            <option value="">Не назначена</option>
                            {organizations.map(org => (
                              <option key={org.id} value={org.id}>{org.name}</option>
                            ))}
                          </select>
                        </div>
                      </>
                    )}

                    <div className={styles.controlActions}>
                      {user.two_factor_enabled ? (
                        <button
                          className={styles.dangerBtn}
                          onClick={() => handleDisable2FA(user.id)}
                        >
                          Отключить 2FA
                        </button>
                      ) : (
                        <button
                          className={styles.primaryBtn}
                          onClick={() => handleGenerate2FA(user.id, user.full_name || user.email || '')}
                        >
                          Выдать 2FA
                        </button>
                      )}

                      {!isSuperAdmin && (
                        <button
                          className={styles.rejectBtn}
                          onClick={() => handleDeleteUser(user.id)}
                        >
                          Удалить
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 2FA Modal */}
      {twoFactorModal.visible && (
        <div className={styles.modalOverlay} onClick={closeTwoFactorModal}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>2FA для {twoFactorModal.userName}</h2>
              <button className={styles.closeBtn} onClick={closeTwoFactorModal}>&times;</button>
            </div>

            {twoFactorModal.loading ? (
              <div className={styles.modalLoading}>Генерация...</div>
            ) : twoFactorModal.data && (
              <div className={styles.modalContent}>
                <div className={styles.qrSection}>
                  <p>Отсканируйте QR-код в приложении-аутентификаторе:</p>
                  <img src={twoFactorModal.data.qrCode} alt="QR Code" />
                </div>

                <div className={styles.secretSection}>
                  <p>Или введите ключ вручную:</p>
                  <code>{twoFactorModal.data.secret}</code>
                </div>

                <div className={styles.recoverySection}>
                  <p>Коды восстановления (сохраните в надёжном месте):</p>
                  <div className={styles.recoveryCodes}>
                    {twoFactorModal.data.recoveryCodes.map((code, index) => (
                      <code key={index}>{code}</code>
                    ))}
                  </div>
                </div>

                <div className={styles.warning}>
                  Передайте эти данные пользователю безопасным способом (лично или через защищённый канал).
                  Коды восстановления показываются только один раз!
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
