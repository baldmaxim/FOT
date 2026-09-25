/**
 * Синхронизация «Срока» подрядных пропусков (contractor_passes.expires_at) с Sigur.
 *
 * Фактический срок пропуска — expirationDate привязки «сотрудник ↔ карта» в Sigur. Его
 * меняют и в обход ФОТ (сайдбар SIGUR, Sigur Manager), поэтому «Мониторинг» расходился
 * с Sigur. Сервис зеркалит срок в обе стороны: продление, сокращение, бессрочно → NULL
 * (NULL и так означает «бессрочно», см. syncLinkedPass в sigur-bulk-cards.service.ts).
 * Вызывают ночной планировщик и CLI scripts/sync-contractor-pass-expiry.ts.
 *
 * Принципы:
 *  - пишем только однозначное: пропуск ↔ ровно одна карта каталога ↔ ровно одна привязка
 *    на профиле пропуска; всё спорное — в отчёт, без записи;
 *  - W26 выводится только из card_uid. card_hex_uid — полный серийник (CSN) вида 4877E100,
 *    а deriveCardW26 берёт из hex байты 1..3 кадра ридера — из CSN вышел бы чужой W26.
 *    card_hex_uid лишь сверяется в CAS как «не изменился»;
 *  - перед каждой записью привязка перечитывается по карте, запись — CAS по снимку, UPDATE
 *    и аудит в одной короткой транзакции; повторный прогон ничего не меняет;
 *  - предохранитель от массового сдвига дат (смена формата или часового пояса Sigur).
 *
 * Известное ограничение: чтение Sigur и запись в БД не атомарны. Lock sigur:card-write
 * не закрывает правку прямо в Sigur Manager между перечитыванием и UPDATE — её исправит
 * следующий прогон.
 */
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/node';
import { query, withTransaction } from '../config/postgres.js';
import { sigurService } from './sigur.service.js';
import type { ConnectionType } from './sigur-base.service.js';
import { collectCardBindings } from './sigur-bulk-cards.service.js';
import { normalizeInt, type IEmployeeCardBinding } from './sigur-live-admin.service.js';
import { resolveField } from './sigur-sync-shared.js';
import { deriveCardW26, deriveSigurCardIdentity, formatW26 } from './sigur-card-w26.util.js';
import { readLiveBindingsByCard } from './old-card-block.collect.js';
import type { ILiveBinding } from './old-card-block.util.js';
import { acquireSigurCardLease } from './sigur-card-lease.service.js';
import { auditService, AUDIT_ACTIONS } from './audit.service.js';
import { moscowTodayIso, parseIsoDateOnly } from '../utils/date.utils.js';

/** TTL lock записи сроков карт; heartbeat продлевает его на весь прогон. */
const CARD_LEASE_TTL_SECONDS = 300;

/** Предохранитель: блок, если правок больше MASS_CHANGE_MIN И больше половины скоупа. */
export const MASS_CHANGE_MIN = 100;
export const MASS_CHANGE_MAX_SHARE = 0.5;

export type SigurExpiration =
  | { kind: 'date'; date: string }
  | { kind: 'indefinite' }
  | { kind: 'invalid' };

/** Пропуск не попал в план. Все причины постоянные, кроме unreadable. */
export type PassExpirySkipReason =
  | 'invalid_card_uid'
  | 'ambiguous_w26'
  | 'card_multi_pass'
  | 'no_binding'
  | 'duplicate_binding'
  | 'invalid_date'
  | 'unreadable';

/** Сбой на этапе записи — временный: прогон partial, повтор. */
export type PassExpiryWriteIssue =
  | 'reread_failed'
  | 'changed_during_run'
  | 'conflict'
  | 'db_error'
  | 'aborted';

export type PassExpirySyncStatus = 'completed' | 'partial' | 'blocked';

const SKIP_REASONS: readonly PassExpirySkipReason[] = [
  'invalid_card_uid', 'ambiguous_w26', 'card_multi_pass', 'no_binding',
  'duplicate_binding', 'invalid_date', 'unreadable',
];

const WRITE_ISSUES: readonly PassExpiryWriteIssue[] = [
  'reread_failed', 'changed_during_run', 'conflict', 'db_error', 'aborted',
];

export interface IExpiryPassRow {
  id: string;
  pass_number: string;
  sigur_employee_id: number | string;
  card_uid: string | null;
  card_hex_uid: string | null;
  expires_at: string | null;
}

