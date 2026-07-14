import { useEffect, useMemo, useState } from 'react';
import type { FC } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { rolesService } from '../../services/rolesService';
import type { AccessMode, AccessPageArea, PageCatalogItem } from '../../services/rolesService';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import type { SystemRole, EmployeeVariant } from '../../types';
import styles from './RoleManagementPage.module.css';

type Tab = 'roles' | 'access';

interface ICorrectionRestrictionsForm {
  corrections_anomalies_only: boolean;
  corrections_cap_by_schedule_norm: boolean;
  corrections_allow_zero_short_attendance: boolean;
  corrections_disable_bulk: boolean;
  corrections_disable_object_entries: boolean;
  max_corrections_per_month: number | null;
  max_corrections_unlimited: boolean;
  weekend_memo_required: boolean;
}

interface INewRoleForm extends ICorrectionRestrictionsForm {
  code: string;
  name: string;
  is_admin: boolean;
  admin_access: boolean;
  employee_variant: EmployeeVariant | '';
  show_actual_hours: boolean;
  hide_sidebar: boolean;
  timesheet_months_back: number;
  timesheet_months_forward: number;
  timesheet_show_full_period: boolean;
}

interface ICloneRoleForm extends ICorrectionRestrictionsForm {
  code: string;
  name: string;
  description: string;
  is_admin: boolean;
  admin_access: boolean;
  employee_variant: EmployeeVariant | '';
  show_actual_hours: boolean;
  hide_sidebar: boolean;
  timesheet_months_back: number;
  timesheet_months_forward: number;
  timesheet_show_full_period: boolean;
}

interface IEditState extends ICorrectionRestrictionsForm {
  code: string;
  name: string;
  is_admin: boolean;
  employee_variant: EmployeeVariant | '';
  show_actual_hours: boolean;
  hide_sidebar: boolean;
  timesheet_months_back: number;
  timesheet_months_forward: number;
  timesheet_show_full_period: boolean;
}

const DEFAULT_CORRECTION_RESTRICTIONS: ICorrectionRestrictionsForm = {
  corrections_anomalies_only: false,
  corrections_cap_by_schedule_norm: false,
  corrections_allow_zero_short_attendance: false,
  corrections_disable_bulk: false,
  corrections_disable_object_entries: false,
  max_corrections_per_month: null,
  max_corrections_unlimited: true,
  weekend_memo_required: false,
};

const correctionRestrictionsFromRole = (role: SystemRole): ICorrectionRestrictionsForm => ({
  corrections_anomalies_only: role.corrections_anomalies_only ?? false,
  corrections_cap_by_schedule_norm: role.corrections_cap_by_schedule_norm ?? false,
  corrections_allow_zero_short_attendance: role.corrections_allow_zero_short_attendance ?? false,
  corrections_disable_bulk: role.corrections_disable_bulk ?? false,
  corrections_disable_object_entries: role.corrections_disable_object_entries ?? false,
  max_corrections_per_month: role.max_corrections_per_month ?? null,
  max_corrections_unlimited: role.max_corrections_per_month == null,
  weekend_memo_required: role.weekend_memo_required ?? false,
});

const correctionRestrictionsToPayload = (form: ICorrectionRestrictionsForm) => ({
  corrections_anomalies_only: form.corrections_anomalies_only,
  corrections_cap_by_schedule_norm: form.corrections_cap_by_schedule_norm,
  corrections_allow_zero_short_attendance: form.corrections_anomalies_only && form.corrections_allow_zero_short_attendance,
  corrections_disable_bulk: form.corrections_disable_bulk,
  corrections_disable_object_entries: form.corrections_disable_object_entries,
  max_corrections_per_month: form.max_corrections_unlimited ? null : Math.max(0, Math.floor(form.max_corrections_per_month ?? 0)),
  weekend_memo_required: form.weekend_memo_required,
});

const TIMESHEET_MONTHS_MIN = 0;
const TIMESHEET_MONTHS_MAX = 12;

const clampTimesheetMonths = (value: unknown): number => {
  const num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) return 1;
  return Math.max(TIMESHEET_MONTHS_MIN, Math.min(TIMESHEET_MONTHS_MAX, Math.floor(num)));
};

interface IPageGroup {
  code: string;
  label: string;
  pages: PageCatalogItem[];
}

/** Страницы одной области (ЛК / админка), сгруппированные по блокам каталога. */
const groupPagesByArea = (pages: PageCatalogItem[], area: AccessPageArea): IPageGroup[] => {
  const groups = new Map<string, IPageGroup>();
  for (const page of pages.filter(p => p.surface === 'page' && p.area === area)) {
    if (!groups.has(page.group_code)) {
      groups.set(page.group_code, { code: page.group_code, label: page.group_label, pages: [] });
    }
    groups.get(page.group_code)!.pages.push(page);
  }
  return [...groups.values()];
};

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
  if (variant === 'contractor') return 'Подрядчик';
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

