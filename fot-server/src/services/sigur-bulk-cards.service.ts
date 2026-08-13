/**
 * Массовое ПРОДЛЕНИЕ срока действия карт выбранным сотрудникам Sigur (страница SIGUR).
 *
 * Главный принцип: операция обязана быть буквально тем же сохранением, что кнопка
 * «Сохранить» в карточке сотрудника, повторённым N раз. Поэтому запись идёт через
 * общее ядро applyCardExpirationChange, а этот сервис отвечает только за выбор,
 * классификацию, очередь, прогресс и согласованность с локальной БД.
 *
 * Чего операция не делает: не создаёт и не перепривязывает карты, не блокирует
 * сотрудников, не трогает точки доступа, НИКОГДА не сокращает срок (ни в Sigur,
 * ни в contractor_passes) и не превращает бессрочную карту в срочную.
 *
 * Отдельная осторожность с истёкшими картами: гашение старых пропусков в этом
 * контуре сделано просрочкой привязки, поэтому «истёкшая» карта может быть
 * погашена намеренно. Такие продлеваются только при confirmExpired.
 */
import { query, execute } from '../config/postgres.js';
import { sigurService } from './sigur.service.js';
import type { ConnectionType } from './sigur-base.service.js';
import {
  toEmployeeCardBinding,
  buildCardW26ById,
  invalidateSigurDirectoryCaches,
  type IEmployeeCardBinding,
} from './sigur-live-admin.service.js';
import { applyCardExpirationChange } from './sigur-live-cards.service.js';
import { deriveCardW26, formatW26 } from './sigur-card-w26.util.js';
import { moscowEndOfDayIso } from '../utils/date.utils.js';
import {
  acquireSigurCardLease,
  type ISigurCardLeaseHandle,
} from './sigur-card-lease.service.js';

/** Параллельность обработки сотрудников; HTTP к Sigur дополнительно троттлится SIGUR_MAX_CONCURRENCY. */
const BULK_CONCURRENCY = 5;

/** Сколько id отдаём Sigur одним батч-запросом привязок. */
const BINDINGS_BATCH_SIZE = 100;

/** Параллельность индивидуального добора привязок (как в getSigurEmployeeCardStatuses). */
const SINGLE_READ_CONCURRENCY = 8;

/** TTL lease массовой операции: 500 сотрудников заметно дольше одного тика heartbeat. */
const BULK_LEASE_TTL_SECONDS = 300;

export type BulkExtendSkipReason =
  | 'already_longer'
  | 'no_expiration'
  | 'no_start_date'
  | 'start_after_target'
  | 'expired_not_confirmed'
  | 'changed_since_snapshot'
  | 'not_in_preview'
  | 'invalid_card_id'
  | 'invalid_start_date'
  | 'invalid_expiration_date'
  | 'duplicate_binding'
  | 'conflicting_duplicate_binding';

export type BulkExtendCardStatus =
  | 'candidate'
  | 'extended'
  | 'extended_after_retry'
  | 'failed'
  | 'changed_during_write'
  | 'unknown'
  | 'skipped';

export type BulkExtendLocalStatus =
  | 'pending'
  | 'local_updated'
  | 'local_already_longer'
  | 'local_no_expiration'
  | 'local_sync_failed'
  | 'local_unknown';

export interface IBulkExtendPassPlan {
  passId: string;
  passNumber: string | null;
  previousExpiresAt: string | null;
  previousCardUid: string | null;
  previousCardHexUid: string | null;
  localStatus: BulkExtendLocalStatus;
}

export interface IBulkExtendCardPlan {
  employeeId: number;
  cardId: number | null;
  previousExpiration: string | null;
  startDate: string | null;
  format: string | null;
  status: BulkExtendCardStatus;
  reason: BulkExtendSkipReason | null;
  /** Фактический срок, прочитанный при разборе неудачного PATCH (changed_during_write). */
  observedExpiration?: string | null;
  error?: string;
  passes: IBulkExtendPassPlan[];
}