export interface IPassExpiryChange {
  passId: string;
  passNumber: string;
  sigurEmployeeId: number;
  cardId: number;
  cardUid: string | null;
  cardHexUid: string | null;
  oldExpiresAt: string | null;
  /** null — бессрочно. */
  newExpiresAt: string | null;
  /** Сырая строка срока из Sigur — для отчёта и аудита. */
  sigurExpiration: string | null;
  outcome: 'planned' | 'updated' | PassExpiryWriteIssue;
}

export interface IPassExpiryPlan {
  eligible: number;
  unchanged: number;
  changes: IPassExpiryChange[];
  /** Номера пропусков по причинам. */
  skipped: Record<PassExpirySkipReason, string[]>;
}

export interface IPassExpirySyncResult {
  runId: string;
  dryRun: boolean;
  status: PassExpirySyncStatus;
  /** Предохранитель сработал (в dry-run — сработал бы). */
  massChange: boolean;
  eligible: number;
  unchanged: number;
  updated: number;
  changes: IPassExpiryChange[];
  skipped: Record<PassExpirySkipReason, string[]>;
  writeIssues: Record<PassExpiryWriteIssue, string[]>;
}

export interface IRunPassExpirySyncParams {
  dryRun: boolean;
  /** Снимает только предохранитель массового сдвига. */
  force?: boolean;
  triggeredBy: 'scheduler' | 'cli';
  /** Внешний сигнал остановки записи (потеря суточного lease планировщика). */
  shouldAbort?: () => boolean;
}

const emptyBuckets = <K extends string>(keys: readonly K[]): Record<K, string[]> =>
  Object.fromEntries(keys.map(key => [key, [] as string[]])) as Record<K, string[]>;

// Шаблоны якорные: «2026-12-31 garbage» не должен сойти за дату.
const ZONED_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/;

const isValidClock = (hh: string, mm: string, ss: string | undefined): boolean =>
  Number(hh) <= 23 && Number(mm) <= 59 && (ss === undefined || Number(ss) <= 59);

/** 'Z' | '+0300' | '+03:00' → 'Z' | '+03:00'; null — смещение вне диапазона. */
const normalizeZone = (zone: string): string | null => {
  if (zone.toUpperCase() === 'Z') return 'Z';
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!match) return null;
  const [, sign, hh, mm] = match;
  if (Number(hh) > 14 || Number(mm) > 59) return null;
  return `${sign}${hh}:${mm}`;
};

/**
 * Срок привязки Sigur → календарная дата МСК. Строка с зоной переводится через момент
 * времени; без зоны — берётся дата как есть, без Date (не зависит от пояса процесса).
 * Пусто — бессрочно. Всё нераспознанное — invalid: такую дату в БД не пишем.
 */
export function sigurExpirationToMoscowDate(raw: string | null | undefined): SigurExpiration {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'indefinite' };

  const zoned = ZONED_RE.exec(text);
  if (zoned) {
    const [, datePart, hh, mm, ss, zone] = zoned;
    const offset = normalizeZone(zone);
    if (!parseIsoDateOnly(datePart) || !isValidClock(hh, mm, ss) || !offset) return { kind: 'invalid' };
    // Доли секунды отбрасываем: в пределах секунды дата МСК не меняется.
    const instant = new Date(`${datePart}T${hh}:${mm}:${ss ?? '00'}${offset}`);
    if (Number.isNaN(instant.getTime())) return { kind: 'invalid' };
    return { kind: 'date', date: moscowTodayIso(instant) };
  }

  const naive = NAIVE_RE.exec(text);
  if (naive) {
    const [, datePart, hh, mm, ss] = naive;
    if (!parseIsoDateOnly(datePart)) return { kind: 'invalid' };
    if (hh !== undefined && !isValidClock(hh, mm, ss)) return { kind: 'invalid' };
    return { kind: 'date', date: datePart };
  }

  return { kind: 'invalid' };
}

/**
 * Каталог карт → W26 → cardId. Идентичность — через deriveSigurCardIdentity, как в
 * old-card-block.collect: buildCardW26ById на 6-hex value падает в сырой formattedValue.
 * Set, а не массив: повтор одной записи каталога не должен давать ложную неоднозначность.
 */
