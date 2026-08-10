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

// ── АУДИТ ГАШЕНИЯ ────────────────────────────────────────────────────────────────────
// Всё ниже обслуживает scripts/verify-old-card-block.ts — независимую read-only проверку
// того, что боевые прогоны действительно погасили карты. Логика отделена от записи
// намеренно: аудит не должен верить счётчикам прогона, только журналу, плану и живому Sigur.

/** Событие журнала прогона: `prepared` до записи и одно терминальное после. */
export const JOURNAL_EVENTS = ['prepared', 'committed', 'not_applied', 'unknown'] as const;
export type JournalEvent = (typeof JOURNAL_EVENTS)[number];

export interface IJournalEntry {
  event: JournalEvent;
  at: string;
  employeeId: number;
  cardId: number;
  format: string | null;
  startDateBefore: string | null;
  /** Служебная дата начала, если прогон её проставлял. null — своя дата была на месте. */
  startDateTarget: string | null;
  expirationDateBefore: string | null;
  expirationDateTarget: string;
  startDateAfter: string | null;
  expirationDateAfter: string | null;
  error: string | null;
  /** Откуда прочитано — для сообщений об ошибках и стабильного порядка свёртки. */
  file: string;
  line: number;
}

/** Свёрнутое состояние одной карты по журналам: `prepared` + терминальное событие. */
export interface IJournalRecord {
  employeeId: number;
  cardId: number;
  format: string | null;
  startDateBefore: string | null;
  startDateTarget: string | null;
  expirationDateBefore: string | null;
  expirationDateTarget: string;
  /** Терминальный исход; null — есть только `prepared`, чем кончилось, неизвестно. */
  outcome: WriteOutcome | null;
  expirationDateAfter: string | null;
  startDateAfter: string | null;
  /** Момент `prepared` — нижняя граница для проверки проходов. */
  preparedAt: string | null;
  terminalAt: string | null;
  error: string | null;
  /** Журнал, из которого взято это состояние. */
  file: string;
  sources: string[];
  /** Карта встречалась более чем в одном прогоне — состояние взято из последнего. */
  reattempted: boolean;
}

const journalKey = (employeeId: number, cardId: number): string => `${employeeId}:${cardId}`;

const asNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

/**
 * Разбор журнала прогона (JSONL). Fail-closed: любая битая или неполная строка — исключение
 * с указанием файла и номера строки. Молча пропустить строку нельзя: пропущенная запись
 * превратится в «операция плана без журнала» и исказит итог аудита.
 */
export function parseJournal(fileName: string, rawText: string): IJournalEntry[] {
  const out: IJournalEntry[] = [];
  rawText.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const lineNo = index + 1;
    const fail = (message: string): never => {
      throw new Error(`${fileName}:${lineNo}: ${message}`);
    };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return fail('строка не разбирается как JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('ожидается JSON-объект');

    const event = String(parsed.event ?? '');
    if (!(JOURNAL_EVENTS as readonly string[]).includes(event)) {
      return fail(`недопустимый event "${event}" — допустимы ${JOURNAL_EVENTS.join(', ')}`);
    }
    const at = asNullableString(parsed.at);
    if (!at || normalizeTimestamp(at) === null) return fail(`некорректный at "${String(parsed.at)}"`);

    const employeeId = Number(parsed.employeeId);
    const cardId = Number(parsed.cardId);
    if (!Number.isInteger(employeeId) || employeeId <= 0) return fail(`некорректный employeeId "${String(parsed.employeeId)}"`);
    if (!Number.isInteger(cardId) || cardId <= 0) return fail(`некорректный cardId "${String(parsed.cardId)}"`);

    const expirationDateTarget = asNullableString(parsed.expirationDateTarget);
    if (!expirationDateTarget || normalizeTimestamp(expirationDateTarget) === null) {
      return fail(`некорректный expirationDateTarget "${String(parsed.expirationDateTarget)}"`);
    }

    const dates: Array<[string, string | null]> = [
      ['startDateBefore', asNullableString(parsed.startDateBefore)],
      ['startDateTarget', asNullableString(parsed.startDateTarget)],
      ['expirationDateBefore', asNullableString(parsed.expirationDateBefore)],
      ['startDateAfter', asNullableString(parsed.startDateAfter)],
      ['expirationDateAfter', asNullableString(parsed.expirationDateAfter)],
    ];
    for (const [field, value] of dates) {
      if (value !== null && normalizeTimestamp(value) === null) return fail(`некорректная дата ${field} "${value}"`);
    }

    out.push({
      event: event as JournalEvent,
      at,
      employeeId,
      cardId,
      format: asNullableString(parsed.format),
      startDateBefore: dates[0][1],
      startDateTarget: dates[1][1],
      expirationDateBefore: dates[2][1],
      expirationDateTarget,
      startDateAfter: dates[3][1],
      expirationDateAfter: dates[4][1],
      error: asNullableString(parsed.error),
      file: fileName,
      line: lineNo,
    });
  });
  return out;
}

