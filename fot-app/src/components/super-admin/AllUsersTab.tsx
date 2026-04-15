import { useState, useMemo } from 'react';
import type { FC } from 'react';
import { adminService } from '../../services/adminService';
import { useStructureTree } from '../../hooks/useStructure';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import type { ChatInboundMode, EmployeePositionType, TwoFactorData } from '../../types';
import { getSortedFlatDepartments } from '../../utils/departmentUtils';
import styles from '../../pages/super-admin/SuperAdmin.module.css';

export interface IUserFromApi {
  id: string;
  email?: string;
  email_confirmed?: boolean;
  full_name: string | null;
  department_id: string | null;
  department_name: string | null;
  position_type: EmployeePositionType;
  imported_position: string | null;
  employee_id: string | null;
  supervisor_id: string | null;
  chat_inbound_mode: ChatInboundMode;
  is_approved: boolean;
  two_factor_enabled: boolean;
  approved_at: string | null;
  created_at: string;
}

interface IEmpSearch {
  userId: string;
  query: string;
  results: { id: number; full_name: string; org_department_id: string | null }[];
  loading: boolean;
}

interface ITwoFactorModal {
  visible: boolean;
  userId: string;
  userName: string;
  data: TwoFactorData | null;
  loading: boolean;
}

interface IAllUsersTabProps {
  allUsers: IUserFromApi[];
  onReload: () => Promise<void>;
}

