import { useEffect, useMemo, useState } from 'react';
import type { FC } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { rolesService } from '../../services/rolesService';
import type { AccessMode, PageCatalogItem } from '../../services/rolesService';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import type { SystemRole, EmployeeVariant } from '../../types';
import styles from './RoleManagementPage.module.css';

type Tab = 'roles' | 'access';

interface INewRoleForm {
  code: string;
  name: string;
  is_admin: boolean;
  employee_variant: EmployeeVariant | '';
  show_actual_hours: boolean;
}

interface ICloneRoleForm {
  code: string;
  name: string;
  description: string;
  is_admin: boolean;
  employee_variant: EmployeeVariant | '';
  show_actual_hours: boolean;
}

interface IEditState {
  code: string;
  name: string;
  is_admin: boolean;
  employee_variant: EmployeeVariant | '';
  show_actual_hours: boolean;
}

interface IPageGroup {
  code: string;
  label: string;
  pages: PageCatalogItem[];
}

const EMPTY_ROLES: SystemRole[] = [];
const ACCESS_OPTIONS: AccessMode[] = ['none', 'view', 'edit'];

const serializePageAccess = (pageAccess: Record<string, AccessMode> | undefined): string =>
  JSON.stringify(
    Object.entries(pageAccess ?? {})
      .filter(([, mode]) => mode !== 'none')
      .sort(([l], [r]) => l.localeCompare(r, 'ru')),
  );

const toRoleCode = (value: string): string => value.toLowerCase().replace(/[^a-z_]/g, '');

const employeeVariantLabel = (variant: EmployeeVariant | null): string => {
  if (variant === 'object') return 'Рабочий';
  if (variant === 'office') return 'Офис';
  return '—';
};

interface IHoursToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  withLabels?: boolean;
  title?: string;
}

const HoursToggle: FC<IHoursToggleProps> = ({ checked, onChange, withLabels = true, title }) => (
  <label className={styles.hoursToggle} title={title}>
    {withLabels && (
      <span className={checked ? undefined : styles.hoursToggleLabelOff}>урезано</span>
    )}
    <input
      type="checkbox"
      checked={checked}
      onChange={e => onChange(e.target.checked)}
    />
    <span className={styles.hoursToggleTrack} />
    {withLabels && (
      <span className={checked ? styles.hoursToggleLabelOn : undefined}>факт</span>
    )}
  </label>
);

