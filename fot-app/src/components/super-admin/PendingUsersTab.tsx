import { useState } from 'react';
import type { FC } from 'react';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
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
  positionType: EmployeePositionType;
  employeeId: number | null;
  employeeSearch: string;
  employeeResults: { id: number; full_name: string; org_department_id: string | null }[];
  searchLoading: boolean;
}

interface IPendingUsersTabProps {
  pendingUsers: IPendingUser[];
  onReload: () => Promise<void>;
}

export const PendingUsersTab: FC<IPendingUsersTabProps> = ({ pendingUsers, onReload }) => {
  const toast = useToast();
  const [approvalModal, setApprovalModal] = useState<IApprovalModal | null>(null);

  const openApprovalModal = (user: IPendingUser) => {
    setApprovalModal({
      visible: true,
      userId: user.id,
      userName: user.full_name || user.email || '',
      positionType: user.position_type || 'worker',
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

    try {
      await adminService.approveUser(approvalModal.userId, {
        position_type: approvalModal.positionType,
        employee_id: approvalModal.employeeId || undefined,
      });
      toast.success('Пользователь одобрен. Теперь выдайте ему 2FA.');
      setApprovalModal(null);
      await onReload();
    } catch {
      toast.error('Ошибка одобрения пользователя');
    }
  };

  const handleReject = async (userId: string) => {
    if (!confirm('Отклонить заявку пользователя?')) return;

    try {
      await adminService.rejectUser(userId);
      toast.success('Заявка отклонена');
      await onReload();
    } catch {
      toast.error('Ошибка отклонения пользователя');
    }
  };

  const handleConfirmEmail = async (userId: string) => {
    try {
      await adminService.confirmUserEmail(userId);
      toast.success('Email подтверждён');
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
                  <option value="worker">Сотрудник</option>
                  <option value="header">Руководитель</option>
                  <option value="admin">Администратор</option>
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
                  <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-success, #22c55e)' }}>
                    Выбран: ID {approvalModal.employeeId}
                    <button
                      style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--color-danger, #ef4444)', cursor: 'pointer', fontSize: 13 }}
                      onClick={() => setApprovalModal(prev => prev ? { ...prev, employeeId: null } : null)}
                    >
                      Отвязать
                    </button>
                  </div>
                )}
                {approvalModal.employeeResults.length > 0 && (
                  <div style={{ border: '1px solid var(--border-color, #333)', borderRadius: 6, maxHeight: 160, overflowY: 'auto', marginTop: 4 }}>
                    {approvalModal.employeeResults.map(emp => (
                      <div
                        key={emp.id}
                        style={{
                          padding: '6px 10px',
                          cursor: 'pointer',
                          fontSize: 13,
                          background: approvalModal.employeeId === emp.id ? 'var(--color-primary-bg, #1e3a5f)' : 'transparent',
                        }}
                        onClick={() => setApprovalModal(prev => prev ? { ...prev, employeeId: emp.id, employeeSearch: emp.full_name, employeeResults: [] } : null)}
                      >
                        {emp.full_name}
                      </div>
                    ))}
                  </div>
                )}
                {approvalModal.searchLoading && <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Поиск...</div>}
              </div>

              <div className={styles.controlActions} style={{ marginTop: 16 }}>
                <button className={styles.approveBtn} onClick={handleApproveConfirm}>
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