export const AllUsersTab: FC<IAllUsersTabProps> = ({ allUsers, onReload }) => {
  const toast = useToast();
  const { roles, getRoleLabel } = useAuth();
  const structureQuery = useStructureTree();
  const [roleFilter, setRoleFilter] = useState<EmployeePositionType | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<{ userId: string; value: string } | null>(null);
  const [empSearch, setEmpSearch] = useState<IEmpSearch | null>(null);
  const [twoFactorModal, setTwoFactorModal] = useState<ITwoFactorModal>({
    visible: false,
    userId: '',
    userName: '',
    data: null,
    loading: false,
  });
  const flatDepts = useMemo(
    () => getSortedFlatDepartments(structureQuery.data?.departments || []),
    [structureQuery.data?.departments],
  );

  const roleOptions = useMemo(() => {
    const codeSet = new Set<string>([
      ...roles.map(role => role.code),
      ...allUsers.map(user => user.position_type).filter(Boolean),
    ]);

    return Array.from(codeSet)
      .map(code => ({
        code,
        role: roles.find(role => role.code === code) ?? null,
        count: allUsers.filter(user => user.position_type === code).length,
      }))
      .sort((a, b) => {
        const levelDiff = (a.role?.level ?? Number.MAX_SAFE_INTEGER) - (b.role?.level ?? Number.MAX_SAFE_INTEGER);
        if (levelDiff !== 0) return levelDiff;
        return getRoleLabel(a.code).localeCompare(getRoleLabel(b.code), 'ru');
      });
  }, [allUsers, getRoleLabel, roles]);

  const effectiveRoleFilter = useMemo(() => {
    if (!roleOptions.length) return null;
    if (roleFilter && roleOptions.some(option => option.code === roleFilter)) {
      return roleFilter;
    }
    return roleOptions[0].code;
  }, [roleFilter, roleOptions]);

  const toggleExpand = (userId: string) => {
    setExpandedUserId(prev => prev === userId ? null : userId);
    setEditingName(null);
    setEmpSearch(null);
  };

  const getDeptName = (user: IUserFromApi) => {
    return user.department_name || 'Не назначен';
  };

  const getPositionName = (positionType: EmployeePositionType) => {
    return getRoleLabel(positionType);
  };

  const handleEmpSearchQuery = async (userId: string, query: string) => {
    if (query.length < 2) {
      setEmpSearch({ userId, query, loading: false, results: [] });
      return;
    }
    setEmpSearch({ userId, query, loading: true, results: [] });
    try {
      const results = await adminService.searchUnlinkedEmployees(query);
      setEmpSearch({ userId, query, loading: false, results });
    } catch (err) {
      console.error('Employee search error:', err);
      setEmpSearch({ userId, query, loading: false, results: [] });
    }
  };

  const handleEmpLink = async (userId: string, employeeId: number | null, empName?: string) => {
    try {
      await adminService.updateUserEmployee(userId, employeeId);
      toast.success(employeeId ? `Привязан: ${empName}` : 'Сотрудник отвязан');
      setEmpSearch(null);
      await onReload();
    } catch {
      toast.error('Ошибка привязки сотрудника');
    }
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
      await onReload();
    } catch {
      toast.error('Ошибка обновления ФИО');
    }
  };

  const handleNameCancel = () => {
    setEditingName(null);
  };

  const handlePositionChange = async (userId: string, positionType: EmployeePositionType) => {
    try {
      await adminService.updateUserPosition(userId, positionType);
      toast.success('Должность изменена');
      await onReload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка изменения должности');
    }
  };

  const handleChatInboundModeChange = async (userId: string, chatInboundMode: ChatInboundMode) => {
    try {
      await adminService.updateUserChatInboundMode(userId, chatInboundMode);
      toast.success('Режим входящих сообщений обновлён');
      await onReload();
    } catch {
      toast.error('Ошибка обновления режима входящих сообщений');
    }
  };

  const handleDeptChange = async (userId: string, deptId: string) => {
    try {
      await adminService.updateEmployeeDepartment(userId, deptId);
      toast.success('Отдел назначен');
      await onReload();
    } catch {
      toast.error('Ошибка назначения отдела');
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!confirm('Удалить пользователя из системы? Это действие необратимо.')) return;
    try {
      await adminService.deleteUser(userId);
      toast.success('Пользователь удалён');
      await onReload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка удаления пользователя');
    }
  };

  const handleGenerate2FA = async (userId: string, userName: string) => {
    setTwoFactorModal({ visible: true, userId, userName, data: null, loading: true });
    try {
      const data = await adminService.generate2FA(userId);
      setTwoFactorModal(prev => ({ ...prev, data, loading: false }));
      toast.success('2FA успешно сгенерирован');
      await onReload();
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
      await onReload();
    } catch {
      toast.error('Ошибка отключения 2FA');
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

  const closeTwoFactorModal = () => {
    setTwoFactorModal({ visible: false, userId: '', userName: '', data: null, loading: false });
  };

  const filteredUsers = allUsers.filter(u => {
    if (!effectiveRoleFilter) return true;
    return u.position_type === effectiveRoleFilter;
  });

  return (
    <>
      <div className={styles.roleTabs}>
        {roleOptions.map(option => (
          <button
            key={option.code}
            className={`${styles.roleTab} ${effectiveRoleFilter === option.code ? styles.roleTabActive : ''}`}
            onClick={() => setRoleFilter(option.code)}
          >
            {getPositionName(option.code)}
            {!option.role?.is_active ? ' (неакт.)' : ''} ({option.count})
          </button>
        ))}
      </div>

      <div className={styles.userListCompact}>
        <div className={styles.userListTableHeader}>
          <span>ФИО</span>
          <span>Роль</span>
          <span>Отдел</span>
          <span>Статус</span>
          <span></span>
        </div>

        {filteredUsers.map(user => {
          const isExpanded = expandedUserId === user.id;
          const assignableRoles = roles
            .filter(role => role.is_active || role.code === user.position_type);

          if (!assignableRoles.some(role => role.code === user.position_type)) {
            assignableRoles.push({
              id: `missing-${user.position_type}`,
              code: user.position_type,
              name: getRoleLabel(user.position_type),
              description: null,
              permissions: [],
              level: Number.MAX_SAFE_INTEGER,
              is_active: false,
              is_system: false,
              created_at: '',
              updated_at: '',
            });
          }

          return (
            <div key={user.id} className={`${styles.userRow} ${isExpanded ? styles.expanded : ''}`}>
              {/* Основная строка */}
              <div className={styles.userRowHeader} onClick={() => toggleExpand(user.id)}>
                <div className={styles.userRowInfo}>
                  <div className={styles.userRowName}>
                    {user.full_name || 'Без имени'}
                  </div>
                  <div className={styles.userRowEmail}>
                    {user.email || ''}
                    {user.email_confirmed
                      ? <span className={styles.emailConfirmed}>✓ подтверждён</span>
                      : <span className={styles.emailNotConfirmed}>✗ не подтверждён</span>
                    }
                  </div>
                </div>

                <div className={styles.userRowMeta}>
                  <span className={styles.userRowRole}>{getPositionName(user.position_type)}</span>
                  <span className={styles.userRowOrg}>{getDeptName(user)}</span>
                  <div className={styles.userRowStatusCell}>
                    <span className={
                      !user.is_approved ? styles.notApproved
                      : !user.email_confirmed ? styles.notApproved
                      : !user.two_factor_enabled ? styles.twoFaDisabled
                      : styles.approved
                    }>
                      {!user.is_approved ? 'Не одобрен' : !user.email_confirmed ? 'Email не подтверждён' : !user.two_factor_enabled ? 'Ожидает 2FA' : 'Активен'}
                    </span>
                  </div>
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

                  <>
                    <div className={styles.controlGroup}>
                      <label>Должность:</label>
                      <select
                        value={user.position_type}
                        onChange={(e) => handlePositionChange(user.id, e.target.value as EmployeePositionType)}
                      >
                        {assignableRoles
                          .sort((a, b) => a.level - b.level)
                          .map(role => (
                            <option key={role.code} value={role.code}>{role.name}</option>
                          ))
                        }
                      </select>
                    </div>

                    <div className={styles.controlGroup}>
                      <label>Входящий чат:</label>
                      <select
                        value={user.chat_inbound_mode || 'open'}
                        onChange={(e) => handleChatInboundModeChange(user.id, e.target.value as ChatInboundMode)}
                      >
                        <option value="open">Открыт</option>
                        <option value="requests_only">Только по запросу</option>
                        <option value="disabled">Запрещён</option>
                      </select>
                    </div>

                    <div className={styles.controlGroup}>
                      <label>Отдел:</label>
                      <select
                        value={user.department_id || ''}
                        onChange={(e) => handleDeptChange(user.id, e.target.value)}
                        disabled={!user.employee_id}
                      >
                        <option value="">
                          {user.employee_id ? 'Выберите отдел' : 'Сначала привяжите СКУД'}
                        </option>
                        {flatDepts.map(d => (
                          <option key={d.id} value={d.id}>
                            {'\u00A0\u00A0'.repeat(d.level)}{d.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className={styles.controlGroup}>
                      <label>Сотрудник СКУД:</label>
                      {user.employee_id ? (
                        <div className={styles.skudLinked}>
                          <span className={styles.skudLinkedText}>
                            ID {user.employee_id}
                          </span>
                          <button
                            className={styles.skudUnlinkBtn}
                            onClick={() => handleEmpLink(user.id, null)}
                          >
                            Отвязать
                          </button>
                        </div>
                      ) : (
                        <span className={styles.skudNotLinked}>Не привязан</span>
                      )}
                      <input
                        type="text"
                        placeholder="Поиск по ФИО..."
                        value={empSearch?.userId === user.id ? empSearch.query : ''}
                        onChange={(e) => handleEmpSearchQuery(user.id, e.target.value)}
                        className={`${styles.nameInput} ${styles.skudSearchInput}`}
                      />
                      {empSearch?.userId === user.id && empSearch.loading && (
                        <div className={styles.skudSearchLoading}>Поиск...</div>
                      )}
                      {empSearch?.userId === user.id && empSearch.results.length > 0 && (
                        <div className={styles.skudSearchResults}>
                          {empSearch.results.map(emp => (
                            <div
                              key={emp.id}
                              className={styles.skudSearchItem}
                              onClick={() => handleEmpLink(user.id, emp.id, emp.full_name)}
                            >
                              {emp.full_name}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>

                  <div className={styles.controlActions}>
                    {!user.email_confirmed && (
                      <button
                        className={styles.primaryBtn}
                        onClick={() => handleConfirmEmail(user.id)}
                      >
                        Подтвердить email
                      </button>
                    )}

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

                    <button
                      className={styles.rejectBtn}
                      onClick={() => handleDeleteUser(user.id)}
                    >
                      Удалить
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

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
    </>
  );
};