export function buildCardIdsByW26(catalog: readonly Record<string, unknown>[]): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const raw of catalog) {
    const cardId = normalizeInt(resolveField(raw, 'id', 'ID', 'cardId', 'card_id'));
    if (!cardId) continue;
    const rawValue = String(resolveField<string>(raw, 'value', 'cardValue', 'card_value') ?? '').trim();
    const rawFormatted = String(resolveField<string>(raw, 'formattedValue', 'formatted_value') ?? '').trim();
    const { w26 } = deriveSigurCardIdentity(rawValue, rawFormatted);
    if (!w26) continue;
    const bucket = index.get(w26) ?? new Set<number>();
    bucket.add(cardId);
    index.set(w26, bucket);
  }
  return index;
}

const passW26 = (cardUid: string | null): string | null => {
  if (!cardUid || !cardUid.trim()) return null;
  try {
    return formatW26(deriveCardW26(cardUid));
  } catch {
    return null;
  }
};

/** План правок — чистая функция: сопоставление строго по карте, неоднозначность в обе стороны. */
export function planPassExpiryChanges(input: {
  passes: readonly IExpiryPassRow[];
  bindingsByEmployee: ReadonlyMap<number, readonly IEmployeeCardBinding[]>;
  unreadableEmployeeIds: ReadonlySet<number>;
  cardIdsByW26: ReadonlyMap<string, ReadonlySet<number>>;
}): IPassExpiryPlan {
  const skipped = emptyBuckets(SKIP_REASONS);
  const changes: IPassExpiryChange[] = [];
  let unchanged = 0;

  // Шаг 1: пропуск → единственная карта каталога.
  const candidates: Array<{ row: IExpiryPassRow; employeeId: number; cardId: number }> = [];
  const passesPerCard = new Map<number, number>();
  for (const row of input.passes) {
    const employeeId = Number(row.sigur_employee_id);
    const w26 = passW26(row.card_uid);
    if (!Number.isInteger(employeeId) || employeeId <= 0 || !w26) {
      skipped.invalid_card_uid.push(row.pass_number);
      continue;
    }
    const cardIds = input.cardIdsByW26.get(w26);
    if (!cardIds || cardIds.size === 0) {
      // Карты с таким W26 в каталоге нет — значит, нет и привязки.
      skipped.no_binding.push(row.pass_number);
      continue;
    }
    if (cardIds.size > 1) {
      skipped.ambiguous_w26.push(row.pass_number);
      continue;
    }
    const [cardId] = cardIds;
    candidates.push({ row, employeeId, cardId });
    passesPerCard.set(cardId, (passesPerCard.get(cardId) ?? 0) + 1);
  }

  // Шаг 2: карта ↔ ровно один пропуск, привязка ↔ ровно одна на профиле пропуска.
  for (const { row, employeeId, cardId } of candidates) {
    if ((passesPerCard.get(cardId) ?? 0) > 1) {
      skipped.card_multi_pass.push(row.pass_number);
      continue;
    }
    if (input.unreadableEmployeeIds.has(employeeId)) {
      skipped.unreadable.push(row.pass_number);
      continue;
    }
    const bindings = (input.bindingsByEmployee.get(employeeId) ?? []).filter(binding => binding.cardId === cardId);
    if (bindings.length === 0) {
      skipped.no_binding.push(row.pass_number);
      continue;
    }
    if (bindings.length > 1) {
      skipped.duplicate_binding.push(row.pass_number);
      continue;
    }

    const expiration = sigurExpirationToMoscowDate(bindings[0].expirationDate);
    if (expiration.kind === 'invalid') {
      skipped.invalid_date.push(row.pass_number);
      continue;
    }
    const newExpiresAt = expiration.kind === 'date' ? expiration.date : null;
    const oldExpiresAt = row.expires_at ? row.expires_at.slice(0, 10) : null;
    if (newExpiresAt === oldExpiresAt) {
      unchanged += 1;
      continue;
    }

    changes.push({
      passId: row.id,
      passNumber: row.pass_number,
      sigurEmployeeId: employeeId,
      cardId,
      cardUid: row.card_uid,
      cardHexUid: row.card_hex_uid,
      oldExpiresAt,
      newExpiresAt,
      sigurExpiration: bindings[0].expirationDate,
      outcome: 'planned',
    });
  }

  return { eligible: input.passes.length, unchanged, changes, skipped };
}

