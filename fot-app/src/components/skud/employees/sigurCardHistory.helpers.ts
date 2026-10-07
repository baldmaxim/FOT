import type { SigurCardHistoryEntry } from '../../../types';

export const sigurCardHistoryQueryKey = (sigurEmployeeId: number, cardId?: number) =>
  cardId === undefined
    ? ['sigur-card-history', sigurEmployeeId] as const
    : ['sigur-card-history', sigurEmployeeId, cardId] as const;

const MSK_DATE = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const MSK_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  hour: '2-digit',
  minute: '2-digit',
});

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Момент записи в журнал — по Москве, дата и время раздельно (без запятой). */
export const formatSigurCardHistoryMoment = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${MSK_DATE.format(date)} ${MSK_TIME.format(date)}`;
};

/** Дата карты: YYYY-MM-DD — как есть, без UTC-сдвига; даты Sigur — как в полях сайдбара. */
const formatCardDate = (value: string | null): string => {
  if (!value) return '—';
  const dateOnly = DATE_ONLY_RE.exec(value);
  if (dateOnly) return `${dateOnly[3]}.${dateOnly[2]}.${dateOnly[1]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU');
};

/**
 * Поштучная правка: только то, что изменилось. Старые записи прежних дат не
 * хранят — для них «Срок до …», без даты начала (её отправляли всегда, а не меняли).
 */
const describeManualEdit = (entry: SigurCardHistoryEntry, expiration: string): string => {
  const changes: string[] = [];
  if (entry.previousExpiration) {
    const previousExpiration = formatCardDate(entry.previousExpiration);
    if (previousExpiration !== expiration) changes.push(`Срок: ${previousExpiration} → ${expiration}`);
  }
  if (entry.previousStartDate && entry.startDate) {
    const previousStart = formatCardDate(entry.previousStartDate);
    const start = formatCardDate(entry.startDate);
    if (previousStart !== start) changes.push(`Начало: ${previousStart} → ${start}`);
  }
  return changes.length > 0 ? changes.join(', ') : `Срок до ${expiration}`;
};

export const describeSigurCardHistoryEntry = (entry: SigurCardHistoryEntry): string => {
  const expiration = formatCardDate(entry.expirationDate);
  switch (entry.kind) {
    case 'update_card_binding':
    case 'update_card_expiration':
      return describeManualEdit(entry, expiration);
    case 'assign_card_binding':
      return entry.expirationDate ? `Карта привязана, до ${expiration}` : 'Карта привязана';
    case 'remove_card_binding':
      return 'Карта отвязана';
    case 'bulk_extend':
      return entry.previousExpiration
        ? `Массовое продление: ${formatCardDate(entry.previousExpiration)} → ${expiration}`
        : `Массовое продление до ${expiration}`;
    case 'bulk_rollback':
      return `Откат массового продления → ${expiration}`;
    default:
      return 'Изменение карты';
  }
};

/**
 * Текущий срок карты, если он расходится с последней записью журнала FOT
 * (сравнение по дню). Значит, срок меняли не через FOT — например, в Sigur напрямую.
 * Записи отсортированы от новых к старым.
 */
export const findSigurCardExpirationMismatch = (
  entries: SigurCardHistoryEntry[],
  currentExpiration: string | null,
): string | null => {
  if (!currentExpiration) return null;
  const latest = entries.find(entry => entry.kind !== 'remove_card_binding' && entry.expirationDate);
  if (!latest) return null;
  const current = formatCardDate(currentExpiration);
  return formatCardDate(latest.expirationDate) === current ? null : current;
};
