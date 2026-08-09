/**
 * Чистая логика гашения пропусков старого образца (белый пластик) у подрядчиков.
 *
 * Здесь нет I/O — только детерминированные функции, чтобы destructive-решения были
 * покрыты тестами (old-card-block.util.test.ts). Скрипты
 * scripts/inventory-contractor-cards.ts и scripts/block-contractor-old-cards.ts —
 * тонкие обёртки над этим модулем.
 *
 * Принцип всей конструкции — fail-closed: карта гасится, только если она есть в
 * утверждённом человеком allowlist И не признана новой ни по одному признаку.
 * Любая неполнота данных даёт пропуск, а не запись.
 */
import crypto from 'crypto';
import { deriveSigurCardIdentity } from './sigur-card-w26.util.js';

/**
 * Поколение конкретной карты (не сотрудника).
 *
 * Право гасить даёт ТОЛЬКО `confirmed_white`, и присваивается он исключительно по
 * внешнему confirmation-файлу. Никакая эвристика — facility, даты привязки, card_hex_uid,
 * шаблон печати — этот статус не выдаёт: все они говорят о способе оформления карты,
 * а не о типе физической заготовки.
 */
export type CardGeneration =
  | 'confirmed_white' // подтверждена внешним источником как белая → единственный кандидат
  | 'module_linked'   // связана с модулем выдачи → может быть красной, не трогаем
  | 'not_proven_new'  // признаков новой нет; НЕ утверждение «карта старая» → не трогаем
  | 'unknown';        // карты нет в каталоге Sigur / битый W26 → не трогаем

/** Куда попадает сотрудник по дереву Sigur. */
export type ScopeBucket =
  | 'contractors'  // поддерево «Подрядные организации» (включая саму папку)
  | 'rootless'     // подтверждённо вне папок (departmentId пуст)
  | 'excluded'     // СУ-10 / Служба Механизации / Уволенные / test и прочие ветки
  | 'anomaly';     // departmentId ненулевой, но не резолвится в дерево

/** Примечание профиля Sigur у пропусков, выданных через пул ФОТ: «FOT-POOL:{N}». */
export const FOT_POOL_NOTE_RE = /FOT-POOL\s*:/i;

/**
 * Признаки связи карты с модулем выдачи пропусков.
 *
 * Владелец процесса подтвердил: красные пропуска выдаются ТОЛЬКО через модуль.
 * Отсюда строгий вывод — карта, не связанная с модулем никак, красной быть не может.
 * Обратное неверно: в модуль вносили и белые карты (миграция facility 157-159),
 * поэтому связь с модулем НЕ означает «красная», она означает «трогать нельзя».
 */
export interface IModuleLinkFacts {
  /** Примечание профиля содержит FOT-POOL — пропуск выдан через пул. */
  poolProfile: boolean;
  /** Имя профиля — плейсхолдер пула «Пропуск N». Переживает удаление строки из БД. */
  poolPlaceholderName: boolean;
  /** Карта сопоставлена записи contractor_passes по card_uid. */
  inPassModule: boolean;
  /**
   * У ВЛАДЕЛЬЦА карты есть хотя бы одна строка contractor_passes любого статуса.
   * Employee-level запрет: снимает зависимость от сопоставления card_uid → W26,
   * при котором пустой или битый card_uid пропускал карту в подтверждение.
   */
  employeeHasPassRow: boolean;
  /** У сопоставленной записи заполнен card_hex_uid — оформлялась через ридер. */
  readerIssued: boolean;
  /** Карта или её владелец числятся в чёрном списке удалённых пропусков. */
  deletedPassTrace: boolean;
  /**
   * facility карты встречается хотя бы у одной карты, связанной с модулем.
   * Физическая партия однородна — одна закупка даёт один тип пластика, поэтому
   * засветившаяся в модуле партия целиком считается потенциально красной.
   * Ловит удалённые пуловые пропуска с переименованными в ФИО профилями.
   */
  moduleFacilityBatch: boolean;
}

