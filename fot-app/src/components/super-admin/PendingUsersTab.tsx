import { useState } from 'react';
import type { FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import type { EmployeePositionType } from '../../types';
import styles from '../../pages/super-admin/SuperAdmin.module.css';

export interface IPendingUser {
  id: string;
  email: string;
  email_confirmed?: boolean;
  full_name: string | null;
  position_type: EmployeePositionType;
  imported_position: string | null;
  created_at: string;
}

interface IApprovalModal {
  visible: boolean;
  userId: string;
  userName: string;
  positionType: EmployeePositionType | '';
  employeeId: number | null;
  employeeSearch: string;
  employeeResults: { id: number; full_name: string; org_department_id: string | null }[];
  searchLoading: boolean;
}

interface IPendingUsersTabProps {
  pendingUsers: IPendingUser[];
  onReload: () => Promise<void>;
  patchPendingCache: (updater: (prev: IPendingUser[]) => IPendingUser[]) => void;
}

export const PendingUsersTab: FC<IPendingUsersTabProps> = ({ pendingUsers, onReload, patchPendingCache }) => {
  const toast = useToast();
  const { roles } = useAuth();
  const queryClient = useQueryClient();
  const [approvalModal, setApprovalModal] = useState<IApprovalModal | null>(null);

  // Отменяем in-flight рефечи перед мутацией, иначе ответ старого запроса
  // (запущенного на mount/refocus) может прийти после setQueryData и перезатереть
  // оптимистичный кэш — карточка одобренного пользователя «висит» до F5.
  const cancelUserListQueries = async () => {
    await Promise.all([
      queryClient.cancelQueries({ queryKey: ['admin-users', 'pending'] }),
      queryClient.cancelQueries({ queryKey: ['admin-users', 'all'] }),
    ]);
  };

  // /roles/labels уже отдаёт только активные роли — дополнительный фильтр не нужен.
  const availableRoles = [...roles]
    .sort((a, b) => Number(b.is_admin) - Number(a.is_admin) || a.name.localeCompare(b.name, 'ru'));

  const openApprovalModal = (user: IPendingUser) => {
    setApprovalModal({
      visible: true,
      userId: user.id,
      userName: user.full_name || user.email || '',
      positionType: '',
      employeeId: null,
      employeeSearch: '',
      employeeResults: [],
      searchLoading: false,
    });
  };

  const handleEmployeeSearch = async (query: string) => {
    if (!approvalModal) return;
    setApprovalModal(prev => prev ? { ...prev, employeeSearch: query, searchLoading: true } : null);

    if (query.length < 2) {
      setApprovalModal(prev => prev ? { ...prev, employeeResults: [], searchLoading: false } : null);
      return;
    }

    try {
      const results = await adminService.searchUnlinkedEmployees(query);
      setApprovalModal(prev => prev ? { ...prev, employeeResults: results, searchLoading: false } : null);
    } catch {
      setApprovalModal(prev => prev ? { ...prev, searchLoading: false } : null);
    }
  };

  const handleApproveConfirm = async () => {
    if (!approvalModal) return;
    if (!approvalModal.positionType) {
      toast.error('Выберите роль перед одобрением');
      return;
    }

    try {
      const userId = approvalModal.userId;
      await cancelUserListQueries();
      await adminService.approveUser(userId, {
        position_type: approvalModal.positionType,
        employee_id: approvalModal.employeeId || undefined,
      });
      toast.success('Пользователь одобрен. Теперь выдайте ему 2FA.');
      setApprovalModal(null);
      patchPendingCache((prev) => prev.filter((u) => u.id !== userId));
      await onReload();
    } catch {
      toast.error('Ошибка одобрения пользователя');
    }
  };

  const handleReject = async (userId: string) => {
    if (!confirm('Отклонить заявку пользователя?')) return;

    try {
      await cancelUserListQueries();
      await adminService.rejectUser(userId);
      toast.success('Заявка отклонена');
      patchPendingCache((prev) => prev.filter((u) => u.id !== userId));
      await onReload();
    } catch {
      toast.error('Ошибка отклонения пользователя');
    }
  };

  const handleConfirmEmail = async (userId: string) => {
    try {
      await cancelUserListQueries();
      await adminService.confirmUserEmail(userId);
      toast.success('Email подтверждён');
      patchPendingCache((prev) => prev.map((u) => u.id === userId ? { ...u, email_confirmed: true } : u));
      await onReload();
    } catch {
      toast.error('Ошибка подтверждения email');
    }
  };

  return (
    <>
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
                  <span className={styles.userDate}>
                    Заявка от: {new Date(user.created_at).toLocaleDateString('ru-RU')}
                  </span>
                </div>
              </div>
              <div className={styles.userActions}>
                {!user.email_confirmed && (
                  <button
                    className={styles.primaryBtn}
                    onClick={() => handleConfirmEmail(user.id)}
                    title="Если пользователь не может войти из-за неподтверждённого email"
                  >
                    Подтвердить email
                  </button>
                )}
                <button
                  className={styles.approveBtn}
                  onClick={() => openApprovalModal(user)}
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

      {/* Approval Modal */}
      {approvalModal?.visible && (
        <div className={styles.modalOverlay} onClick={() => setApprovalModal(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h2>Одобрение: {approvalModal.userName}</h2>
              <button className={styles.closeBtn} onClick={() => setApprovalModal(null)}>&times;</button>
            </div>
            <div className={styles.modalContent}>
              <div className={styles.controlGroup}>
                <label>Должность:</label>
                <select
                  value={approvalModal.positionType}
                  onChange={(e) => setApprovalModal(prev => prev ? { ...prev, positionType: e.target.value as EmployeePositionType } : null)}
                >
                  <option value="">Выберите роль</option>
                  {availableRoles.map(role => (
                    <option key={role.code} value={role.code}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.controlGroup}>
                <label>Привязка к сотруднику (СКУД):</label>
                <input
                  type="text"
                  placeholder="Поиск по ФИО..."
                  value={approvalModal.employeeSearch}
                  onChange={(e) => handleEmployeeSearch(e.target.value)}
                  className={styles.nameInput}
                />
                {approvalModal.employeeId && (
                  <div className={styles.empSelected}>
                    Выбран: ID {approvalModal.employeeId}
                    <button
                      className={styles.empSelectedUnlink}
                      onClick={() => setApprovalModal(prev => prev ? { ...prev, employeeId: null } : null)}
                    >
                      Отвязать
                    </button>
                  </div>
                )}
                {approvalModal.employeeResults.length > 0 && (
                  <div className={styles.empSearchResults}>
                    {approvalModal.employeeResults.map(emp => (
                      <div
                        key={emp.id}
                        className={`${styles.empSearchItem} ${approvalModal.employeeId === emp.id ? styles.empSearchItemActive : ''}`}
                        onClick={() => setApprovalModal(prev => prev ? { ...prev, employeeId: emp.id, employeeSearch: emp.full_name, employeeResults: [] } : null)}
                      >
                        {emp.full_name}
                      </div>
                    ))}
                  </div>
                )}
                {approvalModal.searchLoading && <div className={styles.empSearchLoading}>Поиск...</div>}
              </div>

              <div className={styles.controlActions}>
                <button
                  className={styles.approveBtn}
                  onClick={handleApproveConfirm}
                  disabled={!approvalModal.positionType}
                >
                  Одобрить
                </button>
                <button className={styles.cancelBtn} onClick={() => setApprovalModal(null)}>
                  Отмена
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