export interface IBulkExtendPlan {
  operationId: string;
  connection?: ConnectionType;
  expirationDate: string;
  targetIso: string;
  confirmExpired: boolean;
  employeeIds: number[];
  /** Сотрудники без карт — подтверждено индивидуальным чтением. */
  noCardEmployeeIds: number[];
  /** Сотрудники, чьи привязки прочитать не удалось: fail-closed, в ошибки. */
  unreadableEmployeeIds: number[];
  items: IBulkExtendCardPlan[];
}

export type BulkExtendProgressEvent =
  | { type: 'start'; total: number }
  | {
      type: 'progress';
      processed: number;
      total: number;
      employeeId: number;
      okCards: number;
      failedCards: number;
    };

export interface IBulkExtendResult {
  operationId: string;
  requestedEmployees: number;
  updatedEmployees: number;
  updatedCards: number;
  retriedCards: number;
  unknownCards: number;
  changedDuringWriteCards: number;
  skippedCards: number;
  failedCards: number;
  expiredExtendedCards: number;
  noCardEmployees: number;
  unreadableEmployees: number;
  localUpdatedPasses: number;
  localSyncFailedPasses: number;
  localUnknownPasses: number;
  failedEmployeeIds: number[];
  warnings: string[];
  items: IBulkExtendCardPlan[];
}

export interface IBulkExtendPreview {
  expirationDate: string;
  targetIso: string;
  requestedEmployees: number;
  willExtendCards: number;
  expiredCards: number;
  skippedCards: number;
  noCardEmployees: number;
  unreadableEmployees: number;
  byReason: Record<string, number>;
  /** Карты-кандидаты — из них строится подписанный previewToken. */
  cards: Array<{
    employeeId: number;
    cardId: number;
    startDate: string | null;
    expirationDate: string | null;
    format: string | null;
    expired: boolean;
  }>;
}

interface ILinkedPassRow {
  id: string;
  sigur_employee_id: string | number;
  pass_number: string | null;
  card_uid: string | null;
  card_hex_uid: string | null;
  expires_at: string | null;
}

/** Ожидаемая карта из предпросмотра — контракт previewToken. */
export interface IExpectedCard {
  employeeId: number;
  cardId: number;
  startDate: string | null;
  expirationDate: string | null;
  format: string | null;
}

/** Обработать элементы с ограниченной параллельностью (курсорные воркеры). */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

export function normalizeEmployeeIds(ids: readonly unknown[]): number[] {
  return Array.from(new Set(
    ids
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value > 0),
  ));
}

const parseTime = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

interface ICollectedBindings {
  byEmployee: Map<number, IEmployeeCardBinding[]>;
  unreadable: number[];
}

/**
 * Чтение привязок по списку сотрудников — fail-closed.
 *
 * Батч Sigur отдаёт неполный ответ (наблюдалось на пагинации сотрудников), поэтому
 * КАЖДЫЙ не встреченный в батче сотрудник дочитывается индивидуально. Только успешный
 * пустой индивидуальный ответ означает «карт нет»; ошибка чтения даёт unreadable —
 * такого сотрудника мы не трогаем и показываем в ошибках, а не в пропусках.
 */
export async function collectCardBindings(
  employeeIds: number[],
  connection?: ConnectionType,
): Promise<ICollectedBindings> {
  const byEmployee = new Map<number, IEmployeeCardBinding[]>();
  const unreadable: number[] = [];
  const pending = new Set<number>(employeeIds);

  for (let index = 0; index < employeeIds.length; index += BINDINGS_BATCH_SIZE) {
    const chunk = employeeIds.slice(index, index + BINDINGS_BATCH_SIZE);
    try {
      const raw = await sigurService.getCardBindings(
        { employeeId: chunk.join(',') },
        connection,
      ) as Record<string, unknown>[];

      raw
        .map(item => toEmployeeCardBinding(item))
        .filter((item): item is IEmployeeCardBinding => !!item && pending.has(item.employeeId))
        .forEach(item => {
          const bucket = byEmployee.get(item.employeeId) || [];
          bucket.push(item);
          byEmployee.set(item.employeeId, bucket);
          pending.delete(item.employeeId);
        });
    } catch (error) {
      console.warn('[bulk-extend] batch bindings read warning:', error);
    }
  }

  // Индивидуальный добор: батч мог промолчать и про сотрудника с картой.
  const remaining = [...pending];
  await runWithConcurrency(remaining, SINGLE_READ_CONCURRENCY, async employeeId => {
    try {
      const raw = await sigurService.getCardBindings({ employeeId }, connection) as Record<string, unknown>[];
      const bindings = raw
        .map(item => toEmployeeCardBinding(item))
        .filter((item): item is IEmployeeCardBinding => !!item && item.employeeId === employeeId);
      byEmployee.set(employeeId, bindings);
    } catch (error) {
      console.warn(`[bulk-extend] bindings read failed for ${employeeId}:`, error);
      unreadable.push(employeeId);
    }
  });

  return { byEmployee, unreadable };
}

