import { useState, useRef, useMemo } from 'react';
import type { FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rolesService } from '../../services/rolesService';
import type {
  RolePageAccessEntry,
  AvailablePage,
  PermissionGroup,
} from '../../services/rolesService';
import { useToast } from '../../contexts/ToastContext';
import type { SystemRole } from '../../types';
import styles from './RoleManagementPage.module.css';

type Tab = 'roles' | 'access' | 'permissions';

interface INewRoleForm {
  code: string;
  name: string;
  level: string;
}

interface IEditState {
  code: string;
  name: string;
  level: string;
}

interface IAccessCell {
  can_view: boolean;
  can_edit: boolean;
}

type AccessMatrix = Record<string, Record<string, IAccessCell>>;
type PermissionMatrix = Record<string, string[]>;

const normalizePermissions = (permissions: string[] | undefined): string[] =>
  [...new Set(permissions ?? [])].sort();

const areSamePermissions = (left: string[] | undefined, right: string[] | undefined): boolean => {
  const leftNormalized = normalizePermissions(left);
  const rightNormalized = normalizePermissions(right);
  return JSON.stringify(leftNormalized) === JSON.stringify(rightNormalized);
};

const emptyAccessCell = (): IAccessCell => ({ can_view: false, can_edit: false });
const EMPTY_ROLES: SystemRole[] = [];

