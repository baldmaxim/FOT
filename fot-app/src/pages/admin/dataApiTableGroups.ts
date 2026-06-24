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
      { name: 'employee_direct_reports', label: 'Прямое подчинение' },
      { name: 'employee_dismissal_events', label: 'События увольнения' },
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
      { name: 'department_object_assignment', label: 'Привязка отделов к объектам' },
      { name: 'employee_object_assignment', label: 'Привязка сотрудников к объектам' },
      { name: 'employee_object_attribution', label: 'Атрибуция сотрудников по объектам' },
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
      { name: 'user_company_access', label: 'Доступ пользователей к компаниям' },
      { name: 'user_employee_access', label: 'Доступ пользователей к сотрудникам' },
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
      { name: 'timesheet_approval_employees', label: 'Сотрудники в согласовании табеля' },
      { name: 'timesheet_timekeeper_review', label: 'Проверка табельщиком' },
      { name: 'timekeeper_object_access', label: 'Доступ табельщика к объектам' },
      { name: 'timekeeper_folder_access', label: 'Доступ табельщика к папкам' },
      { name: 'weekend_approval_assignments', label: 'Маршрутизация согласований выходных' },
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
      { name: 'feedback_messages', label: 'Обратная связь' },
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
      { name: 'skud_event_failures', label: 'Сбои обработки событий' },
      { name: 'skud_events_quarantine', label: 'Карантин событий СКУД' },
      { name: 'employee_skud_object_access', label: 'Доступ сотрудников к объектам СКУД' },
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
    id: 'contractor',
    title: '👷 Подрядчики',
    tables: [
      { name: 'contractor_passes', label: 'Пропуска подрядчиков' },
      { name: 'contractor_pass_holders', label: 'Владельцы пропусков' },
      { name: 'contractor_roster', label: 'Реестр подрядчиков' },
      { name: 'contractor_documents', label: 'Документы подрядчиков' },
      { name: 'contractor_org_access', label: 'Доступ подрядных организаций' },
      { name: 'contractor_submissions', label: 'Заявки подрядчиков' },
      { name: 'contractor_submission_decisions', label: 'Решения по заявкам' },
      { name: 'contractor_activation_batches', label: 'Пакеты активации' },
    ],
  },
  {
    id: 'hiring',
    title: '🧑‍💼 Подбор персонала',
    tables: [
      { name: 'hiring_requests', label: 'Заявки на подбор' },
      { name: 'hiring_candidates', label: 'Кандидаты' },
      { name: 'hiring_recruiters', label: 'Рекрутеры' },
      { name: 'hiring_request_assignees', label: 'Назначенные по заявкам' },
      { name: 'hiring_request_events', label: 'История заявок на подбор' },
      { name: 'hiring_request_files', label: 'Файлы заявок на подбор' },
    ],
  },
  {
    id: 'mts',
    title: '📍 МТС (мобильные сотрудники)',
    tables: [
      { name: 'mts_tasks', label: 'Задачи МТС' },
      { name: 'mts_subscriber_map', label: 'Привязка абонентов' },
      { name: 'mts_location_snapshots', label: 'Снимки геопозиции' },
      { name: 'mts_track_segments', label: 'Сегменты треков' },
      { name: 'mts_gps_points', label: 'GPS-точки' },
      { name: 'mts_geofences', label: 'Геозоны' },
      { name: 'mts_geofence_objects', label: 'Объекты геозон' },
      { name: 'mts_geofence_assignments', label: 'Назначения геозон' },
      { name: 'mts_geofence_violations', label: 'Нарушения геозон' },
    ],
  },
  {
    id: 'tests',
    title: '📝 Тесты и опросы',
    tables: [
      { name: 'tests', label: 'Тесты' },
      { name: 'test_questions', label: 'Вопросы' },
      { name: 'test_options', label: 'Варианты ответов' },
      { name: 'test_answers', label: 'Ответы' },
      { name: 'test_assignments', label: 'Назначения тестов' },
      { name: 'test_responses', label: 'Прохождения тестов' },
    ],
  },
  {
    id: 'system',
    title: '⚙️ Системные настройки',
    tables: [
      { name: 'system_settings', label: 'Настройки системы' },
      { name: 'notifications', label: 'Уведомления' },
      { name: 'schema_migrations', label: 'Миграции схемы БД' },
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