/** Факты по конкретной карте, собранные инвентаризацией. */
export interface ICardFacts {
  cardId: number;
  /** 3-байтовый value карты из каталога Sigur; null — карты в каталоге нет. */
  value: string | null;
  /** Нормализованный W26 «FFF,NNNNN»; null — декодировать не удалось. */
  w26: string | null;
  /** Справочно для отчётов. В классификации НЕ участвует. */
  facility: number | null;
  moduleLink: IModuleLinkFacts;
}

export interface IClassification {
  generation: CardGeneration;
  reason: string;
}

/**
 * Поколение карты.
 *
 * `confirmedWhiteCardIds` — множество из внешнего confirmation-файла, единственный
 * источник права на гашение. Связь с модулем проверяется ПОСЛЕ подтверждения и
 * перебивает его: подтверждённая карта, у которой появился признак модульной выдачи,
 * всё равно не гасится.
 */
export function classifyCardGeneration(
  card: ICardFacts,
  confirmedWhiteCardIds: ReadonlySet<number> = new Set(),
): IClassification {
  if (!card.value || !card.w26) {
    return { generation: 'unknown', reason: 'карта не найдена в каталоге Sigur или W26 не декодируется' };
  }

  const link = card.moduleLink;
  const reasons = [
    link.poolProfile ? 'профиль FOT-POOL' : null,
    link.poolPlaceholderName ? 'имя профиля «Пропуск N»' : null,
    link.inPassModule ? 'карта сопоставлена записи модуля' : null,
    link.employeeHasPassRow ? 'у владельца есть строка в модуле' : null,
    link.readerIssued ? 'оформлялась через ридер' : null,
    link.deletedPassTrace ? 'след удалённого пропуска' : null,
    link.moduleFacilityBatch ? `партия facility ${card.facility} засвечена в модуле` : null,
  ].filter(Boolean);
  if (reasons.length > 0) {
    return { generation: 'module_linked', reason: `связана с модулем выдачи (${reasons.join(', ')}) — может быть красной` };
  }

  if (confirmedWhiteCardIds.has(card.cardId)) {
    return { generation: 'confirmed_white', reason: 'подтверждена внешним источником как белая' };
  }

  return {
    generation: 'not_proven_new',
    reason: 'признаков модульной выдачи нет, но внешнего подтверждения тоже нет — гасить нельзя',
  };
}

export function hasFotPoolNote(note: string | null | undefined): boolean {
  return !!note && FOT_POOL_NOTE_RE.test(note);
}

export interface IScopeInput {
  /** Результат normalizeDepartmentId: число, null (подтверждённо пусто) или 'invalid'. */
  departmentId: number | null | 'invalid';
  /** departmentId резолвится в узел живого дерева. */
  isKnownDepartment: boolean;
  contractorDescendants: ReadonlySet<number>;
  excludedDescendants: ReadonlySet<number>;
}

/**
 * Куда отнести сотрудника. Исключаемые ветки проверяются ЯВНО и раньше подрядных —
 * не «от противного». Корнем считается только ПОДТВЕРЖДЁННО пустой departmentId;
 * битое или неизвестное значение уходит в anomaly, иначе мусорное поле стало бы
 * обходом исключения СУ-10 / Службы механизации.
 */
export function resolveScopeBucket(input: IScopeInput): ScopeBucket {
  if (input.departmentId === 'invalid') return 'anomaly';
  if (input.departmentId === null) return 'rootless';
  if (!input.isKnownDepartment) return 'anomaly';
  if (input.excludedDescendants.has(input.departmentId)) return 'excluded';
  if (input.contractorDescendants.has(input.departmentId)) return 'contractors';
  return 'excluded';
}

/**
 * Нормализация departmentId из сырого поля Sigur.
 * `null` — поля нет / пусто / 0 (подтверждённый корень); `'invalid'` — значение есть,
 * но числом не является (битые данные, рассинхронизация) — такое корнем считать нельзя.
 */
export function normalizeDepartmentId(raw: unknown): number | null | 'invalid' {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return 'invalid';
  const text = String(raw).trim();
  if (text === '' || text === '0') return null;
  const num = Number(text);
  if (!Number.isFinite(num)) return 'invalid';
  if (num < 0 || !Number.isInteger(num)) return 'invalid';
  return num === 0 ? null : num;
}