/** Строгие неравенства: 100 правок не блокируются, 101 из 202 — тоже, 101 из 201 — да. */
export function isMassChange(changed: number, eligible: number): boolean {
  return changed > MASS_CHANGE_MIN && eligible > 0 && changed / eligible > MASS_CHANGE_MAX_SHARE;
}

const resolveStatus = (
  blocked: boolean,
  skipped: Record<PassExpirySkipReason, string[]>,
  writeIssues: Record<PassExpiryWriteIssue, string[]>,
): PassExpirySyncStatus => {
  if (blocked) return 'blocked';
  if (skipped.unreadable.length > 0) return 'partial';
  return WRITE_ISSUES.some(issue => writeIssues[issue].length > 0) ? 'partial' : 'completed';
};

/** Сводка без номеров пропусков — для логов и runtime state планировщика. */
export function summarizePassExpirySync(result: IPassExpirySyncResult): Record<string, unknown> {
  const counts = (buckets: Record<string, string[]>): Record<string, number> =>
    Object.fromEntries(Object.entries(buckets).filter(([, list]) => list.length > 0).map(([key, list]) => [key, list.length]));
  return {
    runId: result.runId,
    dryRun: result.dryRun,
    status: result.status,
    massChange: result.massChange,
    eligible: result.eligible,
    unchanged: result.unchanged,
    planned: result.changes.length,
    updated: result.updated,
    skipped: counts(result.skipped),
    writeIssues: counts(result.writeIssues),
  };
}

async function loadEligiblePasses(): Promise<IExpiryPassRow[]> {
  return query<IExpiryPassRow>(
    `SELECT id, pass_number, sigur_employee_id, card_uid, card_hex_uid, expires_at
       FROM contractor_passes
      WHERE (status = 'applied' OR is_active = true)
        AND sigur_employee_id IS NOT NULL
      ORDER BY pass_number`,
  );
}

/** Перечитывание по карте (без фильтра по сотруднику — ловит перенос на другой профиль). */
async function confirmLiveExpiration(
  change: IPassExpiryChange,
  connection: ConnectionType,
): Promise<'confirmed' | 'reread_failed' | 'changed_during_run'> {
  let live: ILiveBinding[];
  try {
    live = await readLiveBindingsByCard(change.cardId, connection);
  } catch (error) {
    console.warn(
      `[pass-expiry-sync] перечитывание карты ${change.cardId} не удалось:`,
      error instanceof Error ? error.message : error,
    );
    return 'reread_failed';
  }
  if (live.length !== 1 || live[0].employeeId !== change.sigurEmployeeId) return 'changed_during_run';
  const fresh = sigurExpirationToMoscowDate(live[0].expirationDate);
  if (fresh.kind === 'invalid') return 'changed_during_run';
  const freshValue = fresh.kind === 'date' ? fresh.date : null;
  return freshValue === change.newExpiresAt ? 'confirmed' : 'changed_during_run';
}

type WriteResult = { outcome: 'updated' | 'conflict' } | { outcome: 'db_error'; error: unknown };

/** CAS по снимку + аудит в одной короткой транзакции (HTTP к Sigur — только до неё). */
async function writeChange(
  change: IPassExpiryChange,
  runId: string,
  triggeredBy: IRunPassExpirySyncParams['triggeredBy'],
): Promise<WriteResult> {
  try {
    const updated = await withTransaction(async client => {
      const result = await client.query(
        `UPDATE contractor_passes
            SET expires_at = $1::date, updated_at = now()
          WHERE id = $2::uuid
            AND sigur_employee_id = $3::bigint
            AND card_uid IS NOT DISTINCT FROM $4::text
            AND card_hex_uid IS NOT DISTINCT FROM $5::text
            AND expires_at IS NOT DISTINCT FROM $6::date
            AND (status = 'applied' OR is_active = true)`,
        [
          change.newExpiresAt,
          change.passId,
          change.sigurEmployeeId,
          change.cardUid,
          change.cardHexUid,
          change.oldExpiresAt,
        ],
      );
      if (result.rowCount !== 1) return false;
      await auditService.logWithClient(client, {
        user_id: null,
        action: AUDIT_ACTIONS.CONTRACTOR_PASS_EXPIRY_SYNCED,
        entity_type: 'contractor_pass',
        entity_id: change.passId,
        details: {
          pass_number: change.passNumber,
          old_expires_at: change.oldExpiresAt,
          new_expires_at: change.newExpiresAt,
          sigur_expiration: change.sigurExpiration,
          sigur_employee_id: change.sigurEmployeeId,
          card_id: change.cardId,
          run_id: runId,
          triggered_by: triggeredBy,
        },
      });
      return true;
    });
    return { outcome: updated ? 'updated' : 'conflict' };
  } catch (error) {
    console.error(
      `[pass-expiry-sync] запись пропуска ${change.passNumber} не удалась:`,
      error instanceof Error ? error.message : error,
    );
    return { outcome: 'db_error', error };
  }
}

