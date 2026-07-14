import { normalizeMsisdn } from './mts-business-cdr.service.js';

// Общая часть переадресации для двух контуров: самообслуживание сотрудника
// (employee-sim.controller) и управление за абонента из админки «МТС Бизнес»
// (mts-business-subscribers.controller). Правила валидации номера назначения
// одни и те же — расходиться они не должны.

/** Тип переадресации: всегда / нет ответа (таймер) / недоступен. CFB (занято) — вне MVP. */
export const FORWARDING_TYPES = ['CFU', 'CFNRY', 'CFNRC'] as const;

export type ForwardingType = (typeof FORWARDING_TYPES)[number];

/** Таймер «нет ответа» по умолчанию, сек (применяется только к CFNRY). */
export const DEFAULT_NO_REPLY_TIMER = 20;

export type ForwardingTargetResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Номер назначения: только российский мобильный/городской 11-значный (7XXXXXXXXXX). */
export const validateForwardingTarget = (raw: string, ownMsisdn: string): ForwardingTargetResult => {
  const target = normalizeMsisdn(raw);
  if (!target || target.length !== 11 || !target.startsWith('7')) {
    return { ok: false, error: 'Укажите российский номер в формате +7 XXX XXX-XX-XX' };
  }
  // 7-8XX… — это 8-800/8-809 и прочие платные/сервисные линии (после нормализации 8→7).
  if (target[1] === '8') {
    return { ok: false, error: 'Переадресация на платные и сервисные номера запрещена' };
  }
  if (target === normalizeMsisdn(ownMsisdn)) {
    return { ok: false, error: 'Нельзя переадресовать номер сам на себя' };
  }
  return { ok: true, value: target };
};

/** Таймер, который реально уйдёт в МТС: только для CFNRY, иначе МТС его игнорирует. */
export const resolveNoReplyTimer = (type: ForwardingType, timer?: number): number | undefined =>
  type === 'CFNRY' ? timer ?? DEFAULT_NO_REPLY_TIMER : undefined;

const isForwardingType = (v: unknown): v is ForwardingType =>
  typeof v === 'string' && (FORWARDING_TYPES as readonly string[]).includes(v);

/**
 * Активное правило = первое с поддерживаемым типом и непустым адресом
 * (МТС отдаёт и «пустые» правила-заглушки). Тип — для бейджа в списке абонентов.
 */
export const pickActiveForwardingType = (
  rules: ReadonlyArray<{ forwardingType?: string | null; forwardingAddress?: string | null }> | null | undefined,
): ForwardingType | null => {
  if (!Array.isArray(rules)) return null;
  const active = rules.find(r => isForwardingType(r.forwardingType) && Boolean(r.forwardingAddress));
  return active && isForwardingType(active.forwardingType) ? active.forwardingType : null;
};
