import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import { rolesService } from '../../services/rolesService';
import { useStructureTree } from '../../hooks/useStructure';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import type { ChatInboundMode, EmployeePositionType, SystemRole, TwoFactorData } from '../../types';
import { getTreeFlatDepartments, type IFlatDepartmentOption } from '../../utils/departmentUtils';
import { SearchInput } from '../ui/SearchInput';
import { UserCompanyAccessSection } from './UserCompanyAccessSection';
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
  patchAllUsersCache: (updater: (prev: IUserFromApi[]) => IUserFromApi[]) => void;
}

type IRoleOption = SystemRole;

const normalizeAssignedDepartmentIds = (departmentIds: string[]): string[] => (
  [...new Set(departmentIds.filter(Boolean))]
);

const areDepartmentSelectionsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
};

interface IUserRowExpandedProps {
  user: IUserFromApi;
  flatDepts: IFlatDepartmentOption[];
  departmentMap: Map<string, IFlatDepartmentOption>;
  assignableRoles: IRoleOption[];
  /** true, если viewer — системный админ. Только он может править companies. */
  canManageCompanies: boolean;
  onUpdateName: (userId: string, name: string) => Promise<void>;
  onChangePosition: (userId: string, position: EmployeePositionType) => Promise<void>;
  onChangeChatMode: (userId: string, mode: ChatInboundMode) => Promise<void>;
  onLinkEmployee: (userId: string, employeeId: number | null, empName?: string) => Promise<void>;
  onSaveDepartmentAccess: (userId: string, ids: string[]) => Promise<string[] | null>;
  onConfirmEmail: (userId: string) => Promise<void>;
  onGenerate2FA: (userId: string, userName: string) => Promise<void>;
  onDisable2FA: (userId: string) => Promise<void>;
  onDelete: (userId: string) => Promise<void>;
}

