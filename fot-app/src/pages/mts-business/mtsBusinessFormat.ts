import { ApiError } from '../../api/client';

// Общие хелперы форматирования модуля «МТС Бизнес» — используются на вкладках
// «Основное» (OverviewSection) и «Администрирование» (MtsBusinessPage).

export const errText = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

export const pad = (n: number): string => String(n).padStart(2, '0');
export const toISODate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fmtDur = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} ч ${pad(m)} м` : `${m} м ${pad(sec % 60)} с`;
};
export const fmtLast = (iso: string | null): string => iso
  ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—';
export const fmtMoney = (v: number | null): string => v == null ? '—' : `${v.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

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