interface ICorrectionRestrictionsBlockProps {
  value: ICorrectionRestrictionsForm;
  onChange: (next: ICorrectionRestrictionsForm) => void;
}

const CorrectionRestrictionsBlock: FC<ICorrectionRestrictionsBlockProps> = ({ value, onChange }) => {
  const patch = (p: Partial<ICorrectionRestrictionsForm>) => onChange({ ...value, ...p });
  const anomaliesOff = !value.corrections_anomalies_only;
  return (
    <fieldset className={styles.restrictionsFieldset}>
      <legend className={styles.restrictionsLegend}>Ограничения корректировок табеля</legend>
      <label className={styles.inlineCheckbox} title="Корректировка с часами больше нуля разрешена только в дни-аномалии СКУД: orphan exit, незакрытый entry, ошибки СКУД, пропуск скана при рабочем дне.">
        <input
          type="checkbox"
          checked={value.corrections_anomalies_only}
          onChange={e => patch({ corrections_anomalies_only: e.target.checked })}
        />
        <span>Только в дни-аномалии СКУД</span>
      </label>
      <label className={styles.inlineCheckbox} title="hours_override корректировки не может превысить плановые часы дня (с учётом графика и предпраздничного −1ч).">
        <input
          type="checkbox"
          checked={value.corrections_cap_by_schedule_norm}
          onChange={e => patch({ corrections_cap_by_schedule_norm: e.target.checked })}
        />
        <span>Не больше плановых часов дня</span>
      </label>
      <label className={styles.inlineCheckbox} title="Разрешает обнуление дня (hours=0), если день рабочий по графику и фактически по СКУД явка меньше 4 часов. Имеет смысл только при «Только аномалии».">
        <input
          type="checkbox"
          checked={value.corrections_allow_zero_short_attendance}
          disabled={anomaliesOff}
          onChange={e => patch({ corrections_allow_zero_short_attendance: e.target.checked })}
        />
        <span>Разрешить обнуление дня при явке &lt; 4ч{anomaliesOff && ' (зависит от «Только аномалии»)'}</span>
      </label>
      <label className={styles.inlineCheckbox} title="Запрещает POST /api/timesheet/bulk — массовое сохранение корректировок для этой роли.">
        <input
          type="checkbox"
          checked={value.corrections_disable_bulk}
          onChange={e => patch({ corrections_disable_bulk: e.target.checked })}
        />
        <span>Запретить массовое редактирование</span>
      </label>
      <label className={styles.inlineCheckbox} title="Запрещает корректировки на вкладке «По объектам» (внесение/изменение/удаление). Вкладка «По сотрудникам» не затрагивается.">
        <input
          type="checkbox"
          checked={value.corrections_disable_object_entries}
          onChange={e => patch({ corrections_disable_object_entries: e.target.checked })}
        />
        <span>Запретить корректировки по объектам</span>
      </label>
      <label className={styles.inlineCheckbox} title="Лимит корректировок аномалий per (создатель, сотрудник, календарный месяц). Имеет смысл только при «Только аномалии».">
        <span>Лимит аномалий/мес</span>
        <input
          type="number"
          min={0}
          className={styles.inputInline}
          disabled={anomaliesOff || value.max_corrections_unlimited}
          value={value.max_corrections_per_month ?? ''}
          onChange={e => {
            const raw = e.target.value;
            patch({
              max_corrections_per_month: raw === '' ? null : Math.max(0, Math.floor(Number(raw) || 0)),
            });
          }}
        />
        <label className={styles.inlineCheckbox}>
          <input
            type="checkbox"
            disabled={anomaliesOff}
            checked={value.max_corrections_unlimited}
            onChange={e => patch({
              max_corrections_unlimited: e.target.checked,
              max_corrections_per_month: e.target.checked ? null : (value.max_corrections_per_month ?? 0),
            })}
          />
          <span>Неограниченно</span>
        </label>
      </label>
      <label className={styles.inlineCheckbox} title="Подача табеля с работой в выходные/праздники требует прикреплённой служебки (файл-подтверждение); открывает кнопку «приложить файл» и доступ к xlsx-шаблону служебки.">
        <input
          type="checkbox"
          checked={value.weekend_memo_required}
          onChange={e => patch({ weekend_memo_required: e.target.checked })}
        />
        <span>Требовать служебку о работе в выходные</span>
      </label>
    </fieldset>
  );
};

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
    admin_access: false,
    employee_variant: '',
    show_actual_hours: false,
    hide_sidebar: false,
    timesheet_months_back: 1,
    timesheet_months_forward: 1,
    timesheet_show_full_period: true,
    ...DEFAULT_CORRECTION_RESTRICTIONS,
  });
  const [editState, setEditState] = useState<IEditState | null>(null);
  const [savingRole, setSavingRole] = useState(false);
  const [restrictionsModalCode, setRestrictionsModalCode] = useState<string | null>(null);
  const [restrictionsForm, setRestrictionsForm] = useState<ICorrectionRestrictionsForm>(DEFAULT_CORRECTION_RESTRICTIONS);
  const [savingRestrictions, setSavingRestrictions] = useState(false);
  const newRoleOverlay = useOverlayDismiss(() => setShowNewForm(false));
  const restrictionsOverlay = useOverlayDismiss(() => setRestrictionsModalCode(null));

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
    admin_access: false,
    employee_variant: '',
    show_actual_hours: false,
    hide_sidebar: false,
    timesheet_months_back: 1,
    timesheet_months_forward: 1,
    timesheet_show_full_period: true,
    ...DEFAULT_CORRECTION_RESTRICTIONS,
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

  const pages = useMemo<PageCatalogItem[]>(() => catalogQuery.data?.pages ?? [], [catalogQuery.data]);
  const personalGroups = useMemo<IPageGroup[]>(() => groupPagesByArea(pages, 'personal'), [pages]);
  const adminGroups = useMemo<IPageGroup[]>(() => groupPagesByArea(pages, 'admin'), [pages]);

  const technicalPages = useMemo(() => pages.filter(p => p.surface === 'technical'), [pages]);

  const accessSummary = useMemo(() => {
    const visible = pages.filter(p => p.surface === 'page');
    const viewCount = visible.filter(p => (draftPageAccess[p.key] ?? 'none') !== 'none').length;
    const editCount = visible.filter(p => (draftPageAccess[p.key] ?? 'none') === 'edit').length;
    const techCount = technicalPages.filter(p => (draftPageAccess[p.key] ?? 'none') !== 'none').length;
    return { totalPages: visible.length, viewCount, editCount, technicalCount: techCount };
  }, [draftPageAccess, pages, technicalPages]);

  // Админ-роль всегда в админке; для остальных решает флаг admin_access (миграция 221).
  const roleHasAdminArea = !!selectedRole?.is_admin || !!selectedRole?.admin_access;
  const adminAccessCount = useMemo(
    () => pages.filter(p => p.area === 'admin' && (draftPageAccess[p.key] ?? 'none') !== 'none').length,
    [draftPageAccess, pages],
  );

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
        admin_access: newForm.admin_access,
        employee_variant: newForm.employee_variant || null,
        show_actual_hours: newForm.show_actual_hours,
        hide_sidebar: newForm.hide_sidebar,
        timesheet_months_back: clampTimesheetMonths(newForm.timesheet_months_back),
        timesheet_months_forward: clampTimesheetMonths(newForm.timesheet_months_forward),
        timesheet_show_full_period: newForm.timesheet_show_full_period,
        ...correctionRestrictionsToPayload(newForm),
      });
      toast.success('Роль создана');
      setNewForm({
        code: '', name: '', is_admin: false, admin_access: false, employee_variant: '',
        show_actual_hours: false, hide_sidebar: false,
        timesheet_months_back: 1, timesheet_months_forward: 1,
        timesheet_show_full_period: true,
        ...DEFAULT_CORRECTION_RESTRICTIONS,
      });
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
        hide_sidebar: editState.hide_sidebar,
        timesheet_months_back: clampTimesheetMonths(editState.timesheet_months_back),
        timesheet_months_forward: clampTimesheetMonths(editState.timesheet_months_forward),
        timesheet_show_full_period: editState.timesheet_show_full_period,
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
        hide_sidebar: role.hide_sidebar,
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

  const handleToggleShowFullPeriod = async (role: SystemRole, next: boolean) => {
    try {
      const updated = await rolesService.update(role.code, {
        name: role.name,
        description: role.description,
        is_admin: role.is_admin,
        employee_variant: role.employee_variant,
        is_active: role.is_active,
        show_actual_hours: role.show_actual_hours,
        hide_sidebar: role.hide_sidebar,
        timesheet_show_full_period: next,
      });
      toast.success(next ? '«Весь месяц» доступен роли' : '«Весь месяц» скрыт у роли');
      upsertRoleInCache(updated);
      await refreshProfile();
      queryClient.invalidateQueries({ queryKey: ['timesheet-page'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка изменения периода роли');
    }
  };

  // Доступ в админку. Выключение — жёсткое: бэк вырезает все админ-ключи роли,
  // пользователь остаётся в личном кабинете.
  const handleToggleAdminAccess = async (role: SystemRole, next: boolean) => {
    if (!next) {
      const adminPages = pages.filter(p => p.area === 'admin' && (draftPageAccess[p.key] ?? 'none') !== 'none');
      const confirmed = confirm(
        adminPages.length > 0
          ? `Роль потеряет доступ ко всем страницам админки (${adminPages.length} шт.) и останется только с личным кабинетом. Продолжить?`
          : 'Закрыть роли доступ в админку?',
      );
      if (!confirmed) return;
    }
    try {
      const updated = await rolesService.update(role.code, {
        name: role.name,
        description: role.description,
        is_admin: role.is_admin,
        employee_variant: role.employee_variant,
        is_active: role.is_active,
        show_actual_hours: role.show_actual_hours,
        hide_sidebar: role.hide_sidebar,
        admin_access: next,
      });
      if (!next) {
        // Локально гасим админ-галки, чтобы черновик не расходился с тем, что сохранит бэк.
        setDraftPageAccess(current => Object.fromEntries(
          Object.entries(current).filter(([key]) => pages.find(p => p.key === key)?.area !== 'admin'),
        ));
      }
      toast.success(next ? 'Роль получила доступ в админку' : 'Роль заперта в личном кабинете');
      upsertRoleInCache(updated);
      await queryClient.invalidateQueries({ queryKey: ['roles', 'access-profile', role.code] });
      await refreshProfile();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка изменения доступа в админку');
    }
  };

  const handleToggleManagerAutoAccess = async (role: SystemRole, next: boolean) => {
    try {
      const updated = await rolesService.update(role.code, {
        name: role.name,
        description: role.description,
        is_admin: role.is_admin,
        employee_variant: role.employee_variant,
        is_active: role.is_active,
        show_actual_hours: role.show_actual_hours,
        hide_sidebar: role.hide_sidebar,
        manager_auto_access: next,
      });
      toast.success(next
        ? 'Авто-доступ руководителя включён'
        : 'Авто-доступ руководителя выключен: страницы выдаёт только роль');
      upsertRoleInCache(updated);
      await refreshProfile();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка изменения авто-доступа');
    }
  };

  const handleToggleHideSidebar = async (role: SystemRole, next: boolean) => {
    try {
      const updated = await rolesService.update(role.code, {
        name: role.name,
        description: role.description,
        is_admin: role.is_admin,
        employee_variant: role.employee_variant,
        is_active: role.is_active,
        show_actual_hours: role.show_actual_hours,
        hide_sidebar: next,
      });
      toast.success(next ? 'Боковое меню скрыто для роли' : 'Боковое меню видно у роли');
      upsertRoleInCache(updated);
      await refreshProfile();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка изменения видимости меню');
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
        hide_sidebar: role.hide_sidebar,
      });
      toast.success(role.is_active ? 'Роль деактивирована' : 'Роль активирована');
      upsertRoleInCache(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка изменения статуса роли');
    }
  };

  const openRestrictionsModal = (role: SystemRole) => {
    setRestrictionsModalCode(role.code);
    setRestrictionsForm(correctionRestrictionsFromRole(role));
  };

  const handleSaveRestrictions = async () => {
    if (!restrictionsModalCode) return;
    const role = roles.find(r => r.code === restrictionsModalCode);
    if (!role) return;
    setSavingRestrictions(true);
    try {
      const updated = await rolesService.update(role.code, {
        name: role.name,
        description: role.description,
        is_admin: role.is_admin,
        employee_variant: role.employee_variant,
        is_active: role.is_active,
        show_actual_hours: role.show_actual_hours,
        hide_sidebar: role.hide_sidebar,
        ...correctionRestrictionsToPayload(restrictionsForm),
      });
      toast.success('Ограничения корректировок сохранены');
      upsertRoleInCache(updated);
      setRestrictionsModalCode(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Ошибка сохранения ограничений');
    } finally {
      setSavingRestrictions(false);
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
      // Роль без доступа в админку сохраняет только права личного кабинета.
      const payload = roleHasAdminArea
        ? draftPageAccess
        : Object.fromEntries(
          Object.entries(draftPageAccess).filter(([key]) => pages.find(p => p.key === key)?.area !== 'admin'),
        );
      await rolesService.updateAccessProfile(selectedRoleCode, { page_access: payload });
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
      admin_access: !!selectedRole.admin_access,
      employee_variant: selectedRole.employee_variant ?? '',
      show_actual_hours: selectedRole.show_actual_hours,
      hide_sidebar: selectedRole.hide_sidebar,
      timesheet_months_back: clampTimesheetMonths(selectedRole.timesheet_months_back),
      timesheet_months_forward: clampTimesheetMonths(selectedRole.timesheet_months_forward),
      timesheet_show_full_period: selectedRole.timesheet_show_full_period !== false,
      ...correctionRestrictionsFromRole(selectedRole),
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
        admin_access: cloneForm.admin_access,
        employee_variant: cloneForm.employee_variant || null,
        show_actual_hours: cloneForm.show_actual_hours,
        hide_sidebar: cloneForm.hide_sidebar,
        timesheet_months_back: clampTimesheetMonths(cloneForm.timesheet_months_back),
        timesheet_months_forward: clampTimesheetMonths(cloneForm.timesheet_months_forward),
        timesheet_show_full_period: cloneForm.timesheet_show_full_period,
        ...correctionRestrictionsToPayload(cloneForm),
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
    // Пока у роли нет доступа в админку, её админ-права не редактируются (бэк их всё равно вырежет).
    const locked = page.area === 'admin' && !roleHasAdminArea;
    return (
      <div className={styles.segmentedControl}>
        {options.map(mode => (
          <button
            key={`${page.key}-${mode}`}
            type="button"
            disabled={locked}
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
            <p className={styles.sectionHint}>
              Флаг «Админ» — видит все данные, обходит фильтр по отделам. «Кабинет» — тип личного кабинета: «Офис»/«Рабочий» открываются на /employee, «Подрядчик» — на /contractor. «Часы» — показывать пользователям фактическое время по СКУД (факт) или урезанное под плановую норму дня (урезано). «Окно ← / Окно →» — сколько месяцев назад и вперёд от текущего доступно для табеля; для админа не применяется.
            </p>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setShowNewForm(true)}
              title="Добавить роль"
              aria-label="Добавить роль"
            >
              <Plus size={18} />
            </button>
          </div>

          {showNewForm && (
            <div
              className={styles.modalOverlay}
              onMouseDown={newRoleOverlay.onMouseDown}
              onMouseUp={newRoleOverlay.onMouseUp}
              onMouseLeave={newRoleOverlay.onMouseLeave}
              onTouchStart={newRoleOverlay.onTouchStart}
              onTouchEnd={newRoleOverlay.onTouchEnd}
            >
              <div className={styles.modal}>
                <div className={styles.modalHeader}>
                  <h2 className={styles.modalTitle}>Новая роль</h2>
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={() => setShowNewForm(false)}
                    aria-label="Закрыть"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className={styles.modalBody}>
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
              <label className={styles.inlineCheckbox} title="Роль видит разделы вне личного кабинета. Без этого флага пользователь остаётся только в ЛК.">
                <input
                  type="checkbox"
                  checked={newForm.is_admin || newForm.admin_access}
                  disabled={newForm.is_admin}
                  onChange={e => setNewForm(s => ({ ...s, admin_access: e.target.checked }))}
                />
                <span>Доступ в админку</span>
              </label>
              <HoursToggle
                checked={newForm.show_actual_hours}
                onChange={v => setNewForm(s => ({ ...s, show_actual_hours: v }))}
                title="Показывать часы по СКУД без обрезки до плановой нормы дня"
              />
              <label className={styles.inlineCheckbox} title="Скрыть боковое меню у пользователей этой роли (админу игнорируется)">
                <input
                  type="checkbox"
                  checked={newForm.hide_sidebar}
                  onChange={e => setNewForm(s => ({ ...s, hide_sidebar: e.target.checked }))}
                />
                <span>Скрыть меню</span>
              </label>
              <select
                className={styles.input}
                value={newForm.employee_variant}
                onChange={e => setNewForm(s => ({ ...s, employee_variant: e.target.value as EmployeeVariant | '' }))}
              >
                <option value="">Без кабинета</option>
                <option value="office">Офис</option>
                <option value="object">Рабочий (объект)</option>
                <option value="contractor">Подрядчик</option>
              </select>
              <label className={styles.inlineCheckbox} title="Сколько месяцев назад от текущего доступно для табеля. Для админов окно не применяется.">
                <span>Окно назад, мес.</span>
                <input
                  type="number"
                  min={TIMESHEET_MONTHS_MIN}
                  max={TIMESHEET_MONTHS_MAX}
                  className={styles.inputInline}
                  value={newForm.timesheet_months_back}
                  onChange={e => setNewForm(s => ({ ...s, timesheet_months_back: clampTimesheetMonths(e.target.value) }))}
                />
              </label>
              <label className={styles.inlineCheckbox} title="Сколько месяцев вперёд от текущего доступно для табеля. Для админов окно не применяется.">
                <span>Окно вперёд, мес.</span>
                <input
                  type="number"
                  min={TIMESHEET_MONTHS_MIN}
                  max={TIMESHEET_MONTHS_MAX}
                  className={styles.inputInline}
                  value={newForm.timesheet_months_forward}
                  onChange={e => setNewForm(s => ({ ...s, timesheet_months_forward: clampTimesheetMonths(e.target.value) }))}
                />
              </label>
              <label className={styles.inlineCheckbox} title="Показывать кнопку «Весь месяц» в переключателе периода табеля. Если выключено — пользователям доступны только полумесячные периоды (1–15 и 16–N).">
                <input
                  type="checkbox"
                  checked={newForm.timesheet_show_full_period}
                  onChange={e => setNewForm(s => ({ ...s, timesheet_show_full_period: e.target.checked }))}
                />
                <span>Показывать «Весь месяц» в табеле</span>
              </label>
              <CorrectionRestrictionsBlock
                value={newForm}
                onChange={next => setNewForm(s => ({ ...s, ...next }))}
              />
                </div>
                <div className={styles.formActions}>
                  <button className={styles.successButton} onClick={handleCreateRole} disabled={savingRole}>
                    Создать
                  </button>
                  <button className={styles.secondaryButton} onClick={() => setShowNewForm(false)}>
                    Отмена
                  </button>
                </div>
              </div>
            </div>
          )}

          {restrictionsModalCode && (
            <div
              className={styles.modalOverlay}
              onMouseDown={restrictionsOverlay.onMouseDown}
              onMouseUp={restrictionsOverlay.onMouseUp}
              onMouseLeave={restrictionsOverlay.onMouseLeave}
              onTouchStart={restrictionsOverlay.onTouchStart}
              onTouchEnd={restrictionsOverlay.onTouchEnd}
            >
              <div className={styles.modal}>
                <div className={styles.modalHeader}>
                  <h2 className={styles.modalTitle}>
                    Ограничения корректировок — {roles.find(r => r.code === restrictionsModalCode)?.name ?? restrictionsModalCode}
                  </h2>
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={() => setRestrictionsModalCode(null)}
                    aria-label="Закрыть"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className={styles.modalBody}>
                  <CorrectionRestrictionsBlock
                    value={restrictionsForm}
                    onChange={setRestrictionsForm}
                  />
                </div>
                <div className={styles.formActions}>
                  <button
                    className={styles.successButton}
                    onClick={handleSaveRestrictions}
                    disabled={savingRestrictions}
                  >
                    {savingRestrictions ? 'Сохранение...' : 'Сохранить'}
                  </button>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setRestrictionsModalCode(null)}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            </div>
          )}

          {rolesQuery.isPending ? (
            <div className={styles.loading}>Загрузка...</div>
          ) : (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <colgroup>
                  <col className={styles.colCode} />
                  <col className={styles.colName} />
                  <col className={styles.colAdmin} />
                  <col className={styles.colHours} />
                  <col className={styles.colCabinet} />
                  <col className={styles.colWindow} />
                  <col className={styles.colWindow} />
                  <col className={styles.colFull} />
                  <col className={styles.colStatus} />
                  <col className={styles.colActions} />
                </colgroup>
                <thead>
                  <tr>
                    <th>Код</th>
                    <th>Название</th>
                    <th>Админ</th>
                    <th title="Включено — пользователи роли видят часы по СКУД без урезания под плановую норму дня">Часы</th>
                    <th title="Какой личный кабинет открывается у пользователей этой роли на /employee">Кабинет</th>
                    <th title="Сколько месяцев назад от текущего доступно для табеля (0–12). Для админов не применяется.">Окно ←</th>
                    <th title="Сколько месяцев вперёд от текущего доступно для табеля (0–12). Для админов не применяется.">Окно →</th>
                    <th title="Показывать кнопку «Весь месяц» в переключателе периода табеля. Если выключено — только полумесячные периоды (1–15 / 16–N).">Весь мес.</th>
                    <th>Статус</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRoles.map(role => (
                    <tr key={role.code} className={!role.is_active ? styles.rowInactive : ''}>
                      <td><code className={styles.code} title={role.code}>{role.code}</code></td>
                      <td>
                        {editState?.code === role.code ? (
                          <input
                            className={styles.cellControl}
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
                            className={styles.cellControl}
                            value={editState.employee_variant}
                            onChange={e => setEditState(s => (s ? { ...s, employee_variant: e.target.value as EmployeeVariant | '' } : s))}
                          >
                            <option value="">Без кабинета</option>
                            <option value="office">Офис</option>
                            <option value="object">Рабочий (объект)</option>
                            <option value="contractor">Подрядчик</option>
                          </select>
                        ) : employeeVariantLabel(role.employee_variant)}
                      </td>
                      <td>
                        {editState?.code === role.code ? (
                          <input
                            type="number"
                            min={TIMESHEET_MONTHS_MIN}
                            max={TIMESHEET_MONTHS_MAX}
                            className={`${styles.cellControl} ${styles.cellControlNum}`}
                            value={editState.timesheet_months_back}
                            onChange={e => setEditState(s => (s ? { ...s, timesheet_months_back: clampTimesheetMonths(e.target.value) } : s))}
                          />
                        ) : (clampTimesheetMonths(role.timesheet_months_back))}
                      </td>
                      <td>
                        {editState?.code === role.code ? (
                          <input
                            type="number"
                            min={TIMESHEET_MONTHS_MIN}
                            max={TIMESHEET_MONTHS_MAX}
                            className={`${styles.cellControl} ${styles.cellControlNum}`}
                            value={editState.timesheet_months_forward}
                            onChange={e => setEditState(s => (s ? { ...s, timesheet_months_forward: clampTimesheetMonths(e.target.value) } : s))}
                          />
                        ) : (clampTimesheetMonths(role.timesheet_months_forward))}
                      </td>
                      <td title={role.timesheet_show_full_period !== false ? '«Весь месяц» доступен' : 'Только 1–15 и 16–N'}>
                        <input
                          type="checkbox"
                          checked={editState?.code === role.code ? editState.timesheet_show_full_period : role.timesheet_show_full_period !== false}
                          onChange={e => {
                            if (editState?.code === role.code) {
                              setEditState(s => (s ? { ...s, timesheet_show_full_period: e.target.checked } : s));
                            } else {
                              void handleToggleShowFullPeriod(role, e.target.checked);
                            }
                          }}
                        />
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
                                  hide_sidebar: role.hide_sidebar,
                                  timesheet_months_back: clampTimesheetMonths(role.timesheet_months_back),
                                  timesheet_months_forward: clampTimesheetMonths(role.timesheet_months_forward),
                                  timesheet_show_full_period: role.timesheet_show_full_period !== false,
                                  ...correctionRestrictionsFromRole(role),
                                })
                              }
                            >Изменить</button>
                            <button
                              className={styles.secondaryButton}
                              title="Ограничения корректировок табеля"
                              onClick={() => openRestrictionsModal(role)}
                            >
                              Огр.
                            </button>
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

                {showCloneForm && selectedRole && (() => {
                  const cloneOverlayHandlers = useOverlayDismiss(() => setShowCloneForm(false));
                  return (
                    <div className={styles.modalOverlay} {...cloneOverlayHandlers}>
                      <div className={styles.modal} onClick={e => e.stopPropagation()}>
                        <div className={styles.modalHeader}>
                          <h2 className={styles.modalTitle}>
                            Копия роли «{selectedRole.name}»
                          </h2>
                          <button
                            className={styles.closeButton}
                            onClick={() => setShowCloneForm(false)}
                            aria-label="Закрыть"
                          >
                            ×
                          </button>
                        </div>

                        <div className={styles.cloneModalBody}>
                          <div className={styles.cloneFormRow}>
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
                          </div>

                          <div className={styles.cloneFormRow}>
                            <select
                              className={styles.input}
                              value={cloneForm.employee_variant}
                              onChange={e => setCloneForm(s => ({ ...s, employee_variant: e.target.value as EmployeeVariant | '' }))}
                            >
                              <option value="">Без кабинета</option>
                              <option value="office">Офис</option>
                              <option value="object">Рабочий (объект)</option>
                              <option value="contractor">Подрядчик</option>
                            </select>
                            <input
                              className={styles.input}
                              placeholder="Описание (необязательно)"
                              value={cloneForm.description}
                              onChange={e => setCloneForm(s => ({ ...s, description: e.target.value }))}
                            />
                          </div>

                          <div className={styles.cloneFormCheckboxRow}>
                            <label className={styles.inlineCheckbox}>
                              <input
                                type="checkbox"
                                checked={cloneForm.is_admin}
                                onChange={e => setCloneForm(s => ({ ...s, is_admin: e.target.checked }))}
                              />
                              <span>Админ</span>
                            </label>
                            <label className={styles.inlineCheckbox} title="Роль видит разделы вне личного кабинета.">
                              <input
                                type="checkbox"
                                checked={cloneForm.is_admin || cloneForm.admin_access}
                                disabled={cloneForm.is_admin}
                                onChange={e => setCloneForm(s => ({ ...s, admin_access: e.target.checked }))}
                              />
                              <span>Доступ в админку</span>
                            </label>
                            <HoursToggle
                              checked={cloneForm.show_actual_hours}
                              onChange={v => setCloneForm(s => ({ ...s, show_actual_hours: v }))}
                              title="Показывать часы по СКУД без обрезки до плановой нормы дня"
                            />
                            <label className={styles.inlineCheckbox} title="Скрыть боковое меню у пользователей этой роли (для админа игнорируется)">
                              <input
                                type="checkbox"
                                checked={cloneForm.hide_sidebar}
                                onChange={e => setCloneForm(s => ({ ...s, hide_sidebar: e.target.checked }))}
                              />
                              <span>Скрыть меню</span>
                            </label>
                          </div>

                          <div className={styles.cloneFormCheckboxRow}>
                            <label className={styles.inlineCheckbox} title="Сколько месяцев назад от текущего доступно для табеля. Для админов окно не применяется.">
                              <span>Окно назад, мес.</span>
                              <input
                                type="number"
                                min={TIMESHEET_MONTHS_MIN}
                                max={TIMESHEET_MONTHS_MAX}
                                className={styles.inputInline}
                                value={cloneForm.timesheet_months_back}
                                onChange={e => setCloneForm(s => ({ ...s, timesheet_months_back: clampTimesheetMonths(e.target.value) }))}
                              />
                            </label>
                            <label className={styles.inlineCheckbox} title="Сколько месяцев вперёд от текущего доступно для табеля. Для админов окно не применяется.">
                              <span>Окно вперёд, мес.</span>
                              <input
                                type="number"
                                min={TIMESHEET_MONTHS_MIN}
                                max={TIMESHEET_MONTHS_MAX}
                                className={styles.inputInline}
                                value={cloneForm.timesheet_months_forward}
                                onChange={e => setCloneForm(s => ({ ...s, timesheet_months_forward: clampTimesheetMonths(e.target.value) }))}
                              />
                            </label>
                            <label className={styles.inlineCheckbox} title="Показывать кнопку «Весь месяц» в переключателе периода табеля. Если выключено — только полумесячные периоды (1–15 и 16–N).">
                              <input
                                type="checkbox"
                                checked={cloneForm.timesheet_show_full_period}
                                onChange={e => setCloneForm(s => ({ ...s, timesheet_show_full_period: e.target.checked }))}
                              />
                              <span>Показывать «Весь месяц» в табеле</span>
                            </label>
                          </div>

                          <CorrectionRestrictionsBlock
                            value={cloneForm}
                            onChange={next => setCloneForm(s => ({ ...s, ...next }))}
                          />
                        </div>

                        <div className={styles.formActions}>
                          <button className={styles.successButton} onClick={handleCloneRole} disabled={savingRole}>
                            Создать копию
                          </button>
                          <button className={styles.secondaryButton} onClick={() => setShowCloneForm(false)}>
                            Отмена
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })()}

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

                <div className={styles.roleSwitchBar}>
                  <label className={styles.roleSwitch} title="Роль видит админку: разделы вне личного кабинета. Выключено — пользователь остаётся в ЛК, все админ-права роли снимаются.">
                    <input
                      type="checkbox"
                      checked={roleHasAdminArea}
                      disabled={selectedRole.is_admin}
                      onChange={e => void handleToggleAdminAccess(selectedRole, e.target.checked)}
                    />
                    <span className={styles.roleSwitchTrack} />
                    <span className={styles.roleSwitchText}>
                      <strong>Доступ в админку</strong>
                      <small>
                        {selectedRole.is_admin
                          ? 'Роль помечена «Админ» — админка открыта всегда'
                          : roleHasAdminArea
                            ? `Открыто страниц админки: ${adminAccessCount}`
                            : 'Роль работает только в личном кабинете'}
                      </small>
                    </span>
                  </label>

                  <label className={styles.roleSwitch} title="«Управление кадрами» и «Табель» выдаются автоматически пользователям с назначенными отделами или прямыми подчинёнными — минуя матрицу роли. Выключите для узких ролей (например «Менеджер МТС»).">
                    <input
                      type="checkbox"
                      checked={selectedRole.manager_auto_access !== false}
                      disabled={selectedRole.is_admin}
                      onChange={e => void handleToggleManagerAutoAccess(selectedRole, e.target.checked)}
                    />
                    <span className={styles.roleSwitchTrack} />
                    <span className={styles.roleSwitchText}>
                      <strong>Авто-доступ руководителя</strong>
                      <small>«Управление кадрами» и «Табель» по назначенным отделам</small>
                    </span>
                  </label>

                  <label className={styles.roleSwitch} title="Скрыть боковое меню у пользователей роли. Для админа игнорируется.">
                    <input
                      type="checkbox"
                      checked={!selectedRole.hide_sidebar}
                      onChange={e => void handleToggleHideSidebar(selectedRole, !e.target.checked)}
                    />
                    <span className={styles.roleSwitchTrack} />
                    <span className={styles.roleSwitchText}>
                      <strong>Боковое меню</strong>
                      <small>{selectedRole.hide_sidebar ? 'Скрыто' : 'Видно'}</small>
                    </span>
                  </label>
                </div>

                <div className={styles.accessSections}>
                  <div className={styles.areaBlock}>
                    <div className={styles.areaHeader}>
                      <h3 className={styles.areaTitle}>Личный кабинет</h3>
                      <span className={styles.areaHint}>Страницы сотрудника: свои заявления, документы, задачи</span>
                    </div>
                    {personalGroups.map(group => (
                      <div key={group.code} className={styles.card}>
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
                  </div>

                  <div className={`${styles.areaBlock} ${roleHasAdminArea ? '' : styles.areaBlockDisabled}`}>
                    <div className={styles.areaHeader}>
                      <h3 className={styles.areaTitle}>Админка</h3>
                      <span className={styles.areaHint}>
                        {roleHasAdminArea
                          ? 'Разделы вне личного кабинета'
                          : 'Включите «Доступ в админку», чтобы выдать роли эти страницы'}
                      </span>
                    </div>

                    {adminGroups.map(group => (
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
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
