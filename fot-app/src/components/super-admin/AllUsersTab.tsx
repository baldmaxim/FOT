import { useState, useMemo } from 'react';
import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import { rolesService } from '../../services/rolesService';
import { useStructureTree } from '../../hooks/useStructure';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import type { ChatInboundMode, EmployeePositionType, TwoFactorData } from '../../types';
import { getTreeFlatDepartments } from '../../utils/departmentUtils';
import { SearchInput } from '../ui/SearchInput';
import styles from '../../pages/super-admin/SuperAdmin.module.css';

export interface IUserFromApi {
  id: string;
  email?: string;
  email_confirmed?: boolean;
  full_name: string | null;
  assigned_department_ids: string[];
  position_type: EmployeePositionType;
  imported_position: string | null;
  employee_id: number | null;
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

const normalizeAssignedDepartmentIds = (departmentIds: string[]): string[] => (
  [...new Set(departmentIds.filter(Boolean))]
);

const areDepartmentSelectionsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
};

export const AllUsersTab: FC<IAllUsersTabProps> = ({ allUsers, onReload }) => {
  const toast = useToast();
  const { getRoleLabel, profile, refreshProfile } = useAuth();
  // Полный список ролей нужен админу для approval-формы (employee_variant,
  // is_active и т.п.). Endpoint /roles защищён requireAnyPageAccess(/admin/users,
  // /admin/roles), поэтому страница его получит.
  const rolesQuery = useQuery({
    queryKey: ['admin-roles-full'],
    queryFn: () => rolesService.getAll(),
  });
  const roles = rolesQuery.data ?? [];
  const structureQuery = useStructureTree();
  const [roleFilter, setRoleFilter] = useState<EmployeePositionType | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<{ userId: string; value: string } | null>(null);
  const [empSearch, setEmpSearch] = useState<IEmpSearch | null>(null);
  const [departmentAccessDrafts, setDepartmentAccessDrafts] = useState<Record<string, string[]>>({});
  const [departmentAccessQuery, setDepartmentAccessQuery] = useState<Record<string, string>>({});
  const [savingDepartmentAccessUserId, setSavingDepartmentAccessUserId] = useState<string | null>(null);
  const [twoFactorModal, setTwoFactorModal] = useState<ITwoFactorModal>({
    visible: false,
    userId: '',
    userName: '',
    data: null,
    loading: false,
  });
  const flatDepts = useMemo(
    () => getTreeFlatDepartments(structureQuery.data?.departments || []),
    [structureQuery.data?.departments],
  );
  const departmentMap = useMemo(
    () => new Map(flatDepts.map(department => [department.id, department])),
    [flatDepts],
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
        const adminDiff = Number(b.role?.is_admin ?? 0) - Number(a.role?.is_admin ?? 0);
        if (adminDiff !== 0) return adminDiff;
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

  const getPositionName = (positionType: EmployeePositionType) => {
    return getRoleLabel(positionType);
  };

  const renderAssignedDepartments = (user: IUserFromApi) => {
    const ids = user.assigned_department_ids ?? [];
    if (ids.length === 0) return '—';
    const names = ids.map(id => departmentMap.get(id)?.name || '—');
    if (names.length === 1) return names[0];
    return `${names[0]} +${names.length - 1}`;
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
      if (profile?.id === userId) {
        await refreshProfile();
      }
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

  const getAssignedDepartmentIds = (user: IUserFromApi): string[] => (
    normalizeAssignedDepartmentIds(
      departmentAccessDrafts[user.id] ?? user.assigned_department_ids ?? [],
    )
  );

  const handleDepartmentAccessToggle = (user: IUserFromApi, departmentId: string) => {
    const currentDepartmentIds = getAssignedDepartmentIds(user);
    const nextDepartmentIds = currentDepartmentIds.includes(departmentId)
      ? currentDepartmentIds.filter(id => id !== departmentId)
      : [...currentDepartmentIds, departmentId];

    setDepartmentAccessDrafts(prev => ({
      ...prev,
      [user.id]: normalizeAssignedDepartmentIds(nextDepartmentIds),
    }));
  };

  const handleDepartmentAccessReset = (user: IUserFromApi) => {
    setDepartmentAccessDrafts(prev => ({
      ...prev,
      [user.id]: normalizeAssignedDepartmentIds(user.assigned_department_ids ?? []),
    }));
    setDepartmentAccessQuery(prev => ({
      ...prev,
      [user.id]: '',
    }));
  };

  const handleDepartmentAccessSave = async (user: IUserFromApi) => {
    const assignedDepartmentIds = getAssignedDepartmentIds(user);
    setSavingDepartmentAccessUserId(user.id);
    try {
      const response = await adminService.updateUserDepartmentAccess(user.id, assignedDepartmentIds);
      setDepartmentAccessDrafts(prev => ({
        ...prev,
        [user.id]: normalizeAssignedDepartmentIds(response.assigned_department_ids),
      }));
      toast.success('Назначения сохранены');
      await onReload();
      if (profile?.id === user.id) {
        await refreshProfile();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения назначений');
    } finally {
      setSavingDepartmentAccessUserId(null);
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

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allUsers.filter(u => {
      if (effectiveRoleFilter && u.position_type !== effectiveRoleFilter) return false;
      if (!q) return true;
      return (
        (u.full_name || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q)
      );
    });
  }, [allUsers, effectiveRoleFilter, searchQuery]);

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

      <div className={styles.userSearchRow}>
        <SearchInput
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder="Найти пользователя по ФИО или email..."
        />
      </div>

      <div className={styles.userListCompact}>
        <div className={styles.userListTableHeader}>
          <span>ФИО</span>
          <span>Роль</span>
          <span>Отделы</span>
          <span>Статус</span>
          <span></span>
        </div>

        {filteredUsers.map(user => {
          const isExpanded = expandedUserId === user.id;
          const assignedDepartmentIds = getAssignedDepartmentIds(user);
          const initialDepartmentIds = normalizeAssignedDepartmentIds(user.assigned_department_ids ?? []);
          const hasDepartmentAccessChanges = !areDepartmentSelectionsEqual(assignedDepartmentIds, initialDepartmentIds);
          const departmentSearchQuery = (departmentAccessQuery[user.id] || '').trim().toLowerCase();
          const filteredDepartments = flatDepts.filter(department => (
            !departmentSearchQuery || department.name.toLowerCase().includes(departmentSearchQuery)
          ));
          const selectedDepartments = assignedDepartmentIds
            .map(departmentId => departmentMap.get(departmentId) || {
              id: departmentId,
              name: `Не найденный отдел (${departmentId.slice(0, 8)})`,
              level: 0,
            });
          const assignableRoles = roles
            .filter(role => role.is_active || role.code === user.position_type);

          if (!assignableRoles.some(role => role.code === user.position_type)) {
            assignableRoles.push({
              id: `missing-${user.position_type}`,
              code: user.position_type,
              name: getRoleLabel(user.position_type),
              description: null,
              is_admin: false,
              employee_variant: null,
              is_active: false,
              created_at: '',
              updated_at: '',
            });
          }

          return (
            <div key={user.id} className={`${styles.userRow} ${isExpanded ? styles.expanded : ''}`}>
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
                  <span
                    className={styles.userRowOrg}
                    title={user.assigned_department_ids
                      .map(id => departmentMap.get(id)?.name || id)
                      .join(', ')}
                  >
                    {renderAssignedDepartments(user)}
                  </span>
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

              {isExpanded && (
                <div className={styles.userRowControls}>
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

                  <div className={styles.controlGroup}>
                    <label>Должность:</label>
                    <select
                      value={user.position_type}
                      onChange={(e) => handlePositionChange(user.id, e.target.value as EmployeePositionType)}
                    >
                      {assignableRoles
                        .sort((a, b) => Number(b.is_admin) - Number(a.is_admin) || a.name.localeCompare(b.name, 'ru'))
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

                  {!user.employee_id ? (
                    <div className={styles.departmentAccessSection}>
                      <div className={styles.departmentAccessHint}>
                        Чтобы назначить отделы, сначала выберите сотрудника СКУД и сохраните привязку.
                      </div>
                    </div>
                  ) : (
                    <div className={styles.departmentAccessSection}>
                      <div className={styles.departmentAccessHeader}>
                        <div>
                          <div className={styles.departmentAccessTitle}>Назначенные отделы и бригады</div>
                          <div className={styles.departmentAccessHint}>
                            Выберите все отделы и бригады, за которые отвечает пользователь. Все назначения равноправны.
                          </div>
                        </div>
                        <div className={styles.departmentAccessCount}>
                          {assignedDepartmentIds.length} выбрано
                        </div>
                      </div>

                      <input
                        type="text"
                        placeholder="Поиск отдела или бригады..."
                        value={departmentAccessQuery[user.id] || ''}
                        onChange={(e) => setDepartmentAccessQuery(prev => ({
                          ...prev,
                          [user.id]: e.target.value,
                        }))}
                        className={`${styles.nameInput} ${styles.departmentAccessSearch}`}
                      />

                      {selectedDepartments.length > 0 && (
                        <div className={styles.departmentAccessTags}>
                          {selectedDepartments.map(department => (
                            <button
                              key={department.id}
                              type="button"
                              className={styles.departmentAccessTag}
                              onClick={() => handleDepartmentAccessToggle(user, department.id)}
                            >
                              {department.name}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className={styles.departmentAccessList}>
                        {filteredDepartments.length > 0 ? (
                          filteredDepartments.map(department => {
                            const checked = assignedDepartmentIds.includes(department.id);
                            return (
                              <label
                                key={department.id}
                                className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => handleDepartmentAccessToggle(user, department.id)}
                                />
                                <span
                                  className={styles.departmentAccessItemLabel}
                                  style={{ paddingLeft: `${department.level * 14}px` }}
                                >
                                  {department.name}
                                </span>
                              </label>
                            );
                          })
                        ) : (
                          <div className={styles.departmentAccessEmpty}>
                            {departmentSearchQuery ? 'По запросу ничего не найдено' : 'Нет доступных подразделений'}
                          </div>
                        )}
                      </div>

                      <div className={styles.departmentAccessActions}>
                        <button
                          type="button"
                          className={styles.cancelBtn}
                          onClick={() => handleDepartmentAccessReset(user)}
                          disabled={!hasDepartmentAccessChanges || savingDepartmentAccessUserId === user.id}
                        >
                          Сбросить
                        </button>
                        <button
                          type="button"
                          className={styles.saveBtn}
                          onClick={() => handleDepartmentAccessSave(user)}
                          disabled={!hasDepartmentAccessChanges || savingDepartmentAccessUserId === user.id}
                        >
                          {savingDepartmentAccessUserId === user.id ? 'Сохраняю...' : 'Сохранить назначения'}
                        </button>
                      </div>
                    </div>
                  )}

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