interface IClassifyParams {
  bindings: IEmployeeCardBinding[];
  targetMs: number;
  nowMs: number;
  confirmExpired: boolean;
  expectedByKey: Map<string, IExpectedCard> | null;
}

const cardKey = (employeeId: number, cardId: number): string => `${employeeId}:${cardId}`;

/**
 * Классификация карт одного сотрудника под целевую дату.
 * Все причины пропуска определяются ДО записи — ядро вызывается только для кандидатов.
 */
function classifyEmployeeCards(params: IClassifyParams): Array<Omit<IBulkExtendCardPlan, 'passes'>> {
  const { bindings, targetMs, nowMs, confirmExpired, expectedByKey } = params;

  const seen = new Map<string, number>();
  bindings.forEach(binding => {
    if (binding.cardId == null) return;
    const key = cardKey(binding.employeeId, binding.cardId);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  });

  return bindings.map(binding => {
    const base = {
      employeeId: binding.employeeId,
      cardId: binding.cardId,
      previousExpiration: binding.expirationDate,
      startDate: binding.startDate,
      format: binding.format,
    };

    const skip = (reason: BulkExtendSkipReason) => ({
      ...base,
      status: 'skipped' as const,
      reason,
    });

    if (binding.cardId == null) return skip('invalid_card_id');
    if ((seen.get(cardKey(binding.employeeId, binding.cardId)) ?? 0) > 1) return skip('duplicate_binding');

    if (!binding.startDate) return skip('no_start_date');
    const startMs = parseTime(binding.startDate);
    if (startMs == null) return skip('invalid_start_date');
    // Начало в тот же календарный день допустимо: сравниваем моменты, а не даты.
    if (startMs > targetMs) return skip('start_after_target');

    // Бессрочную карту срочной не делаем.
    if (!binding.expirationDate) return skip('no_expiration');
    const currentMs = parseTime(binding.expirationDate);
    if (currentMs == null) return skip('invalid_expiration_date');

    // Срок не сокращаем никогда.
    if (currentMs >= targetMs) return skip('already_longer');

    const expired = currentMs < nowMs;
    if (expired && !confirmExpired) return skip('expired_not_confirmed');

    if (expectedByKey) {
      const expected = expectedByKey.get(cardKey(binding.employeeId, binding.cardId));
      if (!expected) return skip('not_in_preview');
      if (
        expected.startDate !== binding.startDate
        || expected.expirationDate !== binding.expirationDate
        || (expected.format ?? null) !== (binding.format ?? null)
      ) {
        return skip('changed_since_snapshot');
      }
    }

    return { ...base, status: 'candidate' as const, reason: null };
  });
}