export const RoleManagementPage: FC = () => {
  const toast = useToast();
  const { refreshProfile } = useAuth();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>('roles');
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<INewRoleForm>({
    code: '',
    name: '',
    is_admin: false,
    employee_variant: '',
    show_actual_hours: false,
  });
  const [editState, setEditState] = useState<IEditState | null>(null);
  const [savingRole, setSavingRole] = useState(false);

  const [roleSearch, setRoleSearch] = useState('');
  const [selectedRoleCode, setSelectedRoleCode] = useState<string | null>(null);
  const [draftPageAccess, setDraftPageAccess] = useState<Record<string, AccessMode>>({});
  const [savingAccess, setSavingAccess] = useState(false);
  const [showCloneForm, setShowCloneForm] = useState(false);
  const [cloneForm, setCloneForm] = useState<ICloneRoleForm>({
    code: '',
    name: '',
    description: '',
    is_admin: false,
    employee_variant: '',
    show_actual_hours: false,
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
    () => [...roles].sort((l, r) => Number(r.is_admin) - Number(l.is_admin) || l.name.localeCompare(r.name, 'ru')),
    [roles],
  );

  const filteredRoles = useMemo(() => {
    const query = roleSearch.trim().toLowerCase();
    if (!query) return sortedRoles;
    return sortedRoles.filter(r => r.name.toLowerCase().includes(query) || r.code.toLowerCase().includes(query));
  }, [roleSearch, sortedRoles]);

  useEffect(() => {
    if (!sortedRoles.length) {
      setSelectedRoleCode(null);
      return;
    }
    if (!selectedRoleCode || !sortedRoles.some(r => r.code === selectedRoleCode)) {
      setSelectedRoleCode(sortedRoles[0].code);
    }
  }, [selectedRoleCode, sortedRoles]);

  const selectedRole = useMemo(
    () => sortedRoles.find(r => r.code === selectedRoleCode) ?? null,
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
    setDraftPageAccess(accessProfileQuery.data.page_access ?? {});
  }, [accessProfileQuery.data]);

  const pages = catalogQuery.data?.pages ?? [];
  const groupedPages = useMemo<IPageGroup[]>(() => {
    const groups = new Map<string, IPageGroup>();
    for (const page of pages.filter(p => p.surface === 'page')) {
      if (!groups.has(page.group_code)) {
        groups.set(page.group_code, { code: page.group_code, label: page.group_label, pages: [] });
      }
      groups.get(page.group_code)!.pages.push(page);
    }
    return [...groups.values()];
  }, [pages]);

  const technicalPages = useMemo(() => pages.filter(p => p.surface === 'technical'), [pages]);

  const accessSummary = useMemo(() => {
    const visible = pages.filter(p => p.surface === 'page');
    const viewCount = visible.filter(p => (draftPageAccess[p.key] ?? 'none') !== 'none').length;
    const editCount = visible.filter(p => (draftPageAccess[p.key] ?? 'none') === 'edit').length;
    const techCount = technicalPages.filter(p => (draftPageAccess[p.key] ?? 'none') !== 'none').length;
    return { totalPages: visible.length, viewCount, editCount, technicalCount: techCount };
  }, [draftPageAccess, pages, technicalPages]);

  const isAccessDirty = useMemo(() => {
    if (!accessProfileQuery.data) return false;
    return serializePageAccess(draftPageAccess) !== serializePageAccess(accessProfileQuery.data.page_access);
  }, [accessProfileQuery.data, draftPageAccess]);

  const upsertRoleInCache = (role: SystemRole) => {
    queryClient.setQueryData<SystemRole[]>(['roles', 'all'], (current) => {
      const list = current ?? [];
      const exists = list.some(i => i.code === role.code);
      return exists ? list.map(i => (i.code === role.code ? role : i)) : [...list, role];
    });
  };

  const removeRoleFromCache = (code: string) => {
    queryClient.setQueryData<SystemRole[]>(['roles', 'all'], (current) =>
      (current ?? []).filter(i => i.code !== code),
    );
    queryClient.removeQueries({ queryKey: ['roles', 'access-profile', code] });
  };

  const handleCreateRole = async () => {
    if (!newForm.code || !newForm.name) {
      toast.error('Заполните код и название роли');
      return;
    }
    setSavingRole(true);
    try {
      const createdRole = await rolesService.create({
        code: newForm.code,
        name: newForm.name,
        is_admin: newForm.is_admin,
        employee_variant: newForm.employee_variant || null,
        show_actual_hours: newForm.show_actual_hours,
      });
      toast.success('Роль создана');
      setNewForm({ code: '', name: '', is_admin: false, employee_variant: '', show_actual_hours: false });
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
    if (!editState.name) {
      toast.error('Заполните название роли');
      return;
    }
    setSavingRole(true);
    try {
      const updated = await rolesService.update(code, {
        name: editState.name,
        description: roles.find(r => r.code === code)?.description,
        is_admin: editState.is_admin,
        employee_variant: editState.employee_variant || null,
        show_actual_hours: editState.show_actual_hours,
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

  const handleToggleShowActualHours = async (role: SystemRole, next: boolean) => {
    try {
      const updated = await rolesService.update(role.code, {
        name: role.name,
        description: role.description,
        is_admin: role.is_admin,
        employee_variant: role.employee_variant,
        is_active: role.is_active,
        show_actual_hours: next,
      });
      toast.success(next ? 'Роль показывает факт по СКУД' : 'Роль показывает урезанные часы');
      upsertRoleInCache(updated);
      await refreshProfile();
      // refreshProfile уже инвалидирует timesheet-queries; дублируем явно — на случай,
      // если админ переключает свою же роль, находясь на странице табеля.
      queryClient.invalidateQueries({ queryKey: ['timesheet-page'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка изменения часов роли');
    }
  };

  const handleToggleActive = async (role: SystemRole) => {
    try {
      const updated = await rolesService.update(role.code, {
        name: role.name,
        description: role.description,
        is_admin: role.is_admin,
        employee_variant: role.employee_variant,
        is_active: !role.is_active,
        show_actual_hours: role.show_actual_hours,
      });
      toast.success(role.is_active ? 'Роль деактивирована' : 'Роль активирована');
      upsertRoleInCache(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка изменения статуса роли');
    }
  };

  const handleDeleteRole = async (code: string) => {
    if (!confirm(`Удалить роль "${code}"? Действие необратимо.`)) return;
    try {
      await rolesService.deleteRole(code);
      toast.success('Роль удалена');
      if (selectedRoleCode === code) setSelectedRoleCode(null);
      removeRoleFromCache(code);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка удаления роли');
    }
  };

  const handlePageModeChange = (page: PageCatalogItem, mode: AccessMode) => {
    const nextMode = page.supports_edit ? mode : (mode === 'edit' ? 'view' : mode);
    setDraftPageAccess((current) => {
      if (nextMode === 'none') {
        const next = { ...current };
        delete next[page.key];
        return next;
      }
      return { ...current, [page.key]: nextMode };
    });
  };

  const handleSaveAccess = async () => {
    if (!selectedRoleCode) return;
    setSavingAccess(true);
    try {
      await rolesService.updateAccessProfile(selectedRoleCode, { page_access: draftPageAccess });
      toast.success('Профиль доступа сохранён');
      await queryClient.invalidateQueries({ queryKey: ['roles', 'access-profile', selectedRoleCode] });
      await refreshProfile();
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
      description: selectedRole.description ?? '',
      is_admin: selectedRole.is_admin,
      employee_variant: selectedRole.employee_variant ?? '',
      show_actual_hours: selectedRole.show_actual_hours,
    });
    setShowCloneForm(true);
  };

  const handleCloneRole = async () => {
    if (!selectedRole) return;
    if (!cloneForm.code || !cloneForm.name) {
      toast.error('Заполните код и название для новой роли');
      return;
    }
    setSavingRole(true);
    try {
      const createdRole = await rolesService.cloneRole(selectedRole.code, {
        code: cloneForm.code,
        name: cloneForm.name,
        description: cloneForm.description || null,
        is_admin: cloneForm.is_admin,
        employee_variant: cloneForm.employee_variant || null,
        show_actual_hours: cloneForm.show_actual_hours,
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
    const options = page.supports_edit ? ACCESS_OPTIONS : ACCESS_OPTIONS.filter(m => m !== 'edit');
    return (
      <div className={styles.segmentedControl}>
        {options.map(mode => (
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
        >Роли</button>
        <button
          className={`${styles.tab} ${tab === 'access' ? styles.tabActive : ''}`}
          onClick={() => setTab('access')}
        >Доступ к страницам</button>
      </div>

      {rolesQuery.isError && <div className={styles.loading}>Ошибка загрузки ролей</div>}

      {tab === 'roles' && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Роли</h2>
              <p className={styles.sectionHint}>
                Флаг «Админ» — видит все данные, обходит фильтр по отделам. «Кабинет» — какой личный кабинет открывается на /employee. «Часы» — показывать пользователям фактическое время по СКУД (факт) или урезанное под плановую норму дня (урезано).
              </p>
            </div>
            <button className={styles.primaryButton} onClick={() => setShowNewForm(v => !v)}>
              {showNewForm ? 'Скрыть форму' : '+ Добавить роль'}
            </button>
          </div>

          {showNewForm && (
            <div className={styles.inlineForm}>
              <input
                className={styles.input}
                placeholder="Код роли (латиница, _)"
                value={newForm.code}
                onChange={e => setNewForm(s => ({ ...s, code: toRoleCode(e.target.value) }))}
              />
              <input
                className={styles.input}
                placeholder="Название"
                value={newForm.name}
                onChange={e => setNewForm(s => ({ ...s, name: e.target.value }))}
              />
              <label className={styles.inlineCheckbox}>
                <input
                  type="checkbox"
                  checked={newForm.is_admin}
                  onChange={e => setNewForm(s => ({ ...s, is_admin: e.target.checked }))}
                />
                <span>Админ (видит все данные)</span>
              </label>
              <HoursToggle
                checked={newForm.show_actual_hours}
                onChange={v => setNewForm(s => ({ ...s, show_actual_hours: v }))}
                title="Показывать часы по СКУД без обрезки до плановой нормы дня"
              />
              <select
                className={styles.input}
                value={newForm.employee_variant}
                onChange={e => setNewForm(s => ({ ...s, employee_variant: e.target.value as EmployeeVariant | '' }))}
              >
                <option value="">Без кабинета /employee</option>
                <option value="office">Офис</option>
                <option value="object">Рабочий (объект)</option>
              </select>
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
                    <th>Админ</th>
                    <th title="Включено — пользователи роли видят часы по СКУД без урезания под плановую норму дня">Часы</th>
                    <th title="Какой личный кабинет открывается у пользователей этой роли на /employee">Кабинет</th>
                    <th>Статус</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRoles.map(role => (
                    <tr key={role.code} className={!role.is_active ? styles.rowInactive : ''}>
                      <td><code className={styles.code}>{role.code}</code></td>
                      <td>
                        {editState?.code === role.code ? (
                          <input
                            className={styles.inputInline}
                            value={editState.name}
                            onChange={e => setEditState(s => (s ? { ...s, name: e.target.value } : s))}
                            autoFocus
                          />
                        ) : role.name}
                      </td>
                      <td>
                        {editState?.code === role.code ? (
                          <input
                            type="checkbox"
                            checked={editState.is_admin}
                            onChange={e => setEditState(s => (s ? { ...s, is_admin: e.target.checked } : s))}
                          />
                        ) : (role.is_admin ? '✓' : '—')}
                      </td>
                      <td title={role.show_actual_hours ? 'факт по СКУД' : 'урезано под график'}>
                        <HoursToggle
                          checked={editState?.code === role.code ? editState.show_actual_hours : role.show_actual_hours}
                          onChange={v => {
                            if (editState?.code === role.code) {
                              setEditState(s => (s ? { ...s, show_actual_hours: v } : s));
                            } else {
                              void handleToggleShowActualHours(role, v);
                            }
                          }}
                          withLabels={false}
                        />
                      </td>
                      <td>
                        {editState?.code === role.code ? (
                          <select
                            className={styles.inputInline}
                            value={editState.employee_variant}
                            onChange={e => setEditState(s => (s ? { ...s, employee_variant: e.target.value as EmployeeVariant | '' } : s))}
                          >
                            <option value="">—</option>
                            <option value="office">office</option>
                            <option value="object">object</option>
                          </select>
                        ) : employeeVariantLabel(role.employee_variant)}
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
                                  is_admin: role.is_admin,
                                  employee_variant: role.employee_variant ?? '',
                                  show_actual_hours: role.show_actual_hours,
                                })
                              }
                            >Изменить</button>
                            {role.code !== 'admin' && (
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
              onChange={e => setRoleSearch(e.target.value)}
              placeholder="Поиск по коду или названию"
            />
            <div className={styles.roleList}>
              {filteredRoles.map(role => (
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
                    {role.is_admin && <span>• админ</span>}
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
                      Матрица доступа по страницам. Админы обходят этот фильтр автоматически.
                    </p>
                  </div>
                  <div className={styles.toolbarActions}>
                    <button className={styles.secondaryButton} onClick={openCloneForm}>
                      Создать на основе этой
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
                      onChange={e => setCloneForm(s => ({ ...s, code: toRoleCode(e.target.value) }))}
                    />
                    <input
                      className={styles.input}
                      placeholder="Новое название"
                      value={cloneForm.name}
                      onChange={e => setCloneForm(s => ({ ...s, name: e.target.value }))}
                    />
                    <label className={styles.inlineCheckbox}>
                      <input
                        type="checkbox"
                        checked={cloneForm.is_admin}
                        onChange={e => setCloneForm(s => ({ ...s, is_admin: e.target.checked }))}
                      />
                      <span>Админ</span>
                    </label>
                    <HoursToggle
                      checked={cloneForm.show_actual_hours}
                      onChange={v => setCloneForm(s => ({ ...s, show_actual_hours: v }))}
                      title="Показывать часы по СКУД без обрезки до плановой нормы дня"
                    />
                    <select
                      className={styles.input}
                      value={cloneForm.employee_variant}
                      onChange={e => setCloneForm(s => ({ ...s, employee_variant: e.target.value as EmployeeVariant | '' }))}
                    >
                      <option value="">Без кабинета /employee</option>
                      <option value="office">Офис</option>
                      <option value="object">Рабочий</option>
                    </select>
                    <input
                      className={styles.input}
                      placeholder="Описание (необязательно)"
                      value={cloneForm.description}
                      onChange={e => setCloneForm(s => ({ ...s, description: e.target.value }))}
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
                    <span>Страниц</span><strong>{accessSummary.totalPages}</strong>
                  </div>
                  <div className={styles.summaryCard}>
                    <span>С просмотром</span><strong>{accessSummary.viewCount}</strong>
                  </div>
                  <div className={styles.summaryCard}>
                    <span>С изменением</span><strong>{accessSummary.editCount}</strong>
                  </div>
                  <div className={styles.summaryCard}>
                    <span>Технические</span><strong>{accessSummary.technicalCount}</strong>
                  </div>
                </div>

                <div className={styles.accessSections}>
                  {groupedPages.map(group => (
                    <div key={group.code} className={styles.card}>
                      <div className={styles.cardHeader}>
                        <h3 className={styles.cardTitle}>{group.label}</h3>
                      </div>
                      <div className={styles.pageRows}>
                        {group.pages.map(page => (
                          <div key={page.key} className={styles.pageRow}>
                            <div className={styles.pageInfo}>
                              <div className={styles.pageLabelRow}>
                                <span className={styles.pageLabel}>{page.label}</span>
                                {!page.supports_edit && <span className={styles.readOnlyBadge}>Только просмотр</span>}
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
                        {technicalPages.map(page => (
                          <div key={page.key} className={styles.pageRow}>
                            <div className={styles.pageInfo}>
                              <div className={styles.pageLabelRow}>
                                <span className={styles.pageLabel}>{page.label}</span>
                                <span className={styles.technicalBadge}>Технический ключ</span>
                              </div>
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
