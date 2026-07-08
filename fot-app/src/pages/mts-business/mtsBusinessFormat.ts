import { ApiError } from '../../api/client';

// Общие хелперы форматирования модуля «МТС Бизнес» — используются на вкладках
// «Основное» (OverviewSection) и «Администрирование» (MtsBusinessPage).

export const errText = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

export const pad = (n: number): string => String(n).padStart(2, '0');
export const toISODate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** Последние n месяцев, свежие сверху: [{ value:'YYYY-MM', label:'Июль 2026' }]. */
export const lastMonths = (n: number, base: Date = new Date()): { value: string; label: string }[] => {
  const out: { value: string; label: string }[] = [];
  const d = new Date(base.getFullYear(), base.getMonth(), 1);
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear();
    const m = d.getMonth();
    out.push({ value: `${y}-${pad(m + 1)}`, label: `${MONTH_NAMES[m]} ${y}` });
    d.setMonth(m - 1);
  }
  return out;
};

/** Диапазон месяца 'YYYY-MM' → { from:'YYYY-MM-01', to: min(последний день месяца, today) }. */
export const monthRange = (ym: string, today: Date = new Date()): { from: string; to: string } => {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const to = last > today ? today : last;
  return { from: toISODate(first), to: toISODate(to) };
};
export const fmtDur = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} ч ${pad(m)} м` : `${m} м ${pad(sec % 60)} с`;
};
export const fmtLast = (iso: string | null): string => iso
  ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—';
/** Дата без времени: 'YYYY-MM-DD' → «07.07.26» (без сдвига таймзоны). */
export const fmtDay = (ymd: string | null): string => ymd
  ? new Date(`${ymd.slice(0, 10)}T00:00:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
  : '—';
export const fmtMoney = (v: number | null): string => v == null ? '—' : `${v.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

/** 79151204230 → «+7 (915) 120-42-30»; иное — как есть. */
export const fmtPhone = (msisdn: string | null | undefined): string => {
  if (!msisdn) return '—';
  const d = msisdn.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('7')) {
    return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9, 11)}`;
  }
  return msisdn;
};

/** Подтип события выписки для ярлыка: «(_Мобильная)»→«Мобильная», «…трафик 4G»→«4G»; иначе null. */
export const parseUsageSubtype = (label: string | null): string | null => {
  if (!label) return null;
  const paren = label.match(/\(([^)]*)\)/);
  if (paren) return paren[1].replace(/^[_\s]+/, '').trim() || null;
  const traf = label.match(/трафик\s+(.+)$/i);
  if (traf) return traf[1].trim() || null;
  return null;
};

/** Стабильный цвет-метка контакта по хэшу строки (номер/имя) — одинаковый собеседник даёт один цвет. */
export const usageContactColor = (key: string | null | undefined): string => {
  if (!key) return 'var(--text-tertiary)';
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 65% 55%)`;
};

export const UNIT_LABELS: Record<string, string> = { BYTE: 'интернет', MINUTE: 'минуты', SECOND: 'минуты', ITEM: 'SMS', MONEY: 'деньги' };
export const fmtPackage = (p: { unitOfMeasure: string | null; quota: number | null; remainder: number | null }): string => {
  const label = (p.unitOfMeasure && UNIT_LABELS[p.unitOfMeasure]) || p.unitOfMeasure || '—';
  const unit = p.unitOfMeasure === 'BYTE' ? 'МБ' : '';
  const toUnit = (v: number | null): string => {
    if (v == null) return '—';
    return p.unitOfMeasure === 'BYTE' ? Math.round(v / 1_000_000).toLocaleString('ru-RU') : Math.round(v).toLocaleString('ru-RU');
  };
  return `${label}: ${toUnit(p.remainder)}${unit ? ` ${unit}` : ''} из ${toUnit(p.quota)}${unit ? ` ${unit}` : ''}`;
};

export const ACTION_TYPE_LABELS: Record<string, string> = {
  service_add: 'Добавить услугу',
  service_remove: 'Удалить услугу',
  block_add: 'Подключить блокировку',
  block_remove: 'Снять блокировку',
  budget_rule_add: 'Добавить правило бюджета',
  budget_rule_remove: 'Удалить правило бюджета',
  tariff_change: 'Сменить тариф',
};

// Карточка номера
export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  calls: 'Звонки',
  sms: 'СМС',
  internet: 'Интернет',
  periodic: 'Периодические',
  oneTime: 'Разовые',
  topups: 'Пополнения',
  other: 'Прочее',
};

export const FORWARDING_TYPE_LABELS: Record<string, string> = {
  CFU: 'Безусловная',
  CFB: 'При занятости',
  CFNRY: 'Нет ответа',
  CFNRC: 'Недоступен',
};

// Персональные данные пользователя номера (PersonalDataConfirmation)
export const PD_STATUS_LABELS: Record<string, string> = {
  Activated: 'подтверждены',
  ActivatedPortIn: 'подтверждены (перенос)',
  Anonymous: 'не внесены',
  Depersonalized: 'обезличены',
  Migration: 'нужна актуализация',
  NotRequired: 'не требуются',
  WaitingForAcceptance: 'ожидает SMS-подтверждения',
  WaitingForCheck: 'на проверке',
  MismatchOfData: 'расхождение данных',
  NotFoundInEsia: 'не найден в ЕСИА',
  RequestNotFoundInEsia: 'заявка не найдена в ЕСИА',
  Refusal: 'отказ пользователя',
};

export type PdStatusKind = 'ok' | 'wait' | 'err' | 'muted';

export const PD_STATUS_KIND: Record<string, PdStatusKind> = {
  Activated: 'ok',
  ActivatedPortIn: 'ok',
  NotRequired: 'muted',
  Depersonalized: 'muted',
  Anonymous: 'muted',
  Migration: 'wait',
  WaitingForAcceptance: 'wait',
  WaitingForCheck: 'wait',
  MismatchOfData: 'err',
  NotFoundInEsia: 'err',
  RequestNotFoundInEsia: 'err',
  Refusal: 'err',
};

export const PD_OPERATION_LABELS: Record<string, string> = {
  change: 'Внесение / изменение',
  delete: 'Удаление',
};