/** Предпросмотр под конкретную дату: тот же классификатор, что и у записи. */
export async function previewBulkExtendCards(params: {
  employeeIds: number[];
  expirationDate: string;
  connection?: ConnectionType;
}): Promise<IBulkExtendPreview> {
  const { employeeIds, expirationDate, connection } = params;
  const targetIso = moscowEndOfDayIso(expirationDate);
  const targetMs = new Date(targetIso).getTime();
  const nowMs = Date.now();

  const { byEmployee, unreadable } = await collectCardBindings(employeeIds, connection);

  const byReason: Record<string, number> = {};
  const cards: IBulkExtendPreview['cards'] = [];
  let willExtendCards = 0;
  let expiredCards = 0;
  let skippedCards = 0;
  let noCardEmployees = 0;

  const unreadableSet = new Set(unreadable);

  for (const employeeId of employeeIds) {
    if (unreadableSet.has(employeeId)) continue;
    const bindings = byEmployee.get(employeeId) || [];
    if (bindings.length === 0) {
      noCardEmployees += 1;
      continue;
    }

    const classified = classifyEmployeeCards({
      bindings,
      targetMs,
      nowMs,
      // В предпросмотре истёкшие показываем отдельной строкой, а не прячем.
      confirmExpired: true,
      expectedByKey: null,
    });

    classified.forEach(item => {
      if (item.status === 'candidate' && item.cardId != null) {
        willExtendCards += 1;
        const currentMs = parseTime(item.previousExpiration);
        const expired = currentMs != null && currentMs < nowMs;
        if (expired) expiredCards += 1;
        cards.push({
          employeeId: item.employeeId,
          cardId: item.cardId,
          startDate: item.startDate,
          expirationDate: item.previousExpiration,
          format: item.format,
          expired,
        });
        return;
      }
      skippedCards += 1;
      if (item.reason) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
    });
  }

  return {
    expirationDate,
    targetIso,
    requestedEmployees: employeeIds.length,
    willExtendCards,
    expiredCards,
    skippedCards,
    noCardEmployees,
    unreadableEmployees: unreadable.length,
    byReason,
    cards,
  };
}

/** Связанные подрядные пропуска, разложенные по КОНКРЕТНОЙ карте (а не по сотруднику). */
async function loadLinkedPassesByCard(
  employeeIds: number[],
  connection?: ConnectionType,
): Promise<Map<string, IBulkExtendPassPlan[]>> {
  const result = new Map<string, IBulkExtendPassPlan[]>();
  if (employeeIds.length === 0) return result;

  const rows = await query<ILinkedPassRow>(
    `SELECT id, sigur_employee_id, pass_number, card_uid, card_hex_uid, expires_at
       FROM contractor_passes
      WHERE sigur_employee_id = ANY($1::bigint[])
        AND (status = 'applied' OR is_active = true)`,
    [employeeIds],
  );
  if (rows.length === 0) return result;

  const cardW26ById = await buildCardW26ById(connection);

  const w26Of = (uid: string | null): string | null => {
    if (!uid || !uid.trim()) return null;
    try {
      return formatW26(deriveCardW26(uid));
    } catch {
      return null;
    }
  };

  for (const row of rows) {
    const employeeId = Number(row.sigur_employee_id);
    if (!Number.isFinite(employeeId)) continue;

    // Оба идентификатора пробуем независимо: card_uid и card_hex_uid могут
    // разойтись, и «взять первый непустой» скрыло бы расхождение.
    const passW26 = new Set<string>();
    const fromUid = w26Of(row.card_uid);
    const fromHex = w26Of(row.card_hex_uid);
    if (fromUid) passW26.add(fromUid);
    if (fromHex) passW26.add(fromHex);
    if (passW26.size === 0) continue;

    for (const [cardIdStr, cardW26] of cardW26ById) {
      if (!passW26.has(cardW26)) continue;
      const key = cardKey(employeeId, Number(cardIdStr));
      const bucket = result.get(key) || [];
      if (bucket.some(item => item.passId === row.id)) continue;
      bucket.push({
        passId: row.id,
        passNumber: row.pass_number,
        previousExpiresAt: row.expires_at,
        previousCardUid: row.card_uid,
        previousCardHexUid: row.card_hex_uid,
        localStatus: 'pending',
      });
      result.set(key, bucket);
    }
  }

  // Неоднозначность (одна карта → несколько пропусков) — fail-closed: локально не пишем.
  for (const [key, passes] of result) {
    if (passes.length > 1) {
      result.set(key, passes.map(pass => ({ ...pass, localStatus: 'local_sync_failed' as const })));
    }
  }

  return result;
}

export interface IPreparedBulkExtend {
  plan: IBulkExtendPlan;
  lease: ISigurCardLeaseHandle;
}

