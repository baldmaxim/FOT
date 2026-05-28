export interface ITableGroupEntry {
  name: string;
  label: string;
}

export interface ITableGroup {
  id: string;
  title: string;
  tables: ITableGroupEntry[];
}

export const TABLE_GROUPS: ITableGroup[] = [
  {
    id: 'people',
    title: '👥 Сотрудники',
    tables: [
      { name: 'employees', label: 'Сотрудники' },
      { name: 'employee_assignments', label: 'Назначения сотрудников' },
      { name: 'employee_department_access', label: 'Доступ сотрудников к отделам' },
      { name: 'salary_history', label: 'История зарплат' },
    ],
  },
  {
    id: 'org',
    title: '🏢 Организация и структура',
    tables: [
      { name: 'org_departments', label: 'Отделы' },
      { name: 'org_sites', label: 'Объекты (сайты)' },
      { name: 'positions', label: 'Должности' },
    ],
  },
  {
    id: 'access',
    title: '🔐 Доступы и роли',
    tables: [
      { name: 'user_profiles', label: 'Профили пользователей' },
      { name: 'system_roles', label: 'Роли системы' },
      { name: 'access_pages', label: 'Страницы интерфейса' },
      { name: 'access_capability_catalog', label: 'Каталог разрешений' },
      { name: 'role_page_access', label: 'Доступ ролей к страницам' },
      { name: 'user_department_access', label: 'Доступ пользователей к отделам' },
    ],
  },
  {
    id: 'timesheets',
    title: '📋 Табели и согласования',
    tables: [
      { name: 'timesheet_approvals', label: 'Согласования табелей' },
      { name: 'timesheet_approval_events', label: 'История согласований' },
      { name: 'timesheet_responsibles', label: 'Ответственные за табели' },
      { name: 'timesheet_reminder_log', label: 'Напоминания о табелях' },
      { name: 'attendance_adjustments', label: 'Корректировки явки' },
      { name: 'tender_timesheet', label: 'Табель тендеров' },
    ],
  },
  {
    id: 'schedules',
    title: '🗓 Графики работы',
    tables: [
      { name: 'work_schedules', label: 'Графики работы' },
      { name: 'employee_schedule_assignments', label: 'Назначение графика сотруднику' },
      { name: 'object_schedule_assignments', label: 'Графики на объектах' },
      { name: 'production_calendar', label: 'Производственный календарь' },
    ],
  },
  {
    id: 'salary',
    title: '💰 Зарплата и выплаты',
    tables: [
      { name: 'payments', label: 'Платежи' },
      { name: 'payslips', label: 'Расчётные листы' },
      { name: 'salary_raise_requests', label: 'Заявки на повышение' },
      { name: 'salary_raise_attachments', label: 'Файлы к заявкам на повышение' },
    ],
  },
  {
    id: 'documents',
    title: '📄 Документы и патенты',
    tables: [
      { name: 'documents', label: 'Документы' },
      { name: 'document_categories', label: 'Категории документов' },
      { name: 'document_links', label: 'Связи документов' },
      { name: 'patent_payment_receipts', label: 'Чеки за патент' },
      { name: 'patent_expiry_reminder_log', label: 'Напоминания об истечении патента' },
    ],
  },
  {
    id: 'requests',
    title: '📝 Заявки и задачи',
    tables: [
      { name: 'leave_requests', label: 'Заявки на отгулы' },
      { name: 'official_memos', label: 'Служебные записки' },
      { name: 'daily_tasks', label: 'Ежедневные задачи' },
      { name: 'daily_tasks_reminder_log', label: 'Напоминания о задачах' },
    ],
  },
  {
    id: 'chat',
    title: '💬 Чат',
    tables: [
      { name: 'chat_conversations', label: 'Беседы' },
      { name: 'chat_messages', label: 'Сообщения' },
      { name: 'chat_participants', label: 'Участники бесед' },
      { name: 'chat_contact_grants', label: 'Разрешения на контакт' },
      { name: 'chat_contact_requests', label: 'Запросы на контакт' },
    ],
  },
  {
    id: 'skud',
    title: '🏢 СКУД и Sigur',
    tables: [
      { name: 'skud_objects', label: 'Объекты СКУД' },
      { name: 'skud_object_access_points', label: 'Точки прохода' },
      { name: 'skud_object_map_points', label: 'Точки на карте' },
      { name: 'skud_object_routes', label: 'Маршруты между объектами' },
      { name: 'skud_travel_segments', label: 'Участки маршрутов' },
      { name: 'skud_access_point_settings', label: 'Настройки точек прохода' },
      { name: 'skud_daily_summary', label: 'Сводка по дням' },
      { name: 'skud_events', label: 'События СКУД' },
      { name: 'skud_sync_department_filter', label: 'Фильтр синхр. отделов' },
      { name: 'skud_sync_employee_filter', label: 'Фильтр синхр. сотрудников' },
      { name: 'sigur_health_checks', label: 'Мониторинг Sigur' },
      { name: 'sigur_incidents', label: 'Инциденты Sigur' },
      { name: 'sigur_runtime_state', label: 'Состояние Sigur' },
      { name: 'sync_commands', label: 'Команды синхронизации' },
      { name: 'sync_status', label: 'Статусы синхронизации' },
    ],
  },
  {
    id: 'system',
    title: '⚙️ Системные настройки',
    tables: [
      { name: 'system_settings', label: 'Настройки системы' },
      { name: 'notifications', label: 'Уведомления' },
    ],
  },
];

export const OTHER_GROUP_ID = 'other';
export const OTHER_GROUP_TITLE = '📦 Прочее';

const tableIndex: Map<string, { groupId: string; label: string; order: number }> = (() => {
  const map = new Map<string, { groupId: string; label: string; order: number }>();
  for (const group of TABLE_GROUPS) {
    group.tables.forEach((entry, index) => {
      map.set(entry.name, { groupId: group.id, label: entry.label, order: index });
    });
  }
  return map;
})();

export const getTableLabel = (tableName: string): string | null => {
  return tableIndex.get(tableName)?.label ?? null;
};

export const getTableGroupId = (tableName: string): string => {
  return tableIndex.get(tableName)?.groupId ?? OTHER_GROUP_ID;
};

export const getTableOrder = (tableName: string): number => {
  return tableIndex.get(tableName)?.order ?? Number.MAX_SAFE_INTEGER;
};