const UserRowExpanded: FC<IUserRowExpandedProps> = memo(({
  user,
  flatDepts,
  departmentMap,
  assignableRoles,
  canManageCompanies,
  onUpdateName,
  onChangePosition,
  onChangeChatMode,
  onLinkEmployee,
  onSaveDepartmentAccess,
  onConfirmEmail,
  onGenerate2FA,
  onDisable2FA,
  onDelete,
}) => {
  const userRole = useMemo(
    () => assignableRoles.find(role => role.code === user.position_type) ?? null,
    [assignableRoles, user.position_type],
  );
  const isUserAdmin = !!userRole?.is_admin;
  const [editingName, setEditingName] = useState<string | null>(null);
  const [departmentSearchQuery, setDepartmentSearchQuery] = useState('');
  const [departmentDraft, setDepartmentDraft] = useState<string[] | null>(null);
  const [savingDepartments, setSavingDepartments] = useState(false);
  const [empSearchQuery, setEmpSearchQuery] = useState('');
  const [empSearchLoading, setEmpSearchLoading] = useState(false);
  const [empSearchResults, setEmpSearchResults] = useState<{ id: number; full_name: string; org_department_id: string | null }[]>([]);
  const empSearchSeqRef = useRef(0);

  const assignedDepartmentIds = useMemo(
    () => normalizeAssignedDepartmentIds(departmentDraft ?? user.assigned_department_ids ?? []),
    [departmentDraft, user.assigned_department_ids],
  );

  const initialDepartmentIds = useMemo(
    () => normalizeAssignedDepartmentIds(user.assigned_department_ids ?? []),
    [user.assigned_department_ids],
  );

  const hasDepartmentAccessChanges = useMemo(
    () => !areDepartmentSelectionsEqual(assignedDepartmentIds, initialDepartmentIds),
    [assignedDepartmentIds, initialDepartmentIds],
  );

  const normalizedSearch = useMemo(
    () => departmentSearchQuery.trim().toLowerCase(),
    [departmentSearchQuery],
  );

  const filteredDepartments = useMemo(() => (
    !normalizedSearch
      ? flatDepts
      : flatDepts.filter(d => d.name.toLowerCase().includes(normalizedSearch))
  ), [flatDepts, normalizedSearch]);

  const selectedDepartments = useMemo(() => (
    assignedDepartmentIds.map(id => departmentMap.get(id) || {
      id,
      name: `Не найденный отдел (${id.slice(0, 8)})`,
      level: 0,
      hasChildren: false,
      kind: 'department' as IFlatDepartmentOption['kind'],
    })
  ), [assignedDepartmentIds, departmentMap]);

  // Debounce поиска сотрудника СКУД (250 мс) + защита от устаревших ответов
  useEffect(() => {
    if (empSearchQuery.length < 2) {
      setEmpSearchResults([]);
      setEmpSearchLoading(false);
      return;
    }
    setEmpSearchLoading(true);
    const seq = ++empSearchSeqRef.current;
    const timer = setTimeout(async () => {
      try {
        const results = await adminService.searchUnlinkedEmployees(empSearchQuery);
        if (seq === empSearchSeqRef.current) {
          setEmpSearchResults(results);
          setEmpSearchLoading(false);
        }
      } catch (err) {
        console.error('Employee search error:', err);
        if (seq === empSearchSeqRef.current) {
          setEmpSearchResults([]);
          setEmpSearchLoading(false);
        }
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [empSearchQuery]);

  const handleNameSave = async () => {
    if (editingName === null || !editingName.trim()) return;
    await onUpdateName(user.id, editingName.trim());
    setEditingName(null);
  };

  const handleDepartmentToggle = useCallback((departmentId: string) => {
    setDepartmentDraft(() => {
      const current = assignedDepartmentIds;
      const next = current.includes(departmentId)
        ? current.filter(id => id !== departmentId)
        : [...current, departmentId];
      return normalizeAssignedDepartmentIds(next);
    });
  }, [assignedDepartmentIds]);

  const handleDepartmentReset = () => {
    setDepartmentDraft(null);
    setDepartmentSearchQuery('');
  };

  const handleDepartmentSave = async () => {
    setSavingDepartments(true);
    try {
      const response = await onSaveDepartmentAccess(user.id, assignedDepartmentIds);
      if (response) {
        setDepartmentDraft(normalizeAssignedDepartmentIds(response));
      }
    } finally {
      setSavingDepartments(false);
    }
  };

  const handleEmpPick = async (employeeId: number, empName: string) => {
    await onLinkEmployee(user.id, employeeId, empName);
    setEmpSearchQuery('');
    setEmpSearchResults([]);
  };

  return (
    <div className={styles.userRowControls}>
      <div className={styles.controlGroup}>
        <label>ФИО:</label>
        {editingName !== null ? (
          <div className={styles.nameEditGroup}>
            <input
              type="text"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              className={styles.nameInput}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNameSave();
                if (e.key === 'Escape') setEditingName(null);
              }}
            />
            <button className={styles.saveBtn} onClick={handleNameSave}>Сохранить</button>
            <button className={styles.cancelBtn} onClick={() => setEditingName(null)}>Отмена</button>
          </div>
        ) : (
          <button
            className={styles.editNameBtn}
            onClick={() => setEditingName(user.full_name || '')}
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
          onChange={(e) => onChangePosition(user.id, e.target.value as EmployeePositionType)}
        >
          {assignableRoles
            .slice()
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
          onChange={(e) => onChangeChatMode(user.id, e.target.value as ChatInboundMode)}
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
              onClick={() => onLinkEmployee(user.id, null)}
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
          value={empSearchQuery}
          onChange={(e) => setEmpSearchQuery(e.target.value)}
          className={`${styles.nameInput} ${styles.skudSearchInput}`}
        />
        {empSearchLoading && (
          <div className={styles.skudSearchLoading}>Поиск...</div>
        )}
        {empSearchResults.length > 0 && (
          <div className={styles.skudSearchResults}>
            {empSearchResults.map(emp => (
              <div
                key={emp.id}
                className={styles.skudSearchItem}
                onClick={() => handleEmpPick(emp.id, emp.full_name)}
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
            value={departmentSearchQuery}
            onChange={(e) => setDepartmentSearchQuery(e.target.value)}
            className={`${styles.nameInput} ${styles.departmentAccessSearch}`}
          />

          {selectedDepartments.length > 0 && (
            <div className={styles.departmentAccessTags}>
              {selectedDepartments.map(department => (
                <button
                  key={department.id}
                  type="button"
                  className={styles.departmentAccessTag}
                  onClick={() => handleDepartmentToggle(department.id)}
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
                      onChange={() => handleDepartmentToggle(department.id)}
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
                {normalizedSearch ? 'По запросу ничего не найдено' : 'Нет доступных подразделений'}
              </div>
            )}
          </div>

          <div className={styles.departmentAccessActions}>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={handleDepartmentReset}
              disabled={!hasDepartmentAccessChanges || savingDepartments}
            >
              Сбросить
            </button>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={handleDepartmentSave}
              disabled={!hasDepartmentAccessChanges || savingDepartments}
            >
              {savingDepartments ? 'Сохраняю...' : 'Сохранить назначения'}
            </button>
          </div>
        </div>
      )}

      {canManageCompanies && isUserAdmin && (
        <UserCompanyAccessSection userId={user.id} isUserAdmin={isUserAdmin} />
      )}

      <div className={styles.controlActions}>
        {!user.email_confirmed && (
          <button
            className={styles.primaryBtn}
            onClick={() => onConfirmEmail(user.id)}
          >
            Подтвердить email
          </button>
        )}

        {user.two_factor_enabled ? (
          <button
            className={styles.dangerBtn}
            onClick={() => onDisable2FA(user.id)}
          >
            Отключить 2FA
          </button>
        ) : (
          <button
            className={styles.primaryBtn}
            onClick={() => onGenerate2FA(user.id, user.full_name || user.email || '')}
          >
            Выдать 2FA
          </button>
        )}

        <button
          className={styles.rejectBtn}
          onClick={() => onDelete(user.id)}
        >
          Удалить
        </button>
      </div>
    </div>
  );
});

UserRowExpanded.displayName = 'UserRowExpanded';

export const AllUsersTab: FC<IAllUsersTabProps> = ({ allUsers, onReload, patchAllUsersCache }) => {
  const toast = useToast();
  const { getRoleLabel, profile, refreshProfile } = useAuth();
  // Полный список ролей нужен админу для approval-формы (employee_variant,
  // is_active и т.п.). Endpoint /roles защищён requireAnyPageAccess(/admin/users,
  // /admin/roles), поэтому страница его получит.
  const rolesQuery = useQuery({
    queryKey: ['admin-roles-full'],
    queryFn: () => rolesService.getAll(),
  });
  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const structureQuery = useStructureTree();
  const [roleFilter, setRoleFilter] = useState<EmployeePositionType | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
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

  // Привязку компаний может править только системный админ (без скоупа).
  const canManageCompanies = !!profile?.is_admin
    && (profile?.company_scope?.roots === 'all' || profile?.company_scope === undefined);

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

  const toggleExpand = useCallback((userId: string) => {
    setExpandedUserId(prev => prev === userId ? null : userId);
  }, []);

  const getPositionName = useCallback((positionType: EmployeePositionType) => {
    return getRoleLabel(positionType);
  }, [getRoleLabel]);

  const renderAssignedDepartments = useCallback((user: IUserFromApi) => {
    const ids = user.assigned_department_ids ?? [];
    if (ids.length === 0) return '—';
    const names = ids.map(id => departmentMap.get(id)?.name || '—');
    if (names.length === 1) return names[0];
    return `${names[0]} +${names.length - 1}`;
  }, [departmentMap]);

  const handleEmpLink = useCallback(async (userId: string, employeeId: number | null, empName?: string) => {
    try {
      await adminService.updateUserEmployee(userId, employeeId);
      toast.success(employeeId ? `Привязан: ${empName ?? ''}` : 'Сотрудник отвязан');
      patchAllUsersCache((prev) => prev.map((u) => u.id === userId ? { ...u, employee_id: employeeId } : u));
      await onReload();
    } catch {
      toast.error('Ошибка привязки сотрудника');
    }
  }, [onReload, patchAllUsersCache, toast]);

  const handleNameSave = useCallback(async (userId: string, name: string) => {
    try {
      await adminService.updateUserName(userId, name);
      toast.success('ФИО обновлено');
      await onReload();
    } catch {
      toast.error('Ошибка обновления ФИО');
    }
  }, [onReload, toast]);

  const handlePositionChange = useCallback(async (userId: string, positionType: EmployeePositionType) => {
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
  }, [onReload, profile, refreshProfile, toast]);

  const handleChatInboundModeChange = useCallback(async (userId: string, chatInboundMode: ChatInboundMode) => {
    try {
      await adminService.updateUserChatInboundMode(userId, chatInboundMode);
      toast.success('Режим входящих сообщений обновлён');
      await onReload();
    } catch {
      toast.error('Ошибка обновления режима входящих сообщений');
    }
  }, [onReload, toast]);

  const handleDepartmentAccessSave = useCallback(async (userId: string, assignedDepartmentIds: string[]): Promise<string[] | null> => {
    try {
      const response = await adminService.updateUserDepartmentAccess(userId, assignedDepartmentIds);
      toast.success('Назначения сохранены');
      await onReload();
      if (profile?.id === userId) {
        await refreshProfile();
      }
      return response.assigned_department_ids;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения назначений');
      return null;
    }
  }, [onReload, profile, refreshProfile, toast]);

  const handleDeleteUser = useCallback(async (userId: string) => {
    if (!confirm('Удалить пользователя из системы? Это действие необратимо.')) return;
    try {
      await adminService.deleteUser(userId);
      toast.success('Пользователь удалён');
      await onReload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка удаления пользователя');
    }
  }, [onReload, toast]);

  const handleGenerate2FA = useCallback(async (userId: string, userName: string) => {
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
  }, [onReload, toast]);

  const handleDisable2FA = useCallback(async (userId: string) => {
    if (!confirm('Отключить 2FA для пользователя? Это снизит безопасность аккаунта.')) return;
    try {
      await adminService.disable2FA(userId);
      toast.warning('2FA отключен');
      await onReload();
    } catch {
      toast.error('Ошибка отключения 2FA');
    }
  }, [onReload, toast]);

  const handleConfirmEmail = useCallback(async (userId: string) => {
    try {
      await adminService.confirmUserEmail(userId);
      toast.success('Email подтверждён');
      await onReload();
    } catch {
      toast.error('Ошибка подтверждения email');
    }
  }, [onReload, toast]);

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

  const buildAssignableRoles = useCallback((user: IUserFromApi): IRoleOption[] => {
    const list: IRoleOption[] = roles
      .filter(role => role.is_active || role.code === user.position_type)
      .map(role => ({ ...role }));
    if (!list.some(role => role.code === user.position_type)) {
      list.push({
        id: `missing-${user.position_type}`,
        code: user.position_type,
        name: getRoleLabel(user.position_type),
        description: null,
        is_admin: false,
        employee_variant: null,
        is_active: false,
        show_actual_hours: false,
        created_at: '',
        updated_at: '',
      });
    }
    return list;
  }, [getRoleLabel, roles]);

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
                <UserRowExpanded
                  user={user}
                  flatDepts={flatDepts}
                  departmentMap={departmentMap}
                  assignableRoles={buildAssignableRoles(user)}
                  canManageCompanies={canManageCompanies}
                  onUpdateName={handleNameSave}
                  onChangePosition={handlePositionChange}
                  onChangeChatMode={handleChatInboundModeChange}
                  onLinkEmployee={handleEmpLink}
                  onSaveDepartmentAccess={handleDepartmentAccessSave}
                  onConfirmEmail={handleConfirmEmail}
                  onGenerate2FA={handleGenerate2FA}
                  onDisable2FA={handleDisable2FA}
                  onDelete={handleDeleteUser}
                />
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