/** Дата → миллисекунды. Сравнивать даты как сырые строки нельзя: формат Sigur нестабилен. */
export function normalizeTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Равенство дат по timestamp. Обе пустые — равны; одна пустая — нет.
 * Нераспознанные строки считаются неравными: fail-closed, чтобы мусор не прошёл за совпадение.
 */
export function datesEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftEmpty = !left;
  const rightEmpty = !right;
  if (leftEmpty || rightEmpty) return leftEmpty && rightEmpty;
  const a = normalizeTimestamp(left);
  const b = normalizeTimestamp(right);
  return a !== null && b !== null && a === b;
}

/** Разбор «157-168,63,64» в множество facility. Бросает на мусоре — молча глотать нельзя. */
export function parseFacilityRanges(spec: string): Set<number> {
  const out = new Set<number>();
  for (const chunk of spec.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    const range = part.match(/^(\d{1,3})\s*-\s*(\d{1,3})$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) throw new Error(`Некорректный диапазон facility: "${part}"`);
      for (let i = from; i <= to; i++) out.add(i);
      continue;
    }
    if (!/^\d{1,3}$/.test(part)) throw new Error(`Некорректное значение facility: "${part}"`);
    out.add(Number(part));
  }
  if (out.size === 0) throw new Error('Пустой список facility');
  return out;
}

/** Строка инвентаризации = одна привязка карты к сотруднику. */
export interface IInventoryCard {
  cardId: number;
  sigurEmployeeId: number;
  employeeName: string | null;
  orgName: string | null;
  departmentId: number | null;
  scopeBucket: ScopeBucket;
  generation: CardGeneration;
  value: string | null;
  w26: string | null;
  facility: number | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
}

export type SkipReason =
  | 'not_in_allowlist'
  | 'in_denylist'
  | 'generation_not_confirmed'
  | 'generation_module_linked'
  | 'generation_unknown'
  | 'excluded_branch_card'
  | 'scope_excluded'
  | 'scope_anomaly'
  | 'scope_disabled'
  | 'org_filter'
  | 'employee_has_new_card'
  | 'no_expiration_unrevertable'
  | 'no_start_date_needs_synthetic'
  | 'already_expired';

export const SKIP_REASONS: readonly SkipReason[] = [
  'not_in_allowlist',
  'in_denylist',
  'generation_not_confirmed',
  'generation_module_linked',
  'generation_unknown',
  'excluded_branch_card',
  'scope_excluded',
  'scope_anomaly',
  'scope_disabled',
  'org_filter',
  'employee_has_new_card',
  'no_expiration_unrevertable',
  'no_start_date_needs_synthetic',
  'already_expired',
];

/**
 * Служебная дата начала для привязок, у которых её нет.
 *
 * Sigur не умеет менять срок привязки без даты начала: PUT → 500, PATCH без поля и с
 * `startDate: null` → 422 card.invalid.dates.update (проверено 09.08.2026 на живой карте).
 * Единственный способ погасить такую карту — заполнить дату начала. Значение заведомо
 * раньше любых проходов, поэтому фактический доступ не расширяется ни на день, а вместе
 * с целевым сроком «вчера» окно закрыто в любом случае.
 *
 * ВНИМАНИЕ: операция необратима — вернуть `null` теми же методами нельзя, поэтому
 * применяется только под явным флагом --allow-synthetic-start-date.
 */
export const SYNTHETIC_START_DATE = '2019-12-31T21:00:00.000Z'; // 2020-01-01 00:00 МСК

export interface ISelectOptions {
  scope: ReadonlyArray<'contractors' | 'rootless'>;
  org?: string | null;
  limit?: number | null;
  /**
   * Разрешить гашение привязок без даты начала ценой служебного [[SYNTHETIC_START_DATE]].
   * Без флага такие карты отсеиваются: запись по ним необратима.
   */
  allowSyntheticStartDate?: boolean;
  /** Момент отсечки «уже просрочено», мс. */
  now: number;
}