export interface IMergedJournals {
  /** Состояние по каждой карте — из последнего прогона, где она встречалась. */
  records: Map<string, IJournalRecord>;
  /** То же, но с разбивкой по журналам: нужно для сверки каждого прогона со своим планом. */
  byFile: Map<string, IJournalRecord[]>;
}

/** Хронологический порядок события внутри записи; при равном `at` — стабильно по (file, line). */
const eventOrder = (entry: IJournalEntry, fileOrder: ReadonlyMap<string, number>): [number, number, number] => [
  normalizeTimestamp(entry.at) ?? 0,
  fileOrder.get(entry.file) ?? 0,
  entry.line,
];

const mismatchField = (
  left: IJournalRecord,
  right: IJournalEntry,
): string | null => ([
  ['startDateBefore', left.startDateBefore, right.startDateBefore],
  ['expirationDateBefore', left.expirationDateBefore, right.expirationDateBefore],
  ['expirationDateTarget', left.expirationDateTarget, right.expirationDateTarget],
  ['startDateTarget', left.startDateTarget, right.startDateTarget],
] as Array<[string, string | null, string | null]>)
  .find(([, a, b]) => !datesEqual(a, b))?.[0] ?? null;

/**
 * Свёртка событий журналов в состояние по каждой карте.
 *
 * Внутри одного прогона исходные и целевые даты обязаны совпадать между `prepared` и
 * терминальным событием — расхождение означает потерю или перемешивание файлов, и это
 * исключение. Между разными прогонами расхождение законно: это повторная попытка по новому
 * плану, тогда авторитетно последнее по времени состояние. Одинаковое время в разных
 * файлах при разных данных развести нечем — тоже исключение (fail-closed).
 */
export function mergeJournalEvents(entries: readonly IJournalEntry[]): IMergedJournals {
  const fileOrder = new Map<string, number>();
  for (const entry of entries) {
    if (!fileOrder.has(entry.file)) fileOrder.set(entry.file, fileOrder.size);
  }
  const sorted = [...entries].sort((left, right) => {
    const a = eventOrder(left, fileOrder);
    const b = eventOrder(right, fileOrder);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });

  const perRun = new Map<string, IJournalRecord>();
  for (const entry of sorted) {
    const runKey = `${entry.file} ${journalKey(entry.employeeId, entry.cardId)}`;
    const existing = perRun.get(runKey);
    if (!existing) {
      perRun.set(runKey, {
        employeeId: entry.employeeId,
        cardId: entry.cardId,
        format: entry.format,
        startDateBefore: entry.startDateBefore,
        startDateTarget: entry.startDateTarget,
        expirationDateBefore: entry.expirationDateBefore,
        expirationDateTarget: entry.expirationDateTarget,
        outcome: entry.event === 'prepared' ? null : entry.event,
        expirationDateAfter: entry.event === 'prepared' ? null : entry.expirationDateAfter,
        startDateAfter: entry.event === 'prepared' ? null : entry.startDateAfter,
        preparedAt: entry.event === 'prepared' ? entry.at : null,
        terminalAt: entry.event === 'prepared' ? null : entry.at,
        error: entry.error,
        file: entry.file,
        sources: [`${entry.file}:${entry.line}`],
        reattempted: false,
      });
      continue;
    }

    const mismatch = mismatchField(existing, entry);
    if (mismatch) {
      throw new Error(
        `${entry.file}:${entry.line}: карта ${entry.cardId} (сотрудник ${entry.employeeId}) — поле ${mismatch}`
        + ` расходится с ${existing.sources[0]} внутри одного журнала`,
      );
    }
    existing.sources.push(`${entry.file}:${entry.line}`);
    existing.format = existing.format ?? entry.format;
    if (entry.event === 'prepared') {
      existing.preparedAt = existing.preparedAt ?? entry.at;
      continue;
    }
    existing.outcome = entry.event;
    existing.terminalAt = entry.at;
    existing.expirationDateAfter = entry.expirationDateAfter;
    existing.startDateAfter = entry.startDateAfter;
    existing.error = entry.error;
  }

  const byFile = new Map<string, IJournalRecord[]>();
  const records = new Map<string, IJournalRecord>();
  for (const record of perRun.values()) {
    const list = byFile.get(record.file) ?? [];
    list.push(record);
    byFile.set(record.file, list);

    const key = journalKey(record.employeeId, record.cardId);
    const current = records.get(key);
    if (!current) { records.set(key, record); continue; }

    const currentAt = normalizeTimestamp(current.terminalAt ?? current.preparedAt) ?? 0;
    const nextAt = normalizeTimestamp(record.terminalAt ?? record.preparedAt) ?? 0;
    if (currentAt === nextAt) {
      throw new Error(
        `карта ${record.cardId} (сотрудник ${record.employeeId}) встречается в ${current.file} и ${record.file}`
        + ' с одинаковым временем — какое состояние позднее, определить нечем',
      );
    }
    const authoritative = nextAt > currentAt ? record : current;
    const older = nextAt > currentAt ? current : record;
    authoritative.reattempted = true;
    authoritative.sources = [...older.sources, ...authoritative.sources];
    records.set(key, authoritative);
  }
  return { records, byFile };
}