/**
 * Фаза A: берём lock, читаем свежий снимок, классифицируем, раскладываем пропуска.
 * К Sigur на запись здесь не обращаемся — между этой фазой и записью контроллер
 * обязан сохранить started-аудит.
 */
export async function prepareBulkExtendOperation(params: {
  operationId: string;
  employeeIds: number[];
  expirationDate: string;
  confirmExpired: boolean;
  expected: IExpectedCard[];
  connection?: ConnectionType;
}): Promise<IPreparedBulkExtend> {
  const { operationId, employeeIds, expirationDate, confirmExpired, expected, connection } = params;

  const lease = await acquireSigurCardLease({
    owner: operationId,
    ttlSeconds: BULK_LEASE_TTL_SECONDS,
    meta: { kind: 'bulk_card_extend', operationId, employees: employeeIds.length },
  });

  try {
    const targetIso = moscowEndOfDayIso(expirationDate);
    const targetMs = new Date(targetIso).getTime();
    const nowMs = Date.now();

    const expectedByKey = new Map<string, IExpectedCard>(
      expected.map(card => [cardKey(card.employeeId, card.cardId), card]),
    );

    const { byEmployee, unreadable } = await collectCardBindings(employeeIds, connection);
    const unreadableSet = new Set(unreadable);
    const passesByCard = await loadLinkedPassesByCard(employeeIds, connection);

    const items: IBulkExtendCardPlan[] = [];
    const noCardEmployeeIds: number[] = [];

    for (const employeeId of employeeIds) {
      if (unreadableSet.has(employeeId)) continue;
      const bindings = byEmployee.get(employeeId) || [];
      if (bindings.length === 0) {
        noCardEmployeeIds.push(employeeId);
        continue;
      }

      classifyEmployeeCards({ bindings, targetMs, nowMs, confirmExpired, expectedByKey })
        .forEach(item => {
          const passes = item.cardId != null
            ? (passesByCard.get(cardKey(item.employeeId, item.cardId)) || [])
            : [];
          items.push({ ...item, passes: passes.map(pass => ({ ...pass })) });
        });
    }

    return {
      lease,
      plan: {
        operationId,
        connection,
        expirationDate,
        targetIso,
        confirmExpired,
        employeeIds,
        noCardEmployeeIds,
        unreadableEmployeeIds: unreadable,
        items,
      },
    };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

/** Разбор неудачного PATCH: запись могла пройти — клиент ретраит 5xx и сетевые сбои. */
async function classifyWriteFailure(
  item: IBulkExtendCardPlan,
  plan: IBulkExtendPlan,
): Promise<{ status: BulkExtendCardStatus; observedExpiration?: string | null }> {
  try {
    const raw = await sigurService.getCardBindings(
      { employeeId: item.employeeId, cardId: item.cardId as number },
      plan.connection,
    ) as Record<string, unknown>[];

    const binding = raw
      .map(row => toEmployeeCardBinding(row))
      .filter((row): row is IEmployeeCardBinding => !!row && row.cardId === item.cardId)
      .find(row => row.employeeId === item.employeeId);

    if (!binding) return { status: 'unknown' };

    const observedMs = parseTime(binding.expirationDate);
    const targetMs = new Date(plan.targetIso).getTime();
    const previousMs = parseTime(item.previousExpiration);

    if (observedMs === targetMs) return { status: 'extended_after_retry' };
    if (observedMs === previousMs) return { status: 'failed' };
    return { status: 'changed_during_write', observedExpiration: binding.expirationDate };
  } catch (error) {
    console.warn(`[bulk-extend] verify read failed for card ${item.cardId}:`, error);
    return { status: 'unknown' };
  }
}

/**
 * Локальная синхронизация срока подрядного пропуска — строгий CAS по снимку.
 * Каждый идентификатор карты проверяется отдельно: подмена одного из них не должна
 * пройти незамеченной. Ноль обновлённых строк — расхождение, второй раз не пишем.
 */
async function syncLinkedPass(
  pass: IBulkExtendPassPlan,
  item: IBulkExtendCardPlan,
  plan: IBulkExtendPlan,
): Promise<BulkExtendLocalStatus> {
  if (pass.localStatus === 'local_sync_failed') return pass.localStatus;
  if (!pass.previousExpiresAt) return 'local_no_expiration';

  const targetDate = plan.expirationDate;
  if (pass.previousExpiresAt.slice(0, 10) >= targetDate) return 'local_already_longer';

  try {
    const affected = await execute(
      `UPDATE contractor_passes
          SET expires_at = $1::date, updated_at = now()
        WHERE id = $2::uuid
          AND sigur_employee_id = $3::bigint
          AND card_uid IS NOT DISTINCT FROM $4
          AND card_hex_uid IS NOT DISTINCT FROM $5
          AND expires_at = $6::date
          AND expires_at < $1::date`,
      [
        targetDate,
        pass.passId,
        item.employeeId,
        pass.previousCardUid,
        pass.previousCardHexUid,
        pass.previousExpiresAt,
      ],
    );
    return affected > 0 ? 'local_updated' : 'local_sync_failed';
  } catch (error) {
    console.error(`[bulk-extend] local sync failed for pass ${pass.passId}:`, error);
    // Ошибка UPDATE ещё не значит, что записи не было — перечитываем.
    try {
      const rows = await query<{ expires_at: string | null }>(
        `SELECT expires_at FROM contractor_passes WHERE id = $1::uuid`,
        [pass.passId],
      );
      const actual = rows[0]?.expires_at ?? null;
      if (actual && actual.slice(0, 10) === targetDate) return 'local_updated';
      return 'local_sync_failed';
    } catch {
      return 'local_unknown';
    }
  }
}

/**
 * Фаза C: запись. PATCH идёт ТОЛЬКО через общее ядро — то же, что вызывает кнопка
 * «Сохранить». Перед каждой записью карта перечитывается: снимок мог устареть, а
 * параллельная операция могла поставить более поздний срок, который сокращать нельзя.
 */
export async function executePreparedBulkExtend(
  prepared: IPreparedBulkExtend,
  onProgress: (event: BulkExtendProgressEvent) => void,
): Promise<IBulkExtendResult> {
  const { plan, lease } = prepared;
  const nowMs = Date.now();
  const targetMs = new Date(plan.targetIso).getTime();

  const byEmployee = new Map<number, IBulkExtendCardPlan[]>();
  plan.items.forEach(item => {
    const bucket = byEmployee.get(item.employeeId) || [];
    bucket.push(item);
    byEmployee.set(item.employeeId, bucket);
  });

  const employeeIds = [...byEmployee.keys()];
  const total = employeeIds.length;
  const warnings: string[] = [];
  const failedEmployeeIds: number[] = [];
  let processed = 0;
  let touchedSigur = false;

  onProgress({ type: 'start', total });

  await runWithConcurrency(employeeIds, BULK_CONCURRENCY, async employeeId => {
    const items = byEmployee.get(employeeId) || [];
    let okCards = 0;
    let failedCards = 0;

    for (const item of items) {
      if (item.status !== 'candidate' || item.cardId == null || !item.startDate) continue;

      if (lease.isLost()) {
        item.status = 'skipped';
        item.reason = 'changed_since_snapshot';
        item.error = 'Блокировка операции потеряна — запись прекращена';
        continue;
      }

      // Перечитывание непосредственно перед записью.
      let fresh: IEmployeeCardBinding | null = null;
      try {
        const raw = await sigurService.getCardBindings(
          { employeeId, cardId: item.cardId },
          plan.connection,
        ) as Record<string, unknown>[];
        fresh = raw
          .map(row => toEmployeeCardBinding(row))
          .filter((row): row is IEmployeeCardBinding => !!row && row.cardId === item.cardId)
          .find(row => row.employeeId === employeeId) ?? null;
      } catch (error) {
        item.status = 'failed';
        item.error = error instanceof Error ? error.message : String(error);
        failedCards += 1;
        warnings.push(`Сотрудник ${employeeId}, карта ${item.cardId}: не удалось перечитать привязку`);
        continue;
      }

      const freshExpirationMs = parseTime(fresh?.expirationDate ?? null);
      if (
        !fresh
        || !fresh.startDate
        || fresh.startDate !== item.startDate
        || (fresh.format ?? null) !== (item.format ?? null)
        || freshExpirationMs == null
        || freshExpirationMs >= targetMs
      ) {
        item.status = 'skipped';
        item.reason = 'changed_since_snapshot';
        item.observedExpiration = fresh?.expirationDate ?? null;
        continue;
      }

      const wasExpired = freshExpirationMs < nowMs;

      try {
        touchedSigur = true;
        await applyCardExpirationChange({
          sigurEmployeeId: employeeId,
          cardId: item.cardId,
          startDate: fresh.startDate,
          expirationDate: plan.targetIso,
          connection: plan.connection,
          format: fresh.format,
        });
        item.status = 'extended';
        okCards += 1;
      } catch (error) {
        item.error = error instanceof Error ? error.message : String(error);
        const verdict = await classifyWriteFailure(item, plan);
        item.status = verdict.status;
        if (verdict.observedExpiration !== undefined) item.observedExpiration = verdict.observedExpiration;

        if (verdict.status === 'extended_after_retry') {
          okCards += 1;
        } else {
          failedCards += 1;
          warnings.push(
            `Сотрудник ${employeeId}, карта ${item.cardId}: ${verdict.status === 'unknown'
              ? 'результат записи не подтверждён'
              : verdict.status === 'changed_during_write'
                ? 'срок изменён параллельно'
                : 'не удалось продлить'} — ${item.error}`,
          );
        }
      }

      const confirmed = item.status === 'extended' || item.status === 'extended_after_retry';
      if (confirmed) {
        if (wasExpired) item.reason = null;
        (item as IBulkExtendCardPlan & { expiredExtended?: boolean }).expiredExtended = wasExpired;
        for (const pass of item.passes) {
          pass.localStatus = await syncLinkedPass(pass, item, plan);
        }
      }
    }

    if (failedCards > 0) failedEmployeeIds.push(employeeId);
    processed += 1;
    onProgress({ type: 'progress', processed, total, employeeId, okCards, failedCards });
  });

  if (lease.isLost()) {
    warnings.push('Блокировка операции была потеряна — часть карт осталась необработанной');
  }

  const counters = plan.items.reduce((acc, item) => {
    switch (item.status) {
      case 'extended': acc.updatedCards += 1; break;
      case 'extended_after_retry': acc.updatedCards += 1; acc.retriedCards += 1; break;
      case 'unknown': acc.unknownCards += 1; break;
      case 'changed_during_write': acc.changedDuringWriteCards += 1; break;
      case 'failed': acc.failedCards += 1; break;
      case 'skipped': acc.skippedCards += 1; break;
      default: break;
    }
    if ((item as { expiredExtended?: boolean }).expiredExtended) acc.expiredExtendedCards += 1;
    item.passes.forEach(pass => {
      if (pass.localStatus === 'local_updated') acc.localUpdatedPasses += 1;
      if (pass.localStatus === 'local_sync_failed') acc.localSyncFailedPasses += 1;
      if (pass.localStatus === 'local_unknown') acc.localUnknownPasses += 1;
    });
    return acc;
  }, {
    updatedCards: 0,
    retriedCards: 0,
    unknownCards: 0,
    changedDuringWriteCards: 0,
    failedCards: 0,
    skippedCards: 0,
    expiredExtendedCards: 0,
    localUpdatedPasses: 0,
    localSyncFailedPasses: 0,
    localUnknownPasses: 0,
  });

  const updatedEmployees = new Set(
    plan.items
      .filter(item => item.status === 'extended' || item.status === 'extended_after_retry')
      .map(item => item.employeeId),
  ).size;

  if (touchedSigur || counters.unknownCards > 0) {
    invalidateSigurDirectoryCaches();
  }

  return {
    operationId: plan.operationId,
    requestedEmployees: plan.employeeIds.length,
    updatedEmployees,
    ...counters,
    noCardEmployees: plan.noCardEmployeeIds.length,
    unreadableEmployees: plan.unreadableEmployeeIds.length,
    failedEmployeeIds: Array.from(new Set([...failedEmployeeIds, ...plan.unreadableEmployeeIds])),
    warnings,
    items: plan.items,
  };
}