export interface ISelectInput {
  cards: readonly IInventoryCard[];
  allowlist: ReadonlySet<number>;
  denylist: ReadonlySet<number>;
  /** sigurEmployeeId людей, у которых доказанно есть новая карта или FOT-POOL в примечании. */
  employeesWithNewCard: ReadonlySet<number>;
  /** cardId всех сотрудников СУ-10 / Службы механизации — независимый жёсткий запрет. */
  excludedBranchCardIds?: ReadonlySet<number>;
  options: ISelectOptions;
}

export interface ISelectResult {
  candidates: IInventoryCard[];
  skipped: Array<{ card: IInventoryCard; reason: SkipReason }>;
  skipCounts: Record<SkipReason, number>;
  droppedByLimit: number;
}

/**
 * Отбор карт к гашению. Порядок проверок зафиксирован — от него зависит,
 * какая причина попадёт в отчёт, а разбивка по причинам читается человеком перед apply.
 */
export function selectBlockCandidates(input: ISelectInput): ISelectResult {
  const { cards, allowlist, denylist, employeesWithNewCard, options } = input;
  const excludedBranchCardIds = input.excludedBranchCardIds ?? new Set<number>();
  const allowedBuckets = new Set<string>(options.scope);
  const orgFilter = options.org?.trim().toLowerCase() || null;

  const skipped: Array<{ card: IInventoryCard; reason: SkipReason }> = [];
  const skipCounts = Object.fromEntries(SKIP_REASONS.map(reason => [reason, 0])) as Record<SkipReason, number>;
  const passed: IInventoryCard[] = [];

  const skip = (card: IInventoryCard, reason: SkipReason): void => {
    skipped.push({ card, reason });
    skipCounts[reason] += 1;
  };

  for (const card of cards) {
    // Карты СУ-10 / Службы механизации не гасятся НИКОГДА — проверка идёт первой и
    // не зависит ни от allowlist, ни от скоупа, ни от классификации.
    if (excludedBranchCardIds.has(card.cardId)) { skip(card, 'excluded_branch_card'); continue; }
    if (!allowlist.has(card.cardId)) { skip(card, 'not_in_allowlist'); continue; }
    // Denylist побеждает allowlist всегда: ошибочно утверждённая новая карта не гасится.
    if (denylist.has(card.cardId)) { skip(card, 'in_denylist'); continue; }
    // Гасим ТОЛЬКО подтверждённо белые. Всё остальное — включая «признаков новой нет» —
    // права на запись не даёт.
    if (card.generation === 'module_linked') { skip(card, 'generation_module_linked'); continue; }
    if (card.generation === 'unknown') { skip(card, 'generation_unknown'); continue; }
    if (card.generation !== 'confirmed_white') { skip(card, 'generation_not_confirmed'); continue; }
    if (card.scopeBucket === 'anomaly') { skip(card, 'scope_anomaly'); continue; }
    if (card.scopeBucket === 'excluded') { skip(card, 'scope_excluded'); continue; }
    if (!allowedBuckets.has(card.scopeBucket)) { skip(card, 'scope_disabled'); continue; }
    if (orgFilter && (card.orgName ?? '').trim().toLowerCase() !== orgFilter) { skip(card, 'org_filter'); continue; }
    if (employeesWithNewCard.has(card.sigurEmployeeId)) { skip(card, 'employee_has_new_card'); continue; }
    // Бессрочную привязку нельзя вернуть существующими методами записи (оба требуют строковую дату).
    if (!card.expirationDate) { skip(card, 'no_expiration_unrevertable'); continue; }
    // Привязка без даты начала гасится только вместе с её проставлением — это необратимо.
    if (!card.startDate && !options.allowSyntheticStartDate) {
      skip(card, 'no_start_date_needs_synthetic');
      continue;
    }
    const expiresAt = normalizeTimestamp(card.expirationDate);
    if (expiresAt !== null && expiresAt <= options.now) { skip(card, 'already_expired'); continue; }
    passed.push(card);
  }

  passed.sort((left, right) => (
    left.sigurEmployeeId - right.sigurEmployeeId || left.cardId - right.cardId
  ));

  const limit = options.limit ?? null;
  const candidates = limit && limit > 0 ? passed.slice(0, limit) : passed;
  return {
    candidates,
    skipped,
    skipCounts,
    droppedByLimit: passed.length - candidates.length,
  };
}