/** Операция плана: то, что прогон СОБИРАЛСЯ сделать с картой. */
export interface IPlanOperation {
  employeeId: number;
  cardId: number;
  startDate: string | null;
  expirationDate: string | null;
  format?: string | null;
}

/** Поля plan-файла, существенные для аудита. */
export interface IPlanSummary {
  connection: string;
  scope: readonly string[];
  expirationTarget: string;
  syntheticStartDate: string | null;
  operations: readonly IPlanOperation[];
  planHash: string;
}

export interface IPlanMatchInput {
  runLabel: string;
  plan: IPlanSummary;
  /** Хеш, пересчитанный из тела плана. */
  recomputedPlanHash: string;
  /** SHA256 confirmation-файла этого прогона. */
  confirmationsSha256: string;
  /** confirmationsSha256, записанный в плане. */
  planConfirmationsSha256: string;
  /** Текущий контур Sigur. */
  liveConnection: string;
  /** Скоуп аудита. */
  auditScope: readonly string[];
  /** Свёрнутые журнальные записи этого прогона. */
  records: readonly IJournalRecord[];
}

export interface IPlanMatchResult {
  /** Фатальные расхождения: аудит по этому прогону недостоверен. */
  fatals: string[];
  /** Операции плана, по которым в журнале нет ни одной записи. */
  missingInJournal: IPlanOperation[];
  /** Записи журнала, которых нет в плане. */
  unknownInPlan: IJournalRecord[];
}

/**
 * Сверка «план ↔ журнал». Проверяется всё, что связывает прогон с его исходными данными:
 * хеш плана, хеш confirmation, контур, скоуп и совпадение целевых/исходных дат по каждой карте.
 * Без этого журнал доказывает только «что-то писалось», но не «писалось по этому плану».
 */
export function matchJournalToPlan(input: IPlanMatchInput): IPlanMatchResult {
  const fatals: string[] = [];
  const label = input.runLabel;

  if (input.plan.planHash !== input.recomputedPlanHash) {
    fatals.push(`${label}: planHash не сходится — план изменён после прогона`);
  }
  if (input.plan.connection !== input.liveConnection) {
    fatals.push(
      `${label}: план собран на контуре "${input.plan.connection}", а проверка идёт на "${input.liveConnection}"`,
    );
  }
  if (input.planConfirmationsSha256 !== input.confirmationsSha256) {
    fatals.push(`${label}: confirmation-файл не тот, по которому строился план`);
  }
  const auditScope = new Set(input.auditScope);
  const outOfScope = input.plan.scope.filter(part => !auditScope.has(part));
  if (outOfScope.length > 0) {
    fatals.push(`${label}: план включает скоуп ${outOfScope.join(', ')}, не входящий в проверяемый`);
  }

  const byKey = new Map<string, IPlanOperation>();
  for (const operation of input.plan.operations) {
    const key = journalKey(operation.employeeId, operation.cardId);
    if (byKey.has(key)) {
      fatals.push(`${label}: в плане дубль операции для карты ${operation.cardId} (сотрудник ${operation.employeeId})`);
      continue;
    }
    byKey.set(key, operation);
  }

  const seen = new Set<string>();
  const unknownInPlan: IJournalRecord[] = [];
  for (const record of input.records) {
    const key = journalKey(record.employeeId, record.cardId);
    const operation = byKey.get(key);
    if (!operation) { unknownInPlan.push(record); continue; }
    seen.add(key);

    if (!datesEqual(record.expirationDateTarget, input.plan.expirationTarget)) {
      fatals.push(
        `${label}: карта ${record.cardId} — целевой срок журнала "${record.expirationDateTarget}"`
        + ` ≠ плановому "${input.plan.expirationTarget}"`,
      );
    }
    if (record.startDateTarget && !datesEqual(record.startDateTarget, input.plan.syntheticStartDate)) {
      fatals.push(
        `${label}: карта ${record.cardId} — служебная дата начала "${record.startDateTarget}"`
        + ` ≠ плановой "${input.plan.syntheticStartDate}"`,
      );
    }
    if (!datesEqual(record.startDateBefore, operation.startDate)
      || !datesEqual(record.expirationDateBefore, operation.expirationDate)) {
      fatals.push(`${label}: карта ${record.cardId} — исходные даты журнала расходятся с планом`);
    }
  }

  const missingInJournal = [...byKey.entries()]
    .filter(([key]) => !seen.has(key))
    .map(([, operation]) => operation);

  return { fatals, missingInJournal, unknownInPlan };
}

