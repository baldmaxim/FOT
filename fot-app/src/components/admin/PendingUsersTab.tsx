import { useEffect, useRef, useState } from 'react';
import type { FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import type { EmployeePositionType } from '../../types';
import styles from '../../pages/admin/Admin.module.css';

// Сервер отдаёт причину отказа в ApiError.message (напр. «Подтверждение
// доступно только системному администратору»). Без этого провал одобрения
// выглядел как успех — общий тост скрывал реальную ошибку.
const errMsg = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

export interface IPendingUser {
  id: string;
  email: string;
  email_confirmed?: boolean;
  full_name: string | null;
  position_type: EmployeePositionType;
  imported_position: string | null;
  created_at: string;
}

interface IApprovalDraft {
  positionType: EmployeePositionType | '';
  employeeId: number | null;
  employeeSearch: string;
  employeeResults: { id: number; full_name: string; org_department_id: string | null }[];
  searchLoading: boolean;
}

interface IPendingUsersTabProps {
  pendingUsers: IPendingUser[];
  loading?: boolean;
  onReload: () => Promise<void>;
  patchPendingCache: (updater: (prev: IPendingUser[]) => IPendingUser[]) => void;
}

const EMPTY_DRAFT: IApprovalDraft = {
  positionType: '',
  employeeId: null,
  employeeSearch: '',
  employeeResults: [],
  searchLoading: false,
};

export const PendingUsersTab: FC<IPendingUsersTabProps> = ({ pendingUsers, loading = false, onReload, patchPendingCache }) => {
  const toast = useToast();
  const { roles } = useAuth();
  const queryClient = useQueryClient();
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [draft, setDraft] = useState<IApprovalDraft>(EMPTY_DRAFT);
  // Локальный набор «только что подтверждённых email» — кнопка прячется сразу
  // и не возвращается, даже если рефетч пришёл со stale значением.
  const [recentlyConfirmed, setRecentlyConfirmed] = useState<Set<string>>(new Set());
  const searchSeqRef = useRef(0);

  // Отменяем in-flight рефечи перед мутацией — иначе ответ старого запроса
  // (запущенного на mount/refocus) приходит после setQueryData и затирает
  // оптимистичный кэш.
  const cancelUserListQueries = async () => {
    await Promise.all([
      queryClient.cancelQueries({ queryKey: ['admin-users', 'pending'] }),
      queryClient.cancelQueries({ queryKey: ['admin-users', 'page'] }),
      queryClient.cancelQueries({ queryKey: ['admin-users', 'count'] }),
    ]);
  };

  // /roles/labels уже отдаёт только активные роли — дополнительный фильтр не нужен.
  const availableRoles = [...roles]
    .sort((a, b) => Number(b.is_admin) - Number(a.is_admin) || a.name.localeCompare(b.name, 'ru'));

  // Debounce поиска сотрудника (250 мс) + защита от устаревших ответов.
  useEffect(() => {
    if (draft.employeeSearch.length < 2) {
      setDraft(prev => ({ ...prev, employeeResults: [], searchLoading: false }));
      return;
    }
    setDraft(prev => ({ ...prev, searchLoading: true }));
    const seq = ++searchSeqRef.current;
    const timer = setTimeout(async () => {
      try {
        const results = await adminService.searchUnlinkedEmployees(draft.employeeSearch);
        if (seq === searchSeqRef.current) {
          setDraft(prev => ({ ...prev, employeeResults: results, searchLoading: false }));
        }
      } catch {
        if (seq === searchSeqRef.current) {
          setDraft(prev => ({ ...prev, employeeResults: [], searchLoading: false }));
        }
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [draft.employeeSearch]);

  const startApproval = (user: IPendingUser) => {
    setExpandedUserId(user.id);
    setDraft({ ...EMPTY_DRAFT });
  };

  const cancelApproval = () => {
    setExpandedUserId(null);
    setDraft({ ...EMPTY_DRAFT });
  };

  const handleApproveConfirm = async () => {
    if (!expandedUserId) return;
    if (!draft.positionType) {
      toast.error('Выберите роль перед одобрением');
      return;
    }

    try {
      const userId = expandedUserId;
      await cancelUserListQueries();
      await adminService.approveUser(userId, {
        position_type: draft.positionType,
        employee_id: draft.employeeId || undefined,
      });
      toast.success('Пользователь одобрен. Теперь выдайте ему 2FA.');
      patchPendingCache((prev) => prev.filter((u) => u.id !== userId));
      cancelApproval();
      await onReload();
    } catch (e) {
      toast.error(errMsg(e, 'Ошибка одобрения пользователя'));
    }
  };

  const handleReject = async (userId: string) => {
    if (!confirm('Отклонить заявку пользователя?')) return;

    try {
      await cancelUserListQueries();
      await adminService.rejectUser(userId);
      toast.success('Заявка отклонена');
      patchPendingCache((prev) => prev.filter((u) => u.id !== userId));
      if (expandedUserId === userId) cancelApproval();
      await onReload();
    } catch (e) {
      toast.error(errMsg(e, 'Ошибка отклонения пользователя'));
    }
  };

  const handleConfirmEmail = async (userId: string) => {
    // Оптимистично прячем кнопку до ответа сервера.
    setRecentlyConfirmed(prev => {
      const next = new Set(prev);
      next.add(userId);
      return next;
    });
    try {
      await cancelUserListQueries();
      await adminService.confirmUserEmail(userId);
      toast.success('Email подтверждён');
      patchPendingCache((prev) => prev.map((u) => u.id === userId ? { ...u, email_confirmed: true } : u));
      await onReload();
    } catch (e) {
      // На ошибку — возвращаем кнопку.
      setRecentlyConfirmed(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
      toast.error(errMsg(e, 'Ошибка подтверждения email'));
    }
  };

  if (loading && pendingUsers.length === 0) {
    return <div className={styles.pendingEmpty}>Загрузка...</div>;
  }
  if (pendingUsers.length === 0) {
    return <div className={styles.pendingEmpty}>Нет ожидающих заявок</div>;
  }

  return (
    <div className={styles.pendingList}>
      {pendingUsers.map(user => {
        const isExpanded = expandedUserId === user.id;
        const emailHidden = user.email_confirmed || recentlyConfirmed.has(user.id);
        return (
          <div key={user.id} className={styles.pendingRow}>
            <div className={styles.pendingRowHeader}>
              <div className={styles.pendingRowInfo}>
                <div className={styles.pendingRowName}>{user.full_name || 'Без имени'}</div>
                <div className={styles.pendingRowEmail}>{user.email}</div>
              </div>
              <div className={styles.pendingRowDate}>
                {new Date(user.created_at).toLocaleDateString('ru-RU')}
              </div>
              <div className={styles.pendingRowActions}>
                {!emailHidden && (
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
                  onClick={() => isExpanded ? cancelApproval() : startApproval(user)}
                >
                  {isExpanded ? 'Свернуть' : 'Одобрить'}
                </button>
                <button
                  className={styles.rejectBtn}
                  onClick={() => handleReject(user.id)}
                >
                  Отклонить
                </button>
              </div>
            </div>

            {isExpanded && (
              <div className={styles.pendingInline}>
                <div className={styles.pendingInlineRow}>
                  <label className={styles.pendingInlineLabel}>Должность:</label>
                  <select
                    value={draft.positionType}
                    onChange={(e) => setDraft(prev => ({ ...prev, positionType: e.target.value as EmployeePositionType }))}
                  >
                    <option value="">Выберите роль</option>
                    {availableRoles.map(role => (
                      <option key={role.code} value={role.code}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className={styles.pendingInlineRow}>
                  <label className={styles.pendingInlineLabel}>Сотрудник СКУД:</label>
                  <div className={styles.pendingInlineSearchWrap}>
                    {draft.employeeId ? (
                      <div className={styles.pendingInlineSelected}>
                        Выбран: {draft.employeeSearch || `ID ${draft.employeeId}`}
                        <button
                          className={styles.empSelectedUnlink}
                          onClick={() => setDraft(prev => ({ ...prev, employeeId: null, employeeSearch: '', employeeResults: [] }))}
                        >
                          Отвязать
                        </button>
                      </div>
                    ) : (
                      <>
                        <input
                          type="text"
                          placeholder="Поиск по ФИО..."
                          value={draft.employeeSearch}
                          onChange={(e) => setDraft(prev => ({ ...prev, employeeSearch: e.target.value }))}
                          className={styles.nameInput}
                        />
                        {draft.searchLoading && (
                          <div className={styles.skudSearchLoading} style={{ marginTop: 4 }}>Поиск...</div>
                        )}
                        {draft.employeeResults.length > 0 && (
                          <div className={styles.skudSearchResults}>
                            {draft.employeeResults.map(emp => (
                              <div
                                key={emp.id}
                                className={styles.skudSearchItem}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => setDraft(prev => ({
                                  ...prev,
                                  employeeId: emp.id,
                                  employeeSearch: emp.full_name,
                                  employeeResults: [],
                                }))}
                              >
                                {emp.full_name}
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className={styles.controlActions}>
                  <button
                    className={styles.approveBtn}
                    onClick={handleApproveConfirm}
                    disabled={!draft.positionType}
                  >
                    Подтвердить одобрение
                  </button>
                  <button className={styles.cancelBtn} onClick={cancelApproval}>
                    Отмена
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
