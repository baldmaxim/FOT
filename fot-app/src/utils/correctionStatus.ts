import type { TimesheetStatus } from '../types';

// Единый источник подписей/эмодзи статусов корректировок. Используется в модалке
// дня, на странице «Корректировки» и в массовых модалках — чтобы подписи не
// расходились (раньше work был то «Присутствие», то «Работа», manual — «Ручная корр.»).
export interface IStatusMeta {
  status: TimesheetStatus;
  icon: string;
  label: string;
  // creatable=false — статус только для отображения (бейдж/фильтр), но не предлагается
  // в пикерах создания корректировки. dayoff приходит из графика, вручную не ставится.
  creatable?: boolean;
}

export const STATUS_META: IStatusMeta[] = [
  { status: 'work',              icon: '✔',  label: 'Работа' },
  { status: 'manual',            icon: '📝', label: 'Корректировка табеля' },
  { status: 'remote',            icon: '🏠', label: 'Удалёнка' },
  { status: 'vacation',          icon: '🏖', label: 'Отпуск' },
  { status: 'sick',              icon: '🏥', label: 'Больничный' },
  { status: 'unpaid',            icon: '💸', label: 'За свой счёт' },
  { status: 'educational_leave', icon: '🎓', label: 'Учебный отпуск' },
  { status: 'dayoff',            icon: '📅', label: 'Отгул', creatable: false },
  { status: 'absent',            icon: '❌', label: 'Неявка' },
];

// Статусы, доступные для ручного создания корректировки (пикеры).
export const CREATABLE_STATUS_META: IStatusMeta[] = STATUS_META.filter(m => m.creatable !== false);

const META_BY_STATUS = new Map<TimesheetStatus, IStatusMeta>(
  STATUS_META.map(meta => [meta.status, meta]),
);

export const getStatusMeta = (status: TimesheetStatus): IStatusMeta | undefined =>
  META_BY_STATUS.get(status);

export const getStatusLabel = (status: TimesheetStatus): string =>
  META_BY_STATUS.get(status)?.label ?? status;

export const getStatusIcon = (status: TimesheetStatus): string =>
  META_BY_STATUS.get(status)?.icon ?? '✎';

// Статусы, для которых редактируются часы (work/manual — «Корректировка табеля»).
// remote — авто-полный день по графику, часы не вводятся.
export const HOURS_EDITABLE_STATUSES = new Set<TimesheetStatus>(['work', 'manual']);