/**
 * Строка confirmation-файла: подтверждение, что КОНКРЕТНАЯ карта — белая старого образца.
 *
 * Подтверждать голый cardId нельзя: идентификатор может устареть или быть переиспользован,
 * поэтому карта описывается целиком и вся идентичность сверяется заново перед записью.
 */
export interface IConfirmationEntry {
  cardId: number;
  value: string;
  w26: string;
  format: string;
  employeeId: number;
  /** Как получено подтверждение: owner_rule | registry | physical_check. */
  confirmationType: string;
  /** Кто/что источник — формулировка правила, имя файла реестра, ФИО проверяющего. */
  source: string;
  /** Дата подтверждения, ISO. */
  confirmedAt: string;
}

export const CONFIRMATION_HEADER = [
  'cardId', 'value', 'w26', 'format', 'employeeId', 'confirmationType', 'source', 'confirmedAt',
] as const;

export const ALLOWED_CONFIRMATION_TYPES = ['owner_rule', 'registry', 'physical_check'] as const;

export interface IConfirmationValidation {
  entries: IConfirmationEntry[];
  errors: string[];
}

/** Разбор и строгая валидация confirmation-файла (TSV с заголовком). */
export function parseConfirmationFile(rawText: string): IConfirmationValidation {
  const entries: IConfirmationEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<number>();
  const lines = rawText.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));

  if (lines.length === 0) {
    return { entries, errors: ['confirmation-файл пуст'] };
  }

  const header = lines[0].split('\t').map(cell => cell.trim());
  if (header.join('\t') !== CONFIRMATION_HEADER.join('\t')) {
    return { entries, errors: [`неверный заголовок; ожидается: ${CONFIRMATION_HEADER.join(' / ')}`] };
  }

  lines.slice(1).forEach((line, index) => {
    const lineNo = index + 2;
    const cells = line.split('\t').map(cell => cell.trim());
    if (cells.length !== CONFIRMATION_HEADER.length) {
      errors.push(`строка ${lineNo}: ожидается ${CONFIRMATION_HEADER.length} колонок, получено ${cells.length}`);
      return;
    }
    const [rawCardId, value, w26, format, rawEmployeeId, confirmationType, source, confirmedAt] = cells;

    if (!/^\d+$/.test(rawCardId) || Number(rawCardId) <= 0) {
      errors.push(`строка ${lineNo}: cardId "${rawCardId}" — не целое положительное число`);
      return;
    }
    const cardId = Number(rawCardId);
    if (seen.has(cardId)) { errors.push(`строка ${lineNo}: дубликат cardId ${cardId}`); return; }
    if (!value) { errors.push(`строка ${lineNo}: пустой value`); return; }
    if (!w26) { errors.push(`строка ${lineNo}: пустой W26`); return; }
    if (!format) { errors.push(`строка ${lineNo}: пустой format`); return; }
    if (!/^\d+$/.test(rawEmployeeId) || Number(rawEmployeeId) <= 0) {
      errors.push(`строка ${lineNo}: employeeId "${rawEmployeeId}" — не целое положительное число`);
      return;
    }
    if (!(ALLOWED_CONFIRMATION_TYPES as readonly string[]).includes(confirmationType)) {
      errors.push(`строка ${lineNo}: confirmationType "${confirmationType}" — допустимы ${ALLOWED_CONFIRMATION_TYPES.join(', ')}`);
      return;
    }
    if (!source) { errors.push(`строка ${lineNo}: не указан источник подтверждения`); return; }
    if (normalizeTimestamp(confirmedAt) === null) {
      errors.push(`строка ${lineNo}: некорректная дата подтверждения "${confirmedAt}"`);
      return;
    }

    seen.add(cardId);
    entries.push({
      cardId,
      value,
      w26,
      format,
      employeeId: Number(rawEmployeeId),
      confirmationType,
      source,
      confirmedAt,
    });
  });

  if (entries.length === 0 && errors.length === 0) errors.push('confirmation-файл не содержит ни одной записи');
  return { entries, errors };
}

