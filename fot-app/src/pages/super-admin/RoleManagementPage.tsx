import { useEffect, useMemo, useState } from 'react';
import type { FC } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { rolesService } from '../../services/rolesService';
import type {
  AccessMode,
  PageCatalogItem,
  PermissionGroup,
} from '../../services/rolesService';
import { useToast } from '../../contexts/ToastContext';
import type { SystemRole } from '../../types';
import styles from './RoleManagementPage.module.css';

type Tab = 'roles' | 'access';

interface INewRoleForm {
  code: string;
  name: string;
  level: string;
}

interface ICloneRoleForm {
  code: string;
  name: string;
  level: string;
  description: string;
}

interface IEditState {
  code: string;
  name: string;
  level: string;
}

interface IPageGroup {
  code: string;
  label: string;
  pages: PageCatalogItem[];
}

const EMPTY_ROLES: SystemRole[] = [];
const ACCESS_OPTIONS: AccessMode[] = ['none', 'view', 'edit'];

const normalizePermissions = (permissions: string[] | undefined): string[] =>
  [...new Set(permissions ?? [])].sort();

const serializePermissions = (permissions: string[] | undefined): string =>
  JSON.stringify(normalizePermissions(permissions));

const serializePageAccess = (pageAccess: Record<string, AccessMode> | undefined): string =>
  JSON.stringify(
    Object.entries(pageAccess ?? {})
      .filter(([, mode]) => mode !== 'none')
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey, 'ru')),
  );

const toRoleCode = (value: string): string => value.toLowerCase().replace(/[^a-z_]/g, '');

const getPermissionSelection = (permissions: string[], group: PermissionGroup): string | null => {
  const selectedOption = group.options.find((option) => permissions.includes(option.code));
  return selectedOption?.code ?? null;
};

const hasPermissionSelection = (permissions: string[], optionCode: string): boolean => (
  permissions.includes(optionCode)
);

const TIMESHEET_ROLE_HINTS = [
  'Бригадир: /timesheet edit + data.scope.department + Подача',
  'Руководитель строительства: /timesheet-hr edit + data.scope.department|all + Проверка',
  'HR по табелям: /timesheet-hr view|edit + data.scope.all + Мониторинг',
];

const updatePermissionSelection = (
  currentPermissions: string[],
  group: PermissionGroup,
  nextCode: string | null,
): string[] => {
  const optionCodes = new Set(group.options.map((option) => option.code));
  const preserved = currentPermissions.filter((permission) => !optionCodes.has(permission));

  if (!nextCode) {
    return normalizePermissions(preserved);
  }

  if (group.exclusive) {
    return normalizePermissions([...preserved, nextCode]);
  }

  const nextPermissions = currentPermissions.includes(nextCode)
    ? currentPermissions.filter((permission) => permission !== nextCode)
    : [...currentPermissions, nextCode];

  return normalizePermissions(nextPermissions);
};

