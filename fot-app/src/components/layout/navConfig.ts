import type { FC } from 'react';
import {
  GridIcon,
  UsersIcon,
  CalendarIcon,
  ClipboardCheckIcon,
  DatabaseIcon,
  UserIcon,
  BarChartIcon,
  ShieldIcon,
  DollarIcon,
  FileTextIcon,
  KeyIcon,
  MapPinIcon,
  PhoneIcon,
} from '../ui/Icons';

/** Область пункта меню: личный кабинет сотрудника или админка (зеркало access_pages.area). */
export type NavArea = 'personal' | 'admin';

export interface INavItem {
  id: string;
  path: string;
  label: string;
  icon: FC<{ className?: string }>;
  badge?: number;
  requiredPage?: string | string[];
  /**
   * Если true — пункт скрыт для админа компании (is_admin со скоупом).
   * Системный админ (company_scope.roots === 'all') всегда видит пункт.
   */
  systemAdminOnly?: boolean;
  /**
   * Пункт — личный кабинет конкретного типа. Виден только если у роли
   * выбран этот тип кабинета (system_roles.employee_variant), а не по
   * page-access (админ обходит page-access и иначе видел бы ЛК подрядчика).
   */
  personalCabinet?: 'contractor';
}

export interface INavGroup {
  label: string;
  area: NavArea;
  items: INavItem[];
}

/**
 * Боковое меню основного приложения. Группы с area='admin' — это админка:
 * доступ хотя бы к одному их пункту означает, что пользователю есть куда
 * зайти из личного кабинета (см. utils/adminEntry.ts). Раньше эту роль играло
 * право на «Обзор» (/dashboard), из-за чего узкие роли приходилось «открывать»
 * лишней страницей.
 */
export const navGroups: INavGroup[] = [
  {
    label: 'Моё',
    area: 'personal',
    items: [
      { id: 'my-cabinet', path: '/employee', label: 'Личный кабинет', icon: UserIcon, requiredPage: '/employee' },
      { id: 'contractor', path: '/contractor', label: 'Пропуска', icon: KeyIcon, requiredPage: '/contractor', personalCabinet: 'contractor' },
    ]
  },
  {
    label: 'Обзор и заявления',
    area: 'admin',
    items: [
      { id: 'overview', path: '/', label: 'Обзор', icon: GridIcon, requiredPage: '/dashboard' },
      { id: 'leave-requests', path: '/leave-requests', label: 'Заявления', icon: ClipboardCheckIcon, requiredPage: ['/leave-requests', '/salary-raise-review', '/leave-vacations', '/testing-review'] },
      { id: 'skud-presence', path: '/skud-presence', label: 'Сотрудники на объектах', icon: MapPinIcon, requiredPage: '/skud-presence' },
    ]
  },
  {
    label: 'Управление',
    area: 'admin',
    items: [
      { id: 'staff-control', path: '/staff-control', label: 'Управление кадрами', icon: UsersIcon, requiredPage: ['/staff-control', '/staff-control/hiring'] },
      { id: 'timesheet', path: '/timesheet', label: 'Табель', icon: CalendarIcon, requiredPage: '/timesheet' },
      { id: 'approvals', path: '/approvals', label: 'Согласования', icon: CalendarIcon, requiredPage: '/timesheet-hr' },
      { id: 'timesheet-hr', path: '/timesheet-hr', label: 'Табели HR', icon: CalendarIcon, requiredPage: '/timesheet-hr' },
      { id: 'discipline', path: '/discipline', label: 'Аналитика', icon: BarChartIcon, requiredPage: '/discipline' },
    ]
  },
  {
    label: 'Администрирование',
    area: 'admin',
    items: [
      { id: 'payroll-hub', path: '/admin/schedules', label: 'Графики работы', icon: DollarIcon, requiredPage: ['/admin/schedules', '/admin/schedules/templates'] },
      { id: 'patent-receipts', path: '/admin/patent-receipts', label: 'Чеки за патент', icon: FileTextIcon, requiredPage: '/admin/patent-receipts' },
      { id: 'timesheet-transfers', path: '/admin/timesheet-transfers', label: 'Переводы и исключения', icon: CalendarIcon, requiredPage: '/admin/timesheet-transfers' },
      { id: 'skud-hub', path: '/skud-settings', label: 'СКУД', icon: DatabaseIcon, requiredPage: '/skud-settings' },
      { id: 'sigur', path: '/sigur', label: 'SIGUR', icon: UsersIcon, requiredPage: '/skud-settings' },
      { id: 'card-reader', path: '/skud-card-reader', label: 'Пропуск', icon: KeyIcon, requiredPage: '/skud-card-reader' },
      { id: 'contractor-approvals', path: '/admin/contractor-approvals', label: 'Подрядчики', icon: ClipboardCheckIcon, requiredPage: ['/admin/contractor-approvals', '/admin/contractor-approvals/submissions', '/admin/contractor-approvals/otitb'] },
      // «МТС» (/mts) временно скрыт из сайдбара — вернуть по запросу.
      { id: 'mts-business', path: '/mts-business', label: 'МТС Бизнес', icon: PhoneIcon, requiredPage: '/mts-business' },
      { id: 'system-hub', path: '/admin/system', label: 'Система', icon: ShieldIcon, requiredPage: ['/admin/users', '/admin/roles', '/admin/audit', '/admin/action-history', '/admin/settings', '/admin/data-api'], systemAdminOnly: true },
    ]
  }
];