/**
 * Чтение поля сырой записи Sigur по списку алиасов.
 *
 * Локальная копия, а не `resolveField` из sigur-sync-shared: тот модуль тянет sigurService
 * и пул PostgreSQL, а этот обязан остаться чистым и тестируемым без I/O.
 */
function pickField(raw: Record<string, unknown>, ...aliases: string[]): unknown {
  for (const alias of aliases) {
    const value = raw[alias];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export interface ILiveCardIdentity {
  cardId: number;
  value: string | null;
  w26: string | null;
  format: string | null;
  employeeId: number;
}

/**
 * Идентичность карты для сверки перед записью — из сырой записи каталога Sigur.
 *
 * Возвращает null, если W26 не выводится: гасить карту, идентичность которой не удалось
 * восстановить, нельзя (fail-closed). Именно эта функция стоит в боевом скрипте, поэтому
 * тесты на неё покрывают реальный call site, а не его копию.
 *
 * `format`: поля нет → format привязки (fallbackFormat); поле есть, но пустое → null,
 * что даёт `format_changed` при сверке. Пустоту не подменяем — это тоже fail-closed.
 */
export function buildLiveCardIdentity(
  raw: Record<string, unknown>,
  cardId: number,
  employeeId: number,
  fallbackFormat: string | null,
): ILiveCardIdentity | null {
  const identity = deriveSigurCardIdentity(
    String(pickField(raw, 'value', 'cardValue', 'card_value') ?? ''),
    String(pickField(raw, 'formattedValue', 'formatted_value') ?? ''),
  );
  if (!identity.w26) return null;

  const rawFormat = pickField(raw, 'format', 'Format', 'cardFormat');
  const format = String(rawFormat ?? fallbackFormat ?? '').trim() || null;

  return { cardId, value: identity.value, w26: identity.w26, format, employeeId };
}

/** Сверка подтверждения с живой картой: идентичность должна совпасть целиком. */
export type IdentityVerdict =
  | 'ok'
  | 'card_not_found'
  | 'value_changed'
  | 'w26_changed'
  | 'format_changed'
  | 'owner_changed';

export function verifyConfirmedIdentity(
  entry: IConfirmationEntry,
  live: { cardId: number; value: string | null; w26: string | null; format: string | null; employeeId: number } | null,
): IdentityVerdict {
  if (!live || live.cardId !== entry.cardId) return 'card_not_found';
  const norm = (text: string): string => text.trim().toUpperCase().replace(/^0+/, '');
  if (!live.value || norm(live.value) !== norm(entry.value)) return 'value_changed';
  const normW26 = (text: string): string => {
    const match = text.replace(/\s/g, '').match(/^(\d+),(\d+)$/);
    return match ? `${Number(match[1])},${Number(match[2])}` : text.trim();
  };
  if (!live.w26 || normW26(live.w26) !== normW26(entry.w26)) return 'w26_changed';
  if (!live.format || live.format.trim().toUpperCase() !== entry.format.trim().toUpperCase()) {
    return 'format_changed';
  }
  if (live.employeeId !== entry.employeeId) return 'owner_changed';
  return 'ok';
}

/** Канонизация JSON: ключи объектов сортируются, чтобы хеш не зависел от порядка полей. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Хеш плана считается по канонизированному содержимому — поле planHash в расчёт не входит. */
export function buildPlanHash(planPayload: Record<string, unknown>): string {
  const { planHash: _ignored, ...rest } = planPayload;
  void _ignored;
  return sha256(canonicalJson(rest));
}

/** Хеш множества потомков контрольного узла: перемещение узла ID не меняет, состав — меняет. */
export function hashDescendantSet(ids: Iterable<number>): string {
  return sha256([...ids].sort((left, right) => left - right).join(','));
}

export interface IControlNodeSnapshot {
  id: number;
  parentId: number | null;
  descendantsHash: string;
}

export type ControlNodeDrift = 'ok' | 'missing' | 'moved' | 'subtree_changed';

export function compareControlNode(
  planned: IControlNodeSnapshot,
  live: IControlNodeSnapshot | null,
): ControlNodeDrift {
  if (!live) return 'missing';
  if (live.id !== planned.id || live.parentId !== planned.parentId) return 'moved';
  if (live.descendantsHash !== planned.descendantsHash) return 'subtree_changed';
  return 'ok';
}

/** Живая привязка карты к сотруднику, прочитанная точечным GET. */
export interface ILiveBinding {
  employeeId: number | null;
  cardId: number | null;
  startDate: string | null;
  expirationDate: string | null;
}

export type WriteOutcome = 'committed' | 'not_applied' | 'unknown';

/**
 * Исход записи по контрольному GET. Исключение при записи НЕ означает, что записи не было:
 * клиент Sigur повторяет put/patch при сетевых ошибках и 5xx, поэтому сервер мог изменение
 * применить. Единственный источник истины — состояние привязки после запроса.
 */
export function classifyWriteOutcome(params: {
  live: ILiveBinding | null;
  getFailed: boolean;
  targetExpiration: string;
  beforeExpiration: string | null;
  /** Задана, если записывали служебную дату начала: тогда сверяются ОБЕ даты. */
  targetStartDate?: string | null;
}): WriteOutcome {
  if (params.getFailed || !params.live) return 'unknown';
  const startOk = !params.targetStartDate || datesEqual(params.live.startDate, params.targetStartDate);
  if (datesEqual(params.live.expirationDate, params.targetExpiration)) {
    // Срок встал, а служебная дата начала — нет: состояние половинчатое, разбирать руками.
    return startOk ? 'committed' : 'unknown';
  }
  if (datesEqual(params.live.expirationDate, params.beforeExpiration)) return 'not_applied';
  return 'unknown';
}

export interface IJournalRestoreEntry {
  employeeId: number;
  cardId: number;
  startDateBefore: string | null;
  expirationDateBefore: string | null;
  /** Состояние ПОСЛЕ записи, прочитанное контрольным GET (не отправленное значение). */
  expirationDateAfter: string | null;
  /**
   * Служебная дата начала, записанная скриптом взамен пустой. Откат её НЕ снимает —
   * Sigur не принимает пустую дату начала, — но обязан её учитывать в CAS-условии.
   */
  startDateTarget?: string | null;
}

export type RollbackVerdict =
  | 'ok'
  | 'already_restored'
  | 'missing_binding'
  | 'conflict_owner'
  | 'conflict_card'
  | 'conflict_start_date'
  | 'conflict_expiration';

/**
 * CAS-условие отката: восстанавливаем, только если привязка ровно в том состоянии,
 * в котором её оставил скрипт. Любое расхождение — конфликт и пропуск, чтобы не затереть
 * более позднюю ручную правку (в том числе правку startDate, которую PATCH перезаписал бы).
 *
 * Если скрипт проставил служебную дату начала, ожидаемое «текущее» значение — именно она,
 * а не исходный `null`: снять дату начала Sigur не даёт, поэтому откат ЧАСТИЧНЫЙ —
 * возвращает прежний срок и оставляет служебную дату.
 */
export function evaluateRollback(
  entry: IJournalRestoreEntry,
  live: ILiveBinding | null,
): RollbackVerdict {
  if (!live) return 'missing_binding';
  if (live.employeeId !== entry.employeeId) return 'conflict_owner';
  if (live.cardId !== entry.cardId) return 'conflict_card';

  const expectedStart = entry.startDateTarget ?? entry.startDateBefore;
  const startMatchesExpected = datesEqual(live.startDate, expectedStart);
  if (startMatchesExpected && datesEqual(live.expirationDate, entry.expirationDateBefore)) {
    return 'already_restored';
  }
  if (!startMatchesExpected) return 'conflict_start_date';
  if (!datesEqual(live.expirationDate, entry.expirationDateAfter)) return 'conflict_expiration';
  return 'ok';
}

/** Целевая дата гашения: вчера 23:59:59 по московскому времени, в ISO. */
export function buildExpirationTarget(now: Date): string {
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const yesterday = new Date(Date.UTC(
    msk.getUTCFullYear(),
    msk.getUTCMonth(),
    msk.getUTCDate() - 1,
    23, 59, 59,
  ));
  return new Date(yesterday.getTime() - MSK_OFFSET_MS).toISOString();
}