/**
 * Живое состояние карты для аудита: все привязки, найденные по cardId.
 * Читается БЕЗ фильтра по владельцу — иначе перепривязка к другому человеку выглядит
 * как «привязки нет» и маскирует смену держателя.
 */
export interface ILiveCardState {
  /** GET не удался — состояние неизвестно. */
  readFailed: boolean;
  bindings: readonly ILiveBinding[];
}

export type VerificationVerdict =
  | 'still_blocked'
  | 'reconciled_blocked'
  | 'blocked_after_not_applied'
  | 'not_applied_confirmed'
  | 'expiration_extended'
  | 'expiration_changed'
  | 'expiration_removed'
  | 'invalid_expiration'
  | 'start_date_drift'
  | 'third_state'
  | 'owner_drift'
  | 'binding_gone'
  | 'binding_ambiguous'
  | 'read_failed';

/** Вердикты, означающие «карта сейчас погашена». */
export const BLOCKED_VERDICTS: readonly VerificationVerdict[] = [
  'still_blocked',
  'reconciled_blocked',
  'blocked_after_not_applied',
];

/** Незакрытый хвост: гашение не подтверждено, но и аномалией это не является. */
export const TAIL_VERDICTS: readonly VerificationVerdict[] = ['not_applied_confirmed'];

export function isAnomalyVerdict(verdict: VerificationVerdict): boolean {
  return !BLOCKED_VERDICTS.includes(verdict) && !TAIL_VERDICTS.includes(verdict);
}

export interface IVerificationInput {
  /** Ожидаемое состояние по журналу/плану. */
  expected: {
    employeeId: number;
    cardId: number;
    expirationTarget: string;
    expirationBefore: string | null;
    /** Служебная дата начала, если прогон её писал. */
    startDateTarget: string | null;
    /** Терминальный исход прогона; null — только `prepared` либо операция без журнала. */
    outcome: WriteOutcome | null;
  };
  live: ILiveCardState;
}

/**
 * Вердикт по одной карте: что журнал обещал против того, что в Sigur сейчас.
 *
 * Терминальный исход прогона роли почти не играет — авторитетно только живое состояние.
 * Он влияет лишь на название вердикта, чтобы в отчёте было видно, где запись «дозрела»
 * после `not_applied`/`unknown`, а где сработала штатно.
 */
export function classifyBlockVerification(input: IVerificationInput): VerificationVerdict {
  const { expected, live } = input;
  if (live.readFailed) return 'read_failed';
  if (live.bindings.length === 0) return 'binding_gone';
  // Больше одной привязки на карту — неоднозначность независимо от владельцев и форматов.
  if (live.bindings.length > 1) return 'binding_ambiguous';

  const [binding] = live.bindings;
  if (binding.cardId !== null && binding.cardId !== expected.cardId) return 'binding_gone';
  if (binding.employeeId !== expected.employeeId) return 'owner_drift';

  if (!binding.expirationDate) return 'expiration_removed';
  const liveExpiration = normalizeTimestamp(binding.expirationDate);
  if (liveExpiration === null) return 'invalid_expiration';

  if (datesEqual(binding.expirationDate, expected.expirationTarget)) {
    // Срок на месте, но служебная дата начала не встала — состояние половинчатое.
    if (expected.startDateTarget && !datesEqual(binding.startDate, expected.startDateTarget)) {
      return 'start_date_drift';
    }
    if (expected.outcome === 'committed') return 'still_blocked';
    if (expected.outcome === 'not_applied') return 'blocked_after_not_applied';
    return 'reconciled_blocked';
  }

  if (datesEqual(binding.expirationDate, expected.expirationBefore)) return 'not_applied_confirmed';

  const target = normalizeTimestamp(expected.expirationTarget);
  if (target !== null && liveExpiration > target) return 'expiration_extended';
  return 'expiration_changed';
}

/**
 * Итоговый код возврата. Приоритет фиксирован: аномалия важнее хвоста, хвост важнее
 * неполноты. «Частичный» прогон не может закончиться нулём — иначе успешная проба на
 * пяти картах прочитается как пройденный аудит.
 */
export function resolveExitCode(params: {
  anomalies: number;
  tail: number;
  partial: boolean;
}): 0 | 1 | 2 | 3 {
  if (params.anomalies > 0) return 1;
  if (params.tail > 0) return 2;
  if (params.partial) return 3;
  return 0;
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