export const RoleManagementPage: FC = () => {
  const { error: toastError, success: toastSuccess } = useToast();
  const queryClient = useQueryClient();
  const toastErrorRef = useRef(toastError);
  const toastSuccessRef = useRef(toastSuccess);
  toastErrorRef.current = toastError;
  toastSuccessRef.current = toastSuccess;

  const [tab, setTab] = useState<Tab>('roles');

  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<INewRoleForm>({ code: '', name: '', level: '' });
  const [editState, setEditState] = useState<IEditState | null>(null);
  const [saving, setSaving] = useState(false);

  const [accessOverrides, setAccessOverrides] = useState<AccessMatrix>({});
  const [savingAccess, setSavingAccess] = useState(false);

  const [permissionOverrides, setPermissionOverrides] = useState<PermissionMatrix>({});
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [permissionSearch, setPermissionSearch] = useState('');
  const [expandedPermissionRoles, setExpandedPermissionRoles] = useState<Set<string>>(new Set());

  const rolesQuery = useQuery<SystemRole[]>({
    queryKey: ['roles', 'all'],
    queryFn: () => rolesService.getAll(),
    staleTime: 60_000,
  });
  const accessQuery = useQuery<{ accessData: RolePageAccessEntry[]; pagesData: AvailablePage[] }>({
    queryKey: ['roles', 'access-matrix'],
    queryFn: async () => {
      const [accessData, pagesData] = await Promise.all([
        rolesService.getPageAccess(),
        rolesService.getAvailablePages(),
      ]);
      return { accessData, pagesData };
    },
    enabled: tab === 'access',
    staleTime: 60_000,
  });
  const permissionCatalogQuery = useQuery<PermissionGroup[]>({
    queryKey: ['roles', 'permission-catalog'],
    queryFn: () => rolesService.getPermissionCatalog(),
    enabled: tab === 'permissions',
    staleTime: 5 * 60_000,
  });

  const roles = rolesQuery.data ?? EMPTY_ROLES;
  const loadingRoles = rolesQuery.isPending;
  const loadingAccess = accessQuery.isPending;
  const loadingPermissions = permissionCatalogQuery.isPending;
  const pages = accessQuery.data?.pagesData ?? [];
  const permissionGroups = permissionCatalogQuery.data ?? [];

  const sortedRoles = useMemo(
    () => [...roles].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, 'ru')),
    [roles],
  );

  const basePermissionMatrix = useMemo(() => {
    const nextPermissionMatrix: PermissionMatrix = {};
    for (const role of roles) {
      nextPermissionMatrix[role.code] = normalizePermissions(role.permissions);
    }
    return nextPermissionMatrix;
  }, [roles]);

  const permissionMatrix = useMemo<PermissionMatrix>(
    () => ({ ...basePermissionMatrix, ...permissionOverrides }),
    [basePermissionMatrix, permissionOverrides],
  );

  const baseAccessMatrix = useMemo<AccessMatrix>(() => {
    const nextMatrix: AccessMatrix = {};
    const accessData = accessQuery.data?.accessData ?? [];
    for (const entry of accessData) {
      if (!nextMatrix[entry.role_code]) {
        nextMatrix[entry.role_code] = {};
      }
      nextMatrix[entry.role_code][entry.page_path] = {
        can_view: entry.can_view,
        can_edit: entry.can_edit,
      };
    }
    return nextMatrix;
  }, [accessQuery.data?.accessData]);

  const matrix = useMemo<AccessMatrix>(() => {
    const merged: AccessMatrix = { ...baseAccessMatrix };
    for (const [roleCode, roleCells] of Object.entries(accessOverrides)) {
      merged[roleCode] = {
        ...(merged[roleCode] ?? {}),
        ...roleCells,
      };
    }
    return merged;
  }, [accessOverrides, baseAccessMatrix]);

  const filteredPermissionRoles = useMemo(() => {
    const query = permissionSearch.trim().toLowerCase();
    if (!query) {
      return sortedRoles;
    }

    return sortedRoles.filter(role =>
      role.name.toLowerCase().includes(query) || role.code.toLowerCase().includes(query),
    );
  }, [permissionSearch, sortedRoles]);

  const areAllFilteredPermissionRolesExpanded = useMemo(
    () =>
      filteredPermissionRoles.length > 0 &&
      filteredPermissionRoles.every(role => expandedPermissionRoles.has(role.code)),
    [expandedPermissionRoles, filteredPermissionRoles],
  );

  const refreshRoles = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['roles', 'all'] }),
      queryClient.invalidateQueries({ queryKey: ['roles', 'access-matrix'] }),
    ]);
  };

  const handleCreateRole = async () => {
    const level = parseInt(newForm.level, 10);
    if (!newForm.code || !newForm.name || Number.isNaN(level)) {
      toastErrorRef.current('Заполните все поля');
      return;
    }

    setSaving(true);
    try {
      await rolesService.create({ code: newForm.code, name: newForm.name, level });
      toastSuccessRef.current('Роль создана');
      setNewForm({ code: '', name: '', level: '' });
      setShowNewForm(false);
      setPermissionOverrides({});
      await refreshRoles();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Ошибка создания роли';
      toastErrorRef.current(message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async (code: string) => {
    if (!editState) return;

    const level = parseInt(editState.level, 10);
    if (!editState.name || Number.isNaN(level)) {
      toastErrorRef.current('Заполните все поля');
      return;
    }

    setSaving(true);
    try {
      await rolesService.update(code, { name: editState.name, level });
      toastSuccessRef.current('Роль обновлена');
      setEditState(null);
      setPermissionOverrides({});
      await refreshRoles();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Ошибка сохранения';
      toastErrorRef.current(message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (role: SystemRole) => {
    try {
      await rolesService.update(role.code, {
        name: role.name,
        description: role.description,
        level: role.level,
        is_active: !role.is_active,
      });
      toastSuccessRef.current(role.is_active ? 'Роль деактивирована' : 'Роль активирована');
      await refreshRoles();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Ошибка изменения статуса';
      toastErrorRef.current(message);
    }
  };

  const handleDeleteRole = async (code: string) => {
    if (!confirm(`Удалить роль "${code}"? Это действие необратимо.`)) return;

    try {
      await rolesService.deleteRole(code);
      toastSuccessRef.current('Роль удалена');
      setAccessOverrides({});
      setPermissionOverrides({});
      await refreshRoles();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Ошибка удаления';
      toastErrorRef.current(message);
    }
  };

  const handleMatrixToggle = (roleCode: string, pagePath: string, action: 'view' | 'edit') => {
    setAccessOverrides(prev => {
      const current = (prev[roleCode]?.[pagePath] ?? matrix[roleCode]?.[pagePath]) ?? emptyAccessCell();
      let next = current;

      if (action === 'view') {
        next = current.can_view
          ? emptyAccessCell()
          : { ...current, can_view: true };
      } else {
        next = current.can_edit
          ? { ...current, can_edit: false }
          : { can_view: true, can_edit: true };
      }

      return {
        ...prev,
        [roleCode]: {
          ...(prev[roleCode] ?? {}),
          [pagePath]: next,
        },
      };
    });
  };

  const handleSaveAccess = async () => {
    setSavingAccess(true);
    try {
      const items: RolePageAccessEntry[] = [];
      for (const role of sortedRoles) {
        for (const page of pages) {
          const cell = matrix[role.code]?.[page.path] ?? emptyAccessCell();
          items.push({
            role_code: role.code,
            page_path: page.path,
            can_view: cell.can_view,
            can_edit: cell.can_edit,
          });
        }
      }

      await rolesService.updatePageAccess(items);
      toastSuccessRef.current('Матрица доступа сохранена');
      setAccessOverrides({});
      await queryClient.invalidateQueries({ queryKey: ['roles', 'access-matrix'] });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Ошибка сохранения';
      toastErrorRef.current(message);
    } finally {
      setSavingAccess(false);
    }
  };

  const handlePermissionChange = (roleCode: string, group: PermissionGroup, nextCode: string | null) => {
    setPermissionOverrides(prev => {
      const current = normalizePermissions(permissionMatrix[roleCode]);

      if (group.exclusive) {
        const optionCodes = new Set(group.options.map(option => option.code));
        const nextPermissions = current.filter(permission => !optionCodes.has(permission));
        if (nextCode) {
          nextPermissions.push(nextCode);
        }
        return {
          ...prev,
          [roleCode]: normalizePermissions(nextPermissions),
        };
      }

      const nextPermissions = current.includes(nextCode || '')
        ? current.filter(permission => permission !== nextCode)
        : [...current, ...(nextCode ? [nextCode] : [])];

      return {
        ...prev,
        [roleCode]: normalizePermissions(nextPermissions),
      };
    });
  };

  const togglePermissionRole = (roleCode: string) => {
    setExpandedPermissionRoles(prev => {
      const next = new Set(prev);
      if (next.has(roleCode)) {
        next.delete(roleCode);
      } else {
        next.add(roleCode);
      }
      return next;
    });
  };

  const toggleAllFilteredPermissionRoles = () => {
    setExpandedPermissionRoles(prev => {
      const next = new Set(prev);
      if (areAllFilteredPermissionRolesExpanded) {
        for (const role of filteredPermissionRoles) {
          next.delete(role.code);
        }
      } else {
        for (const role of filteredPermissionRoles) {
          next.add(role.code);
        }
      }
      return next;
    });
  };

  const handleSavePermissions = async () => {
    setSavingPermissions(true);
    try {
      const changedRoles = sortedRoles.filter(role =>
        !areSamePermissions(role.permissions, permissionMatrix[role.code]),
      );

      if (changedRoles.length === 0) {
        toastSuccessRef.current('Изменений в правах нет');
        return;
      }

      await Promise.all(
        changedRoles.map(role =>
          rolesService.update(role.code, {
            name: role.name,
            description: role.description,
            level: role.level,
            is_active: role.is_active,
            permissions: permissionMatrix[role.code] ?? [],
          }),
        ),
      );

      toastSuccessRef.current('Права ролей сохранены');
      setPermissionOverrides({});
      await queryClient.invalidateQueries({ queryKey: ['roles', 'all'] });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Ошибка сохранения прав';
      toastErrorRef.current(message);
    } finally {
      setSavingPermissions(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'roles' ? styles.tabActive : ''}`}
          onClick={() => setTab('roles')}
        >
          Роли
        </button>
        <button
          className={`${styles.tab} ${tab === 'access' ? styles.tabActive : ''}`}
          onClick={() => setTab('access')}
        >
          Доступ к страницам
        </button>
        <button
          className={`${styles.tab} ${tab === 'permissions' ? styles.tabActive : ''}`}
          onClick={() => setTab('permissions')}
        >
          Права
        </button>
      </div>

      {rolesQuery.isError && (
        <div className={styles.loading}>Ошибка загрузки ролей</div>
      )}

      {tab === 'roles' && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Системные роли</h2>
            <button className={styles.addBtn} onClick={() => setShowNewForm(value => !value)}>
              + Добавить роль
            </button>
          </div>

          {showNewForm && (
            <div className={styles.newRoleForm}>
              <input
                className={styles.input}
                placeholder="Код (напр. finance)"
                value={newForm.code}
                onChange={event =>
                  setNewForm(form => ({
                    ...form,
                    code: event.target.value.toLowerCase().replace(/[^a-z_]/g, ''),
                  }))
                }
              />
              <input
                className={styles.input}
                placeholder="Название"
                value={newForm.name}
                onChange={event => setNewForm(form => ({ ...form, name: event.target.value }))}
              />
              <input
                className={styles.input}
                placeholder="Уровень иерархии"
                type="number"
                min={1}
                max={99}
                value={newForm.level}
                onChange={event => setNewForm(form => ({ ...form, level: event.target.value }))}
              />
              <div className={styles.formActions}>
                <button className={styles.saveBtn} onClick={handleCreateRole} disabled={saving}>
                  Создать
                </button>
                <button className={styles.cancelBtn} onClick={() => setShowNewForm(false)}>
                  Отмена
                </button>
              </div>
            </div>
          )}

          {loadingRoles ? (
            <div className={styles.loading}>Загрузка...</div>
          ) : (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Код</th>
                    <th>Название</th>
                    <th>Уровень</th>
                    <th>Тип</th>
                    <th>Статус</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRoles.map(role => (
                    <tr key={role.code} className={!role.is_active ? styles.rowInactive : ''}>
                      <td data-label="Код">
                        <code className={styles.code}>{role.code}</code>
                      </td>
                      <td data-label="Название">
                        {editState?.code === role.code ? (
                          <input
                            className={styles.inputInline}
                            value={editState.name}
                            onChange={event =>
                              setEditState(state => (state ? { ...state, name: event.target.value } : state))
                            }
                            autoFocus
                          />
                        ) : (
                          role.name
                        )}
                      </td>
                      <td data-label="Уровень">
                        {editState?.code === role.code ? (
                          <input
                            className={styles.inputInlineSmall}
                            type="number"
                            min={1}
                            max={99}
                            value={editState.level}
                            onChange={event =>
                              setEditState(state => (state ? { ...state, level: event.target.value } : state))
                            }
                          />
                        ) : (
                          role.level
                        )}
                      </td>
                      <td data-label="Тип">
                        {role.is_system ? (
                          <span className={styles.badgeSystem}>Системная</span>
                        ) : (
                          <span className={styles.badgeCustom}>Пользовательская</span>
                        )}
                      </td>
                      <td data-label="Статус">
                        <button
                          className={role.is_active ? styles.toggleActive : styles.toggleInactive}
                          onClick={() => handleToggleActive(role)}
                          title={role.is_active ? 'Деактивировать' : 'Активировать'}
                        >
                          {role.is_active ? 'Активна' : 'Неактивна'}
                        </button>
                      </td>
                      <td className={styles.actions}>
                        {editState?.code === role.code ? (
                          <>
                            <button className={styles.saveBtn} onClick={() => handleSaveEdit(role.code)} disabled={saving}>
                              Сохранить
                            </button>
                            <button className={styles.cancelBtn} onClick={() => setEditState(null)}>
                              Отмена
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className={styles.editBtn}
                              onClick={() =>
                                setEditState({
                                  code: role.code,
                                  name: role.name,
                                  level: String(role.level),
                                })
                              }
                            >
                              Изменить
                            </button>
                            {!role.is_system && (
                              <button className={styles.deleteBtn} onClick={() => handleDeleteRole(role.code)}>
                                Удалить
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'access' && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Матрица доступа к страницам</h2>
              <p className={styles.sectionHint}>
                `View` открывает страницу и read-only API. `Edit` разрешает действия изменения и автоматически включает `View`.
              </p>
            </div>
            <button className={styles.saveBtn} onClick={handleSaveAccess} disabled={savingAccess || loadingAccess}>
              {savingAccess ? 'Сохранение...' : 'Сохранить'}
            </button>
          </div>

          <div className={styles.matrixLegend}>
            <span className={styles.matrixLegendLabel}>Обозначения</span>
            <span className={styles.matrixLegendPill}>Просмотр</span>
            <span className={`${styles.matrixLegendPill} ${styles.matrixLegendPillEdit}`}>Изменение</span>
          </div>

          {loadingAccess ? (
            <div className={styles.loading}>Загрузка...</div>
          ) : accessQuery.isError ? (
            <div className={styles.loading}>Ошибка загрузки матрицы доступа</div>
          ) : (
            <div className={styles.matrixWrapper}>
              <table className={styles.matrixTable}>
                <thead>
                  <tr>
                    <th className={styles.matrixPageCol}>
                      <div className={styles.matrixHeaderLabel}>Страница</div>
                    </th>
                    {sortedRoles.map(role => (
                      <th key={role.code} className={styles.matrixRoleCol} title={role.code}>
                        <div className={styles.matrixRoleCard}>
                          <span className={styles.matrixRoleName}>{role.name}</span>
                          <code className={styles.matrixRoleCode}>{role.code}</code>
                          {!role.is_active && <span className={styles.inactiveTag}>Неактивна</span>}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pages.map(page => (
                    <tr key={page.path}>
                      <td className={styles.matrixPageLabel}>
                        <span className={styles.pageLabel}>{page.label}</span>
                        <code className={styles.pagePath}>{page.path}</code>
                      </td>
                      {sortedRoles.map(role => {
                        const cell = matrix[role.code]?.[page.path] ?? emptyAccessCell();

                        return (
                          <td key={role.code} className={styles.matrixCell}>
                            <div className={styles.matrixCellControls}>
                              <button
                                type="button"
                                className={`${styles.matrixAction} ${cell.can_view ? styles.matrixActionActive : ''}`}
                                onClick={() => handleMatrixToggle(role.code, page.path, 'view')}
                                aria-pressed={cell.can_view}
                                title="Разрешить просмотр"
                              >
                                <span className={styles.matrixActionText}>Просмотр</span>
                              </button>
                              <button
                                type="button"
                                className={`${styles.matrixAction} ${cell.can_edit ? styles.matrixActionEdit : ''}`}
                                onClick={() => handleMatrixToggle(role.code, page.path, 'edit')}
                                aria-pressed={cell.can_edit}
                                title="Разрешить изменение"
                              >
                                <span className={styles.matrixActionText}>Изм.</span>
                              </button>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'permissions' && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Capability-права</h2>
              <p className={styles.sectionHint}>
                Вариант кабинета `/employee` и область данных настраиваются здесь, а не жёстко в коде.
              </p>
            </div>
            <button
              className={styles.saveBtn}
              onClick={handleSavePermissions}
              disabled={savingPermissions || loadingPermissions || loadingRoles}
            >
              {savingPermissions ? 'Сохранение...' : 'Сохранить'}
            </button>
          </div>

          {loadingPermissions || loadingRoles ? (
            <div className={styles.loading}>Загрузка...</div>
          ) : permissionCatalogQuery.isError ? (
            <div className={styles.loading}>Ошибка загрузки каталога прав</div>
          ) : (
            <div className={styles.permissionCards}>
              <div className={styles.permissionToolbar}>
                <label className={styles.permissionSearch}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={permissionSearch}
                    onChange={event => setPermissionSearch(event.target.value)}
                    placeholder="Найти роль по названию или коду"
                  />
                </label>

                <div className={styles.permissionToolbarActions}>
                  <span className={styles.permissionResultCount}>
                    {filteredPermissionRoles.length} из {sortedRoles.length}
                  </span>
                  <button type="button" className={styles.clearBtn} onClick={toggleAllFilteredPermissionRoles}>
                    {areAllFilteredPermissionRolesExpanded ? 'Свернуть найденные' : 'Развернуть найденные'}
                  </button>
                </div>
              </div>

              {filteredPermissionRoles.length === 0 && (
                <div className={styles.permissionEmpty}>
                  По запросу ничего не найдено. Попробуй поиск по коду роли или части названия.
                </div>
              )}

              {filteredPermissionRoles.map(role => {
                const selectedPermissions = permissionMatrix[role.code] ?? [];
                const isExpanded = expandedPermissionRoles.has(role.code);
                const selectedSummaries = permissionGroups
                  .map(group => {
                    const selectedOptions = group.options.filter(option => selectedPermissions.includes(option.code));
                    if (selectedOptions.length === 0) return null;
                    return {
                      group: group.label,
                      value: selectedOptions.map(option => option.label).join(', '),
                    };
                  })
                  .filter((item): item is { group: string; value: string } => item !== null);

                return (
                  <div
                    key={role.code}
                    className={`${styles.permissionCard} ${isExpanded ? styles.permissionCardExpanded : styles.permissionCardCollapsed}`}
                  >
                    <button
                      type="button"
                      className={styles.permissionCardHeader}
                      onClick={() => togglePermissionRole(role.code)}
                      aria-expanded={isExpanded}
                    >
                      <div className={styles.permissionCardHeaderMain}>
                        <div>
                          <div className={styles.permissionRoleTitle}>{role.name}</div>
                          <div className={styles.permissionRoleCodeRow}>
                            <code className={styles.code}>{role.code}</code>
                            <span className={styles.permissionRoleInfo}>Уровень: {role.level}</span>
                          </div>
                        </div>

                        <div className={styles.permissionSummary}>
                          {selectedSummaries.length > 0 ? (
                            selectedSummaries.map(summary => (
                              <span key={`${role.code}-${summary.group}`} className={styles.permissionSummaryChip}>
                                <strong>{summary.group}:</strong> {summary.value}
                              </span>
                            ))
                          ) : (
                            <span className={styles.permissionSummaryEmpty}>Права ещё не настроены</span>
                          )}
                        </div>
                      </div>

                      <div className={styles.permissionRoleMeta}>
                        <span className={role.is_active ? styles.toggleActive : styles.toggleInactive}>
                          {role.is_active ? 'Активна' : 'Неактивна'}
                        </span>
                        <span className={styles.permissionSelectionCount}>
                          {selectedPermissions.length} прав
                        </span>
                        <span className={`${styles.permissionChevron} ${isExpanded ? styles.permissionChevronOpen : ''}`}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </span>
                      </div>
                    </button>

                    {isExpanded && (
                      <div className={styles.permissionCardBody}>
                        {permissionGroups.map(group => (
                          <div key={group.code} className={styles.permissionGroup}>
                            <div className={styles.permissionGroupHeader}>
                              <div>
                                <div className={styles.permissionGroupTitle}>{group.label}</div>
                                <div className={styles.permissionGroupDescription}>{group.description}</div>
                              </div>
                              {group.exclusive && (
                                <button
                                  type="button"
                                  className={styles.clearBtn}
                                  onClick={() => handlePermissionChange(role.code, group, null)}
                                >
                                  Сбросить
                                </button>
                              )}
                            </div>

                            <div className={styles.permissionOptions}>
                              {group.options.map(option => {
                                const checked = selectedPermissions.includes(option.code);
                                return (
                                  <label
                                    key={option.code}
                                    className={`${styles.permissionOption} ${checked ? styles.permissionOptionActive : ''}`}
                                  >
                                    <input
                                      type={group.exclusive ? 'radio' : 'checkbox'}
                                      name={`${role.code}-${group.code}`}
                                      checked={checked}
                                      onChange={() => handlePermissionChange(role.code, group, option.code)}
                                    />
                                    <div>
                                      <div className={styles.permissionOptionTitle}>{option.label}</div>
                                      <div className={styles.permissionOptionDescription}>{option.description}</div>
                                      <code className={styles.permissionCode}>{option.code}</code>
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