export const RoleManagementPage: FC = () => {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>('roles');
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<INewRoleForm>({ code: '', name: '', level: '' });
  const [editState, setEditState] = useState<IEditState | null>(null);
  const [savingRole, setSavingRole] = useState(false);

  const [roleSearch, setRoleSearch] = useState('');
  const [selectedRoleCode, setSelectedRoleCode] = useState<string | null>(null);
  const [draftPermissions, setDraftPermissions] = useState<string[]>([]);
  const [draftPageAccess, setDraftPageAccess] = useState<Record<string, AccessMode>>({});
  const [savingAccess, setSavingAccess] = useState(false);
  const [showCloneForm, setShowCloneForm] = useState(false);
  const [cloneForm, setCloneForm] = useState<ICloneRoleForm>({
    code: '',
    name: '',
    level: '',
    description: '',
  });

  const rolesQuery = useQuery<SystemRole[]>({
    queryKey: ['roles', 'all'],
    queryFn: () => rolesService.getAll(),
    staleTime: 5 * 60_000,
  });

  const catalogQuery = useQuery({
    queryKey: ['roles', 'catalog'],
    queryFn: () => rolesService.getCatalog(),
    staleTime: 10 * 60_000,
  });

  const roles = rolesQuery.data ?? EMPTY_ROLES;
  const sortedRoles = useMemo(
    () => [...roles].sort((left, right) => left.level - right.level || left.name.localeCompare(right.name, 'ru')),
    [roles],
  );

  const filteredRoles = useMemo(() => {
    const query = roleSearch.trim().toLowerCase();
    if (!query) return sortedRoles;
    return sortedRoles.filter((role) =>
      role.name.toLowerCase().includes(query) || role.code.toLowerCase().includes(query),
    );
  }, [roleSearch, sortedRoles]);

  useEffect(() => {
    if (!sortedRoles.length) {
      setSelectedRoleCode(null);
      return;
    }

    if (!selectedRoleCode || !sortedRoles.some((role) => role.code === selectedRoleCode)) {
      setSelectedRoleCode(sortedRoles[0].code);
    }
  }, [selectedRoleCode, sortedRoles]);

  const selectedRole = useMemo(
    () => sortedRoles.find((role) => role.code === selectedRoleCode) ?? null,
    [selectedRoleCode, sortedRoles],
  );

  const accessProfileQuery = useQuery({
    queryKey: ['roles', 'access-profile', selectedRoleCode],
    queryFn: () => rolesService.getAccessProfile(selectedRoleCode as string),
    enabled: tab === 'access' && !!selectedRoleCode,
    staleTime: 2 * 60_000,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (!accessProfileQuery.data) return;
    setDraftPermissions(normalizePermissions(accessProfileQuery.data.permissions));
    setDraftPageAccess(accessProfileQuery.data.page_access ?? {});
  }, [accessProfileQuery.data]);

  const capabilityGroups = catalogQuery.data?.capabilities ?? [];
  const pages = catalogQuery.data?.pages ?? [];
  const groupedPages = useMemo<IPageGroup[]>(() => {
    const groups = new Map<string, IPageGroup>();

    for (const page of pages.filter((item) => item.surface === 'page')) {
      if (!groups.has(page.group_code)) {
        groups.set(page.group_code, {
          code: page.group_code,
          label: page.group_label,
          pages: [],
        });
      }

      groups.get(page.group_code)!.pages.push(page);
    }

    return [...groups.values()];
  }, [pages]);

  const technicalPages = useMemo(
    () => pages.filter((page) => page.surface === 'technical'),
    [pages],
  );

  const accessSummary = useMemo(() => {
    const visiblePages = pages.filter((page) => page.surface === 'page');
    const viewCount = visiblePages.filter((page) => (draftPageAccess[page.key] ?? 'none') !== 'none').length;
    const editCount = visiblePages.filter((page) => (draftPageAccess[page.key] ?? 'none') === 'edit').length;
    const technicalCount = technicalPages.filter((page) => (draftPageAccess[page.key] ?? 'none') !== 'none').length;

    return {
      totalPages: visiblePages.length,
      viewCount,
      editCount,
      technicalCount,
    };
  }, [draftPageAccess, pages, technicalPages]);

  const isAccessDirty = useMemo(() => {
    if (!accessProfileQuery.data) return false;
    return (
      serializePermissions(draftPermissions) !== serializePermissions(accessProfileQuery.data.permissions)
      || serializePageAccess(draftPageAccess) !== serializePageAccess(accessProfileQuery.data.page_access)
    );
  }, [accessProfileQuery.data, draftPageAccess, draftPermissions]);

  const upsertRoleInCache = (role: SystemRole) => {
    queryClient.setQueryData<SystemRole[]>(['roles', 'all'], (current) => {
      const list = current ?? [];
      const exists = list.some((item) => item.code === role.code);
      return exists
        ? list.map((item) => (item.code === role.code ? role : item))
        : [...list, role];
    });
  };

  const removeRoleFromCache = (code: string) => {
    queryClient.setQueryData<SystemRole[]>(['roles', 'all'], (current) =>
      (current ?? []).filter((item) => item.code !== code),
    );
    queryClient.removeQueries({ queryKey: ['roles', 'access-profile', code] });
  };

  const handleCreateRole = async () => {
    const level = Number.parseInt(newForm.level, 10);
    if (!newForm.code || !newForm.name || Number.isNaN(level)) {
      toast.error('Заполните код, название и уровень роли');
      return;
    }

    setSavingRole(true);
    try {
      const createdRole = await rolesService.create({
        code: newForm.code,
        name: newForm.name,
        level,
      });
      toast.success('Роль создана');
      setNewForm({ code: '', name: '', level: '' });
      setShowNewForm(false);
      setSelectedRoleCode(createdRole.code);
      upsertRoleInCache(createdRole);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка создания роли');
    } finally {
      setSavingRole(false);
    }
  };

  const handleSaveEdit = async (code: string) => {
    if (!editState) return;

    const level = Number.parseInt(editState.level, 10);
    if (!editState.name || Number.isNaN(level)) {
      toast.error('Заполните название и уровень роли');
      return;
    }

    setSavingRole(true);
    try {
      const updated = await rolesService.update(code, {
        name: editState.name,
        description: roles.find((role) => role.code === code)?.description,
        level,
      });
      toast.success('Роль обновлена');
      setEditState(null);
      upsertRoleInCache(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения роли');
    } finally {
      setSavingRole(false);
    }
  };

  const handleToggleActive = async (role: SystemRole) => {
    try {
      const updated = await rolesService.update(role.code, {
        name: role.name,
        description: role.description,
        level: role.level,
        is_active: !role.is_active,
      });
      toast.success(role.is_active ? 'Роль деактивирована' : 'Роль активирована');
      upsertRoleInCache(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка изменения статуса роли');
    }
  };

  const handleDeleteRole = async (code: string) => {
    if (!confirm(`Удалить роль "${code}"? Это действие необратимо.`)) return;

    try {
      await rolesService.deleteRole(code);
      toast.success('Роль удалена');
      if (selectedRoleCode === code) {
        setSelectedRoleCode(null);
      }
      removeRoleFromCache(code);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка удаления роли');
    }
  };

  const handlePermissionChange = (group: PermissionGroup, nextCode: string | null) => {
    setDraftPermissions((current) => updatePermissionSelection(current, group, nextCode));
  };

  const handlePageModeChange = (page: PageCatalogItem, mode: AccessMode) => {
    const nextMode = page.supports_edit ? mode : (mode === 'edit' ? 'view' : mode);
    setDraftPageAccess((current) => {
      if (nextMode === 'none') {
        const next = { ...current };
        delete next[page.key];
        return next;
      }

      return {
        ...current,
        [page.key]: nextMode,
      };
    });
  };

  const handleSaveAccess = async () => {
    if (!selectedRoleCode) return;

    setSavingAccess(true);
    try {
      await rolesService.updateAccessProfile(selectedRoleCode, {
        permissions: draftPermissions,
        page_access: draftPageAccess,
      });
      toast.success('Профиль доступа сохранён');
      await queryClient.invalidateQueries({
        queryKey: ['roles', 'access-profile', selectedRoleCode],
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения профиля доступа');
    } finally {
      setSavingAccess(false);
    }
  };

  const openCloneForm = () => {
    if (!selectedRole) return;
    setCloneForm({
      code: '',
      name: `${selectedRole.name} (копия)`,
      level: String(selectedRole.level),
      description: selectedRole.description ?? '',
    });
    setShowCloneForm(true);
  };

  const handleCloneRole = async () => {
    if (!selectedRole) return;

    const level = Number.parseInt(cloneForm.level, 10);
    if (!cloneForm.code || !cloneForm.name || Number.isNaN(level)) {
      toast.error('Заполните код, название и уровень для новой роли');
      return;
    }

    setSavingRole(true);
    try {
      const createdRole = await rolesService.cloneRole(selectedRole.code, {
        code: cloneForm.code,
        name: cloneForm.name,
        description: cloneForm.description || null,
        level,
      });
      toast.success('Роль-копия создана');
      setShowCloneForm(false);
      setSelectedRoleCode(createdRole.code);
      upsertRoleInCache(createdRole);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка клонирования роли');
    } finally {
      setSavingRole(false);
    }
  };

  const renderAccessControl = (page: PageCatalogItem) => {
    const currentMode = draftPageAccess[page.key] ?? 'none';
    const options = page.supports_edit ? ACCESS_OPTIONS : ACCESS_OPTIONS.filter((mode) => mode !== 'edit');

    return (
      <div className={styles.segmentedControl}>
        {options.map((mode) => (
          <button
            key={`${page.key}-${mode}`}
            type="button"
            className={`${styles.segmentedButton} ${currentMode === mode ? styles.segmentedButtonActive : ''}`}
            onClick={() => handlePageModeChange(page, mode)}
          >
            {mode === 'none' ? 'Нет доступа' : mode === 'view' ? 'Просмотр' : 'Изменение'}
          </button>
        ))}
      </div>
    );
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
      </div>

      {rolesQuery.isError && (
        <div className={styles.loading}>Ошибка загрузки ролей</div>
      )}

      {tab === 'roles' && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Системные роли</h2>
              <p className={styles.sectionHint}>
                Управление справочником ролей. Доступы и поведение роли настраиваются на соседней вкладке.
              </p>
            </div>
            <button className={styles.primaryButton} onClick={() => setShowNewForm((value) => !value)}>
              {showNewForm ? 'Скрыть форму' : '+ Добавить роль'}
            </button>
          </div>

          {showNewForm && (
            <div className={styles.inlineForm}>
              <input
                className={styles.input}
                placeholder="Код роли"
                value={newForm.code}
                onChange={(event) =>
                  setNewForm((current) => ({
                    ...current,
                    code: toRoleCode(event.target.value),
                  }))
                }
              />
              <input
                className={styles.input}
                placeholder="Название"
                value={newForm.name}
                onChange={(event) => setNewForm((current) => ({ ...current, name: event.target.value }))}
              />
              <input
                className={styles.inputSmall}
                type="number"
                min={0}
                max={100}
                placeholder="Уровень"
                value={newForm.level}
                onChange={(event) => setNewForm((current) => ({ ...current, level: event.target.value }))}
              />
              <div className={styles.formActions}>
                <button className={styles.successButton} onClick={handleCreateRole} disabled={savingRole}>
                  Создать
                </button>
                <button className={styles.secondaryButton} onClick={() => setShowNewForm(false)}>
                  Отмена
                </button>
              </div>
            </div>
          )}

          {rolesQuery.isPending ? (
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
                  {sortedRoles.map((role) => (
                    <tr key={role.code} className={!role.is_active ? styles.rowInactive : ''}>
                      <td>
                        <code className={styles.code}>{role.code}</code>
                      </td>
                      <td>
                        {editState?.code === role.code ? (
                          <input
                            className={styles.inputInline}
                            value={editState.name}
                            onChange={(event) =>
                              setEditState((current) => (current ? { ...current, name: event.target.value } : current))
                            }
                            autoFocus
                          />
                        ) : (
                          role.name
                        )}
                      </td>
                      <td>
                        {editState?.code === role.code ? (
                          <input
                            className={styles.inputInlineSmall}
                            type="number"
                            min={0}
                            max={100}
                            value={editState.level}
                            onChange={(event) =>
                              setEditState((current) => (current ? { ...current, level: event.target.value } : current))
                            }
                          />
                        ) : (
                          role.level
                        )}
                      </td>
                      <td>
                        <span className={role.is_system ? styles.badgeSystem : styles.badgeCustom}>
                          {role.is_system ? 'Системная' : 'Пользовательская'}
                        </span>
                      </td>
                      <td>
                        <button
                          className={role.is_active ? styles.statusActive : styles.statusInactive}
                          onClick={() => handleToggleActive(role)}
                        >
                          {role.is_active ? 'Активна' : 'Неактивна'}
                        </button>
                      </td>
                      <td className={styles.actions}>
                        {editState?.code === role.code ? (
                          <>
                            <button className={styles.successButton} onClick={() => handleSaveEdit(role.code)} disabled={savingRole}>
                              Сохранить
                            </button>
                            <button className={styles.secondaryButton} onClick={() => setEditState(null)}>
                              Отмена
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className={styles.secondaryButton}
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
                              <button className={styles.dangerButton} onClick={() => handleDeleteRole(role.code)}>
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
        <div className={styles.accessLayout}>
          <aside className={styles.roleSidebar}>
            <div className={styles.sidebarHeader}>
              <h2 className={styles.sectionTitle}>Роли</h2>
              <span className={styles.sidebarCount}>{filteredRoles.length}</span>
            </div>

            <input
              className={styles.searchInput}
              type="search"
              value={roleSearch}
              onChange={(event) => setRoleSearch(event.target.value)}
              placeholder="Поиск по коду или названию"
            />

            <div className={styles.roleList}>
              {filteredRoles.map((role) => (
                <button
                  key={role.code}
                  type="button"
                  className={`${styles.roleListItem} ${selectedRoleCode === role.code ? styles.roleListItemActive : ''}`}
                  onClick={() => setSelectedRoleCode(role.code)}
                >
                  <div className={styles.roleListItemHeader}>
                    <span className={styles.roleListName}>{role.name}</span>
                    <span className={role.is_active ? styles.badgeActive : styles.badgeInactive}>
                      {role.is_active ? 'Активна' : 'Неактивна'}
                    </span>
                  </div>
                  <div className={styles.roleListMeta}>
                    <code className={styles.code}>{role.code}</code>
                    <span>Уровень {role.level}</span>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <section className={styles.section}>
            {!selectedRole ? (
              <div className={styles.loading}>Роль не выбрана</div>
            ) : catalogQuery.isPending || accessProfileQuery.isPending ? (
              <div className={styles.loading}>Загрузка профиля доступа...</div>
            ) : catalogQuery.isError || accessProfileQuery.isError ? (
              <div className={styles.loading}>Ошибка загрузки профиля доступа</div>
            ) : (
              <>
                <div className={styles.sectionHeader}>
                  <div>
                    <h2 className={styles.sectionTitle}>{selectedRole.name}</h2>
                    <p className={styles.sectionHint}>
                      Редактирование выполняется по одной роли. View-only страницы не показывают режим изменения, а технические ключи вынесены отдельно.
                    </p>
                  </div>
                  <div className={styles.toolbarActions}>
                    <button className={styles.secondaryButton} onClick={openCloneForm}>
                      Создать роль на основе этой
                    </button>
                    <button className={styles.successButton} onClick={handleSaveAccess} disabled={savingAccess || !isAccessDirty}>
                      {savingAccess ? 'Сохранение...' : 'Сохранить'}
                    </button>
                  </div>
                </div>

                {showCloneForm && (
                  <div className={styles.inlineForm}>
                    <input
                      className={styles.input}
                      placeholder="Новый код роли"
                      value={cloneForm.code}
                      onChange={(event) =>
                        setCloneForm((current) => ({
                          ...current,
                          code: toRoleCode(event.target.value),
                        }))
                      }
                    />
                    <input
                      className={styles.input}
                      placeholder="Новое название"
                      value={cloneForm.name}
                      onChange={(event) => setCloneForm((current) => ({ ...current, name: event.target.value }))}
                    />
                    <input
                      className={styles.inputSmall}
                      type="number"
                      min={0}
                      max={100}
                      placeholder="Уровень"
                      value={cloneForm.level}
                      onChange={(event) => setCloneForm((current) => ({ ...current, level: event.target.value }))}
                    />
                    <input
                      className={styles.input}
                      placeholder="Описание (необязательно)"
                      value={cloneForm.description}
                      onChange={(event) => setCloneForm((current) => ({ ...current, description: event.target.value }))}
                    />
                    <div className={styles.formActions}>
                      <button className={styles.successButton} onClick={handleCloneRole} disabled={savingRole}>
                        Создать копию
                      </button>
                      <button className={styles.secondaryButton} onClick={() => setShowCloneForm(false)}>
                        Отмена
                      </button>
                    </div>
                  </div>
                )}

                <div className={styles.summaryBar}>
                  <div className={styles.summaryCard}>
                    <span>Страниц</span>
                    <strong>{accessSummary.totalPages}</strong>
                  </div>
                  <div className={styles.summaryCard}>
                    <span>С просмотром</span>
                    <strong>{accessSummary.viewCount}</strong>
                  </div>
                  <div className={styles.summaryCard}>
                    <span>С изменением</span>
                    <strong>{accessSummary.editCount}</strong>
                  </div>
                  <div className={styles.summaryCard}>
                    <span>Технические</span>
                    <strong>{accessSummary.technicalCount}</strong>
                  </div>
                </div>

                <div className={styles.accessSections}>
                  <div className={styles.card}>
                    <div className={styles.cardHeader}>
                      <h3 className={styles.cardTitle}>Поведение роли</h3>
                      <p className={styles.cardHint}>
                        Настройки capabilities, которые раньше жили на отдельной вкладке.
                      </p>
                    </div>

                    <div className={styles.behaviorGroups}>
                      {capabilityGroups.map((group) => {
                        const selectedCode = getPermissionSelection(draftPermissions, group);

                        return (
                          <div key={group.code} className={styles.behaviorGroup}>
                            <div className={styles.behaviorGroupHeader}>
                              <div>
                                <div className={styles.behaviorGroupTitle}>{group.label}</div>
                                <div className={styles.behaviorGroupDescription}>{group.description}</div>
                              </div>
                            </div>

                            {group.code === 'timesheet.workflow' && (
                              <div className={styles.behaviorHintList}>
                                {TIMESHEET_ROLE_HINTS.map((hint) => (
                                  <div key={hint} className={styles.behaviorHintItem}>{hint}</div>
                                ))}
                              </div>
                            )}

                            <div className={styles.segmentedControl}>
                              {group.exclusive && (
                                <button
                                  type="button"
                                  className={`${styles.segmentedButton} ${selectedCode === null ? styles.segmentedButtonActive : ''}`}
                                  onClick={() => handlePermissionChange(group, null)}
                                >
                                  Не выбрано
                                </button>
                              )}
                              {!group.exclusive && (
                                <button
                                  type="button"
                                  className={styles.segmentedButton}
                                  onClick={() => handlePermissionChange(group, null)}
                                >
                                  Сбросить
                                </button>
                              )}
                              {group.options.map((option) => {
                                const isActive = group.exclusive
                                  ? selectedCode === option.code
                                  : hasPermissionSelection(draftPermissions, option.code);

                                return (
                                  <button
                                    key={option.code}
                                    type="button"
                                    className={`${styles.segmentedButton} ${isActive ? styles.segmentedButtonActive : ''}`}
                                    onClick={() => handlePermissionChange(group, option.code)}
                                    title={option.description}
                                  >
                                    {option.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {groupedPages.map((group) => (
                    <div key={group.code} className={styles.card}>
                      <div className={styles.cardHeader}>
                        <h3 className={styles.cardTitle}>{group.label}</h3>
                      </div>

                      <div className={styles.pageRows}>
                        {group.pages.map((page) => (
                          <div key={page.key} className={styles.pageRow}>
                            <div className={styles.pageInfo}>
                              <div className={styles.pageLabelRow}>
                                <span className={styles.pageLabel}>{page.label}</span>
                                {!page.supports_edit && (
                                  <span className={styles.readOnlyBadge}>Только просмотр</span>
                                )}
                              </div>
                              <code className={styles.pagePath}>{page.key}</code>
                            </div>
                            {renderAccessControl(page)}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  {technicalPages.length > 0 && (
                    <details className={styles.card}>
                      <summary className={styles.technicalSummary}>
                        Технические доступы
                        <span className={styles.technicalSummaryHint}>
                          {accessSummary.technicalCount > 0
                            ? `${accessSummary.technicalCount} активн.`
                            : 'скрыты по умолчанию'}
                        </span>
                      </summary>

                      <div className={styles.pageRows}>
                        {technicalPages.map((page) => (
                          <div key={page.key} className={styles.pageRow}>
                            <div className={styles.pageInfo}>
                              <div className={styles.pageLabelRow}>
                                <span className={styles.pageLabel}>{page.label}</span>
                                <span className={styles.technicalBadge}>Технический ключ</span>
                              </div>
                              <code className={styles.pagePath}>{page.key}</code>
                            </div>
                            {renderAccessControl(page)}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