export async function runContractorPassExpirySync(
  params: IRunPassExpirySyncParams,
): Promise<IPassExpirySyncResult> {
  const { dryRun, force = false, triggeredBy, shouldAbort } = params;
  const runId = randomUUID();

  // Lock — ДО снимка: запись срока карты из ФОТ (массовое продление, сайдбар) не вклинится
  // между планом и записью. Занят — SigurCardLeaseBusyError наружу, прогон откладывается.
  const lease = dryRun
    ? null
    : await acquireSigurCardLease({
      owner: `pass-expiry-sync:${runId}`,
      ttlSeconds: CARD_LEASE_TTL_SECONDS,
      meta: { kind: 'contractor_pass_expiry_sync', runId, triggeredBy },
    });
  const isAborted = (): boolean => (lease?.isLost() ?? false) || (shouldAbort?.() ?? false);

  try {
    const connection = await sigurService.getBackgroundConnectionType();
    const passes = await loadEligiblePasses();
    const employeeIds = [...new Set(
      passes.map(row => Number(row.sigur_employee_id)).filter(id => Number.isInteger(id) && id > 0),
    )];

    const { byEmployee, unreadable } = await collectCardBindings(employeeIds, connection);
    // Каталог — заново: getCardsCached держит копию 60 с.
    sigurService.invalidateCardListCache();
    const cardIdsByW26 = buildCardIdsByW26(await sigurService.getCardsCached(connection));
    if (cardIdsByW26.size === 0) {
      throw new Error('Каталог карт Sigur пуст или не разобран — синхронизация сроков остановлена');
    }

    const plan = planPassExpiryChanges({
      passes,
      bindingsByEmployee: byEmployee,
      unreadableEmployeeIds: new Set(unreadable),
      cardIdsByW26,
    });
    const massChange = isMassChange(plan.changes.length, plan.eligible);
    const blocked = massChange && !force;
    const writeIssues = emptyBuckets(WRITE_ISSUES);
    let updated = 0;

    if (blocked && !dryRun) {
      Sentry.captureMessage('contractor_pass_expiry_mass_change_blocked', {
        level: 'warning',
        tags: { service: 'contractor-pass-expiry-sync' },
        extra: { runId, eligible: plan.eligible, changes: plan.changes.length },
      });
    }

    if (!dryRun && !blocked) {
      let dbErrorReported = false;
      for (const change of plan.changes) {
        if (isAborted()) {
          change.outcome = 'aborted';
          writeIssues.aborted.push(change.passNumber);
          continue;
        }
        const confirmation = await confirmLiveExpiration(change, connection);
        if (confirmation !== 'confirmed') {
          change.outcome = confirmation;
          writeIssues[confirmation].push(change.passNumber);
          continue;
        }
        // Перечитывание — сетевой запрос: lease мог потеряться, пока он шёл.
        if (isAborted()) {
          change.outcome = 'aborted';
          writeIssues.aborted.push(change.passNumber);
          continue;
        }
        const written = await writeChange(change, runId, triggeredBy);
        change.outcome = written.outcome;
        if (written.outcome === 'updated') {
          updated += 1;
          continue;
        }
        writeIssues[written.outcome].push(change.passNumber);
        if (written.outcome === 'db_error' && !dbErrorReported) {
          dbErrorReported = true;
          Sentry.captureException(written.error, {
            tags: { service: 'contractor-pass-expiry-sync' },
            extra: { runId },
          });
        }
      }
    }

    const result: IPassExpirySyncResult = {
      runId,
      dryRun,
      status: resolveStatus(blocked, plan.skipped, writeIssues),
      massChange,
      eligible: plan.eligible,
      unchanged: plan.unchanged,
      updated,
      changes: plan.changes,
      skipped: plan.skipped,
      writeIssues,
    };
    console.log(`[pass-expiry-sync] ${JSON.stringify(summarizePassExpirySync(result))}`);
    return result;
  } finally {
    await lease?.release();
  }
}
