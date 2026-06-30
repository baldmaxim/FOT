/**
 * Общий пул пропусков подрядчика.
 *
 * Этап A workflow «общий пул → подрядчик → согласование»:
 *   1. Админ создаёт в Sigur папку «Свободные пропуска» ВРУЧНУЮ и выбирает её
 *      через UI — id папки хранится в system_settings.
 *   2. addPassesToPool — создаёт в этой папке заблокированные профили с
 *      привязкой карты и записывает строки contractor_passes (status='in_pool',
 *      org_department_id IS NULL). Без точек доступа — это инвентарь.
 *   3. assignPoolPassesToContractor — переносит профили из общей папки в
 *      Sigur-папку конкретного подрядчика и проставляет org_department_id +
 *      status='assigned'. ФИО и точки доступа подрядчик/админ вписывают позже.
 */
import * as Sentry from '@sentry/node';
import { query, execute, queryOne, withTransaction } from '../config/postgres.js';
import { settingsService } from './settings.service.js';
import { sigurService } from './sigur.service.js';
import type { ConnectionType } from './sigur-base.service.js';
import { isContractorSigurDryRun } from '../config/contractor.js';
import {
  createSigurEmployee,
  moveSigurEmployee,
  updateSigurEmployee,
} from './sigur-live-employees-crud.service.js';
import { assignSigurEmployeeCardBinding } from './sigur-live-cards.service.js';
import { getOrgSigurDepartmentId, ContractorScopeError } from './contractor-scope.service.js';

export const POOL_SETTINGS_KEY = 'contractor.free_pool.sigur_department_id';

export class PoolNotConfiguredError extends Error {
  constructor() {
    super('Папка общего пула не настроена. Выберите её на вкладке «Общий пул».');
    this.name = 'PoolNotConfiguredError';
  }
}

export type SigurOperation = 'move' | 'rename_block';

export class SigurOperationError extends Error {
  public readonly op: SigurOperation;
  public readonly sigurEmployeeId: number;
  public readonly cause: unknown;

  constructor(op: SigurOperation, sigurEmployeeId: number, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    const action = op === 'move'
      ? 'перенести профиль в папку пула'
      : 'переименовать/заблокировать профиль';
    super(`Sigur API: не удалось ${action} (id ${sigurEmployeeId}) — ${causeMsg}`);
    this.name = 'SigurOperationError';
    this.op = op;
    this.sigurEmployeeId = sigurEmployeeId;
    this.cause = cause;
  }
}

/** Sigur-id выбранной папки общего пула или null, если не настроено. */
export const getFreePoolDepartmentId = async (): Promise<number | null> => {
  const raw = await settingsService.get(POOL_SETTINGS_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** Throws PoolNotConfiguredError, если папка не выбрана. */
export const requireFreePoolDepartmentId = async (): Promise<number> => {
  const id = await getFreePoolDepartmentId();
  if (id == null) throw new PoolNotConfiguredError();
  return id;
};

/** Сохранить выбор папки. Sigur не проверяем здесь — это делает контроллер. */
export const setFreePoolDepartmentId = async (
  sigurDepartmentId: number | null,
  userId: string,
): Promise<void> => {
  await settingsService.set(
    POOL_SETTINGS_KEY,
    sigurDepartmentId == null ? null : String(sigurDepartmentId),
    userId,
    'Sigur-id папки общего пула пропусков (выбирается админом через UI)',
  );
};

export interface IPoolItem {
  id: string;
  pass_number: string;
  card_uid: string | null;
  sigur_employee_id: number | null;
  created_at: string;
}

export interface IPoolListResult {
  items: IPoolItem[];
  total: number;
}

/** Список пропусков, лежащих в общем пуле (status='in_pool'). С пагинацией. */
export const listPool = async (filter?: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<IPoolListResult> => {
  const search = filter?.search?.trim();
  const limit = filter?.limit ?? 50;
  const offset = filter?.offset ?? 0;

  if (search) {
    const items = await query<IPoolItem>(
      `SELECT id, pass_number, card_uid, sigur_employee_id, created_at
         FROM contractor_passes
        WHERE status = 'in_pool'
          AND (pass_number ILIKE $1 OR card_uid ILIKE $1)
        ORDER BY pass_number::int ASC
        LIMIT $2 OFFSET $3`,
      [`%${search}%`, limit, offset],
    );
    const cnt = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM contractor_passes
        WHERE status = 'in_pool' AND (pass_number ILIKE $1 OR card_uid ILIKE $1)`,
      [`%${search}%`],
    );
    return { items, total: Number(cnt?.count ?? 0) };
  }

  const items = await query<IPoolItem>(
    `SELECT id, pass_number, card_uid, sigur_employee_id, created_at
       FROM contractor_passes
      WHERE status = 'in_pool'
      ORDER BY pass_number::int ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const cnt = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM contractor_passes WHERE status = 'in_pool'`,
  );
  return { items, total: Number(cnt?.count ?? 0) };
};

export interface IPoolRange {
  from: string;
  to: string;
  status: 'free' | 'occupied';
  count: number;
}

export interface IPoolRangesResult {
  ranges: IPoolRange[];
  totals: { free: number; occupied: number };
}

/**
 * Диапазоны номеров пропусков для шапки «Общий пул». Склейка подряд идущих
 * номеров одинакового статуса (gaps-and-islands в JS-цикле).
 *   free     — status='in_pool' AND org_department_id IS NULL
 *   occupied — назначен подрядчику / отправлен / открыт / заблокирован
 * revoked в выборку не попадает.
 */
export const getPoolRanges = async (): Promise<IPoolRangesResult> => {
  // Один и тот же pass_number может фигурировать в нескольких строках
  // (исторически: один раз в пуле, потом назначен подрядчику и т.д.).
  // Дедуплицируем: если ВСЕ строки номера — free (in_pool без org), то free;
  // если есть хоть одна занятая — occupied.
  const rows = await query<{ pass_number: string; bucket: 'free' | 'occupied' }>(
    `SELECT pass_number,
            CASE
              WHEN bool_and(status = 'in_pool' AND org_department_id IS NULL)
                THEN 'free'
              ELSE 'occupied'
            END AS bucket
       FROM contractor_passes
      WHERE pass_number ~ '^[0-9]+$'
        AND status <> 'revoked'
      GROUP BY pass_number
      ORDER BY pass_number::bigint ASC`,
  );

  const ranges: IPoolRange[] = [];
  let cur: { fromNum: number; toNum: number; status: 'free' | 'occupied' } | null = null;
  let freeCount = 0;
  let occupiedCount = 0;

  const flush = () => {
    if (!cur) return;
    // Без padStart: номера выводим как числа, без ведущих нулей. БД может
    // хранить «0991» (padded при выпуске пакета), но в отчёте показываем 991.
    const from = String(cur.fromNum);
    const to = String(cur.toNum);
    ranges.push({ from, to, status: cur.status, count: cur.toNum - cur.fromNum + 1 });
    cur = null;
  };

  for (const r of rows) {
    const num = Number(r.pass_number);
    if (!Number.isFinite(num)) continue;
    if (r.bucket === 'free') freeCount += 1; else occupiedCount += 1;
    if (cur && cur.status === r.bucket && num === cur.toNum + 1) {
      cur.toNum = num;
    } else {
      flush();
      cur = { fromNum: num, toNum: num, status: r.bucket };
    }
  }
  flush();

  return { ranges, totals: { free: freeCount, occupied: occupiedCount } };
};

export type PoolCellStatus = 'free' | 'occupied' | 'provisioning' | 'failed';

export interface IPoolCell {
  pass_number: string;
  status: PoolCellStatus;
  /** id строки in_pool (нужен для назначения); null для остальных. */
  id: string | null;
  /** id строки provisioning/provisioning_failed (нужен для повтора выпуска); иначе null. */
  failed_id: string | null;
  /** текст ошибки выпуска (для tooltip ячейки); иначе null. */
  error: string | null;
}

export interface IPoolMatrixTotals {
  free: number;
  occupied: number;
  provisioning: number;
  failed: number;
}

export interface IPoolMatrixResult {
  cells: IPoolCell[];
  totals: IPoolMatrixTotals;
}

/**
 * Плоская матрица всего пула для UI: одна ячейка на номер пропуска, с цветом по
 * статусу. Дедупликация по pass_number; приоритет статусов (сверху вниз):
 *   failed       — есть строка provisioning_failed (org IS NULL): выпуск сорвался;
 *   provisioning — есть строка provisioning (org IS NULL): идёт выпуск/завис;
 *   free         — ВСЕ строки номера in_pool без org → берём id свободной строки;
 *   occupied     — иначе (назначен подрядчику / отправлен / открыт / заблокирован).
 * revoked в выборку не попадает. failed/provisioning перекрывают free/occupied.
 */
export const getPoolMatrix = async (): Promise<IPoolMatrixResult> => {
  const cells = await query<IPoolCell>(
    `SELECT pass_number,
            CASE
              WHEN count(*) FILTER (
                     WHERE status = 'provisioning_failed' AND org_department_id IS NULL) > 0
                THEN 'failed'
              WHEN count(*) FILTER (
                     WHERE status = 'provisioning' AND org_department_id IS NULL) > 0
                THEN 'provisioning'
              WHEN bool_and(status = 'in_pool' AND org_department_id IS NULL)
                THEN 'free'
              ELSE 'occupied'
            END AS status,
            (array_agg(id) FILTER (WHERE status = 'in_pool' AND org_department_id IS NULL))[1] AS id,
            (array_agg(id) FILTER (
               WHERE status IN ('provisioning', 'provisioning_failed')
                 AND org_department_id IS NULL))[1] AS failed_id,
            (array_agg(sigur_sync_error) FILTER (
               WHERE status = 'provisioning_failed' AND org_department_id IS NULL))[1] AS error
       FROM contractor_passes
      WHERE pass_number ~ '^[0-9]+$'
        AND status <> 'revoked'
      GROUP BY pass_number
      ORDER BY pass_number::bigint ASC`,
  );

  const totals: IPoolMatrixTotals = { free: 0, occupied: 0, provisioning: 0, failed: 0 };
  for (const c of cells) {
    totals[c.status] += 1;
  }

  return { cells, totals };
};

export interface IAddPoolInput {
  from: number;
  to?: number;
  cards: Array<{ uid: string; sequence: number }>;
  createdBy: string;
}

/** Этап, на котором номер не попал в пул (для сводки и UI). */
export type PoolFailStage = 'input' | 'range' | 'duplicate' | 'card' | 'sigur';

export interface IAddPoolResult {
  created: string[];
  failed: Array<{ pass_number: string; error: string; stage: PoolFailStage }>;
  warnings: string[];
  /** Номера, по которым строка в БД материализована (status='provisioning') до Sigur. */
  reserved: string[];
  /** Ожидаемые номера без строки в БД после reserve — в норме []; непусто = баг reserve. */
  missing: string[];
}

/** Контекст провижининга (резолвится один раз на партию/retry). */
interface IProvisionCtx {
  dryRun: boolean;
  poolDeptId: number;
  connection: ConnectionType | undefined;
  /**
   * Идемпотентный поиск уже существующего Sigur-профиля пула по passNumber.
   * Задаётся только в retry-пути (где возможен orphan после краша). В обычном
   * выпуске не задаётся — профиль создаётся напрямую (дублей нет: reserve уже
   * гарантировал единственную строку на номер).
   */
  resolveProfile?: (passNumber: string) => Promise<number | null>;
}

interface IProvisionRow {
  id: string;
  passNumber: string;
  cardUid: string;
  /** Уже привязанный профиль (retry строки provisioning_failed) или null. */
  sigurEmployeeId: number | null;
}

const normalizeSigurInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

/** Первое непустое значение среди возможных имён поля Sigur (без тяжёлых зависимостей). */
const readField = (obj: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};

/** Перевести зарезервированную строку в provisioning_failed, сохранив текст ошибки и sigur_employee_id. */
const markProvisioningFailed = async (id: string, error: string): Promise<void> => {
  await execute(
    `UPDATE contractor_passes
        SET status = 'provisioning_failed',
            sigur_sync_error = $2,
            updated_at = now()
      WHERE id = $1::uuid AND status IN ('provisioning', 'provisioning_failed')`,
    [id, error],
  );
};

/**
 * Найти существующий Sigur-профиль пула по естественному ключу FOT-POOL:{n}
 * (или placeholder-имени «Пропуск N»). Используется только в retry, чтобы не
 * плодить дубли/orphan после краша между createSigurEmployee и UPDATE.
 * Один полный fetch employees на retry мемоизируется снаружи (см. ниже).
 */
const findPoolProfileInList = (
  employees: Record<string, unknown>[],
  passNumber: string,
): number | null => {
  const wantDesc = `FOT-POOL:${passNumber}`;
  const wantName = `Пропуск ${passNumber}`;
  for (const e of employees) {
    const desc = String(readField(e, 'description', 'Description') ?? '');
    const name = String(readField(e, 'name', 'NAME', 'Name', 'fullName', 'full_name') ?? '').trim();
    if (desc === wantDesc || name === wantName) {
      const id = normalizeSigurInt(readField(e, 'id', 'ID', 'Id'));
      if (id) return id;
    }
  }
  return null;
};

/**
 * PROVISION одной зарезервированной строки: профиль Sigur (reuse/lookup/create)
 * → UPDATE sigur_employee_id (до привязки карты) → привязка карты (safe-only) →
 * status='in_pool'. Любой сбой Sigur НЕ удаляет строку и НЕ удаляет профиль
 * безусловно: строка переводится в provisioning_failed (видна в матрице, ждёт
 * retry). Дыра в нумерации не образуется — строка уже существует.
 */
const provisionOnePoolPass = async (
  row: IProvisionRow,
  ctx: IProvisionCtx,
): Promise<{ ok: true } | { ok: false; error: string; stage: 'card' | 'sigur' }> => {
  if (ctx.dryRun) {
    const fakeId = row.sigurEmployeeId ?? -(Date.now() + (Number(row.passNumber) || 0));
    await execute(
      `UPDATE contractor_passes
          SET sigur_employee_id = $2, status = 'in_pool', sigur_sync_error = NULL, updated_at = now()
        WHERE id = $1::uuid AND status IN ('provisioning', 'provisioning_failed')`,
      [row.id, fakeId],
    );
    return { ok: true };
  }

  if (!row.cardUid) {
    const error = 'карта: UID не сохранён';
    await markProvisioningFailed(row.id, error);
    return { ok: false, error, stage: 'card' };
  }

  // 1) Профиль Sigur: переиспользуем сохранённый id, иначе (только в retry) ищем
  //    существующий по FOT-POOL:{n}, иначе создаём новый.
  let sigurEmployeeId = row.sigurEmployeeId;
  if (sigurEmployeeId == null) {
    try {
      if (ctx.resolveProfile) {
        sigurEmployeeId = await ctx.resolveProfile(row.passNumber);
      }
      if (sigurEmployeeId == null) {
        const profile = await createSigurEmployee({
          name: `Пропуск ${row.passNumber}`,
          departmentId: ctx.poolDeptId,
          description: `FOT-POOL:${row.passNumber}`,
          blocked: true,
        }, ctx.connection);
        sigurEmployeeId = profile.sigurEmployeeId;
      }
      // Фиксируем ссылку на профиль СРАЗУ — до привязки карты, чтобы при сбое
      // привязки строка не осталась без sigur_employee_id (иначе orphan-профиль).
      await execute(
        `UPDATE contractor_passes SET sigur_employee_id = $2, updated_at = now() WHERE id = $1::uuid`,
        [row.id, sigurEmployeeId],
      );
    } catch (e) {
      const msg = `профиль: ${e instanceof Error ? e.message : String(e)}`;
      await markProvisioningFailed(row.id, msg);
      Sentry.captureException(e, {
        tags: { service: 'contractor-pool', stage: 'provision-profile' },
        extra: { passNumber: row.passNumber },
      });
      return { ok: false, error: msg, stage: 'sigur' };
    }
  }

  // 2) Привязка карты. Профиль свежий/placeholder → safe-only без ФИО: не «крадём»
  //    карту у активного держателя. Карты нет в Sigur → создаём из UID/W26.
  try {
    await assignSigurEmployeeCardBinding(sigurEmployeeId, [row.cardUid], undefined, ctx.connection, true, {
      reassignPolicy: 'safe-only',
    });
  } catch (e) {
    const msg = `карта: ${e instanceof Error ? e.message : String(e)}`;
    // Профиль НЕ удаляем — оставляем blocked-плейсхолдер для retry (sigur_employee_id сохранён).
    await markProvisioningFailed(row.id, msg);
    Sentry.captureException(e, {
      tags: { service: 'contractor-pool', stage: 'provision-card' },
      extra: { passNumber: row.passNumber, cardUid: row.cardUid },
    });
    return { ok: false, error: msg, stage: 'card' };
  }

  // 3) Успех — строка готова к назначению подрядчику.
  await execute(
    `UPDATE contractor_passes
        SET status = 'in_pool', sigur_sync_error = NULL, updated_at = now()
      WHERE id = $1::uuid AND status IN ('provisioning', 'provisioning_failed')`,
    [row.id],
  );
  return { ok: true };
};

/**
 * Массовое добавление карт в общий пул — reserve-then-provision.
 *
 * RESERVE: на каждый номер материализуем строку contractor_passes
 *   (status='provisioning', sigur_employee_id=NULL) ДО любого обращения к Sigur.
 *   Канонический формат номера — String(num), без ведущих нулей. Дубль (числовой
 *   или по partial-uniq) → failed{duplicate}, строка не создаётся. Так номер
 *   физически не может «потеряться» из-за сбоя Sigur — дыр в нумерации нет.
 * PROVISION: по каждой зарезервированной строке создаём профиль Sigur и
 *   привязываем карту; сбой → provisioning_failed (видно в матрице, retry).
 * RECONCILE: контроль, что все ожидаемые номера материализованы (missing → Sentry).
 */
export const addPassesToPool = async (input: IAddPoolInput): Promise<IAddPoolResult> => {
  const dryRun = isContractorSigurDryRun();
  const poolDeptId = dryRun ? 0 : await requireFreePoolDepartmentId();
  const connection = dryRun ? undefined : await sigurService.getBackgroundConnectionType();

  const created: string[] = [];
  const failed: Array<{ pass_number: string; error: string; stage: PoolFailStage }> = [];
  const warnings: string[] = [];
  const reserved: Array<{ id: string; passNumber: string; cardUid: string }> = [];

  const cards = [...input.cards].sort((a, b) => a.sequence - b.sequence);
  const maxSeq = cards.reduce((m, c) => Math.max(m, c.sequence), 0);

  // Дыры во входной последовательности (партия ожидается непрерывной): номер без
  // карты помечаем заранее как failed{input}, а не «молча пропускаем».
  const seqSet = new Set(cards.map(c => c.sequence));
  for (let seq = 0; seq <= maxSeq; seq += 1) {
    if (seqSet.has(seq)) continue;
    const num = input.from + seq;
    if (input.to && num > input.to) continue;
    failed.push({ pass_number: String(num), error: 'нет карты на этот номер (пропуск во входных данных)', stage: 'input' });
  }

  // --- RESERVE ---
  const expected: number[] = [];
  const accounted = new Set<number>();
  for (const card of cards) {
    const num = input.from + card.sequence;
    if (input.to && num > input.to) {
      failed.push({ pass_number: String(num), error: `вне пула (> ${input.to})`, stage: 'range' });
      continue;
    }
    const passNumber = String(num); // канонический формат — без ведущих нулей
    const cardUid = card.uid.trim();
    expected.push(num);

    // Preflight числового дубля: ловит смысловой дубль даже при разном тексте
    // (legacy '0991' против нового '991') — partial-uniq на text это не покрывает.
    const dup = await queryOne<{ id: string }>(
      `SELECT id FROM contractor_passes
        WHERE org_department_id IS NULL
          AND pass_number ~ '^[0-9]+$'
          AND pass_number::bigint = $1`,
      [num],
    );
    if (dup) {
      warnings.push(`${passNumber}: уже в пуле`);
      failed.push({ pass_number: passNumber, error: 'уже в пуле', stage: 'duplicate' });
      accounted.add(num);
      continue;
    }

    // Целевой ON CONFLICT именно по partial-uniq contractor_passes_pool_pass_number_uniq,
    // чтобы не проглотить чужой конфликт. Нет RETURNING → строку успели вставить (гонка).
    const ins = await queryOne<{ id: string }>(
      `INSERT INTO contractor_passes
         (org_department_id, pass_number, sigur_employee_id, card_uid, status, created_by)
       VALUES (NULL, $1, NULL, $2, 'provisioning', $3::uuid)
       ON CONFLICT (pass_number) WHERE org_department_id IS NULL DO NOTHING
       RETURNING id`,
      [passNumber, cardUid, input.createdBy],
    );
    if (!ins) {
      warnings.push(`${passNumber}: уже в пуле`);
      failed.push({ pass_number: passNumber, error: 'уже в пуле', stage: 'duplicate' });
      accounted.add(num);
      continue;
    }
    reserved.push({ id: ins.id, passNumber, cardUid });
    accounted.add(num);
  }

  // --- RECONCILE: каждый ожидаемый номер обязан иметь строку (reserved или duplicate). ---
  const missing = expected.filter(n => !accounted.has(n)).map(String);
  if (missing.length > 0) {
    Sentry.captureMessage('contractor pool reserve: numbers missing after reserve', {
      level: 'error',
      tags: { service: 'contractor-pool', stage: 'reconcile' },
      extra: { missing, from: input.from, to: input.to ?? null },
    });
  }

  // --- PROVISION ---
  const ctx: IProvisionCtx = { dryRun, poolDeptId, connection };
  for (const row of reserved) {
    const res = await provisionOnePoolPass(
      { id: row.id, passNumber: row.passNumber, cardUid: row.cardUid, sigurEmployeeId: null },
      ctx,
    );
    if (res.ok) created.push(row.passNumber);
    else failed.push({ pass_number: row.passNumber, error: res.error, stage: res.stage });
  }

  return { created, failed, warnings, reserved: reserved.map(r => r.passNumber), missing };
};

export interface IRetryProvisionResult {
  retried: number;
  created: string[];
  failed: Array<{ pass_number: string; error: string; stage: PoolFailStage }>;
}

/**
 * Повторный выпуск «застрявших» строк пула:
 *   - status='provisioning_failed' (сбой Sigur при выпуске), и
 *   - status='provisioning' со stale updated_at (краш между reserve и provision).
 * Прогоняет тот же provisionOnePoolPass с идемпотентным lookup профиля (без
 * дублей). passNumbers? — ограничить конкретными номерами (клик по failed-ячейке).
 */
export const STALE_PROVISIONING_MS = 10 * 60_000;

export const retryStuckPoolPasses = async (passNumbers?: string[]): Promise<IRetryProvisionResult> => {
  const dryRun = isContractorSigurDryRun();
  const poolDeptId = dryRun ? 0 : await requireFreePoolDepartmentId();
  const connection = dryRun ? undefined : await sigurService.getBackgroundConnectionType();

  const filterNums = passNumbers && passNumbers.length > 0 ? passNumbers : null;
  const rows = await query<{
    id: string; pass_number: string; card_uid: string | null; sigur_employee_id: number | null;
  }>(
    `SELECT id, pass_number, card_uid, sigur_employee_id
       FROM contractor_passes
      WHERE org_department_id IS NULL
        AND (
          status = 'provisioning_failed'
          OR (status = 'provisioning'
              AND updated_at < now() - ($1::bigint * interval '1 millisecond'))
        )
        AND ($2::text[] IS NULL OR pass_number = ANY($2::text[]))
      ORDER BY pass_number::bigint ASC`,
    [STALE_PROVISIONING_MS, filterNums],
  );

  // Идемпотентный lookup профиля: один полный fetch employees на весь retry,
  // мемоизированный (нужен только для строк с потерянным sigur_employee_id).
  let employeeCache: Record<string, unknown>[] | null = null;
  const resolveProfile = async (passNumber: string): Promise<number | null> => {
    if (dryRun) return null;
    if (!employeeCache) {
      employeeCache = await sigurService.getEmployees(undefined, connection) as Record<string, unknown>[];
    }
    return findPoolProfileInList(employeeCache, passNumber);
  };

  const ctx: IProvisionCtx = { dryRun, poolDeptId, connection, resolveProfile };
  const created: string[] = [];
  const failed: Array<{ pass_number: string; error: string; stage: PoolFailStage }> = [];
  for (const r of rows) {
    const res = await provisionOnePoolPass(
      { id: r.id, passNumber: r.pass_number, cardUid: (r.card_uid ?? '').trim(), sigurEmployeeId: r.sigur_employee_id },
      ctx,
    );
    if (res.ok) created.push(r.pass_number);
    else failed.push({ pass_number: r.pass_number, error: res.error, stage: res.stage });
  }

  return { retried: rows.length, created, failed };
};

export interface IAssignPoolResult {
  assigned: string[];
  failed: Array<{ pass_id: string; error: string }>;
}

/**
 * Назначение пула подрядчику. Для каждого пропуска (status='in_pool'):
 *   1) Sigur: переносим профиль из общей папки в Sigur-папку подрядчика;
 *   2) PG: UPDATE org_department_id, status='assigned'.
 * Не атомарно: каждый пропуск коммитим отдельно, при ошибке Sigur — оставляем
 * запись в пуле без изменений (есть возможность повторить).
 */
export const assignPoolPassesToContractor = async (input: {
  passIds: string[];
  orgDepartmentId: string;
  userId: string;
}): Promise<IAssignPoolResult> => {
  const dryRun = isContractorSigurDryRun();
  const connection = dryRun ? undefined : await sigurService.getBackgroundConnectionType();

  let orgSigurDeptId: number;
  if (dryRun) {
    orgSigurDeptId = 0;
  } else {
    try {
      orgSigurDeptId = await getOrgSigurDepartmentId(input.orgDepartmentId);
    } catch (e) {
      if (e instanceof ContractorScopeError) throw e;
      throw e;
    }
  }

  const rows = await query<{ id: string; pass_number: string; sigur_employee_id: number | null; status: string; sigur_sync_state: string }>(
    `SELECT id, pass_number, sigur_employee_id, status, sigur_sync_state
       FROM contractor_passes
      WHERE id = ANY($1::uuid[])`,
    [input.passIds],
  );
  const byId = new Map(rows.map(r => [r.id, r]));

  const assigned: string[] = [];
  const failed: Array<{ pass_id: string; error: string }> = [];

  for (const passId of input.passIds) {
    const row = byId.get(passId);
    if (!row) {
      failed.push({ pass_id: passId, error: 'пропуск не найден' });
      continue;
    }
    if (row.status !== 'in_pool') {
      failed.push({ pass_id: passId, error: `статус ${row.status} — только in_pool можно назначить` });
      continue;
    }
    try {
      if (!dryRun && row.sigur_employee_id) {
        await moveSigurEmployee(row.sigur_employee_id, orgSigurDeptId, connection);
        // Если у пропуска был незавершённый отзыв (pending_revoke/failed), фоновый
        // воркер ещё не привёл профиль к «чистому» виду пула — он может нести ФИО
        // прежнего держателя и быть разблокированным. Приводим к инварианту пула
        // прямо здесь: «Пропуск NNNN» + blocked, до ввода нового ФИО и одобрения.
        if (row.sigur_sync_state !== 'synced') {
          try {
            await updateSigurEmployee(
              row.sigur_employee_id,
              { name: `Пропуск ${row.pass_number}`, blocked: true },
              connection,
            );
          } catch (cleanupError) {
            console.warn('[assignPoolPasses] cleanup rename/block warning', {
              sigurEmployeeId: row.sigur_employee_id,
              passNumber: row.pass_number,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
          }
        }
      }
      await execute(
        `UPDATE contractor_passes
            SET org_department_id = $1::uuid,
                status = 'assigned',
                sigur_sync_state = 'synced',
                updated_at = now()
          WHERE id = $2::uuid AND status = 'in_pool'`,
        [input.orgDepartmentId, passId],
      );
      assigned.push(row.pass_number);
    } catch (e) {
      failed.push({ pass_id: passId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { assigned, failed };
};

export interface IFreePass {
  id: string;
  pass_number: string;
}

/** Все свободные пропуска пула (status='in_pool'), только id+номер — для матрицы выбора. */
export const getFreePasses = async (): Promise<IFreePass[]> =>
  query<IFreePass>(
    `SELECT id, pass_number
       FROM contractor_passes
      WHERE status = 'in_pool' AND org_department_id IS NULL
      ORDER BY pass_number::int ASC`,
  );

/**
 * Назначить подрядчику первые N свободных пропусков (по возрастанию номера).
 * Переиспользует assignPoolPassesToContractor.
 */
export const assignPoolPassesByCount = async (input: {
  count: number;
  orgDepartmentId: string;
  userId: string;
}): Promise<IAssignPoolResult> => {
  const rows = await query<{ id: string }>(
    `SELECT id FROM contractor_passes
      WHERE status = 'in_pool' AND org_department_id IS NULL
      ORDER BY pass_number::int ASC
      LIMIT $1`,
    [input.count],
  );
  const passIds = rows.map(r => r.id);
  if (passIds.length === 0) return { assigned: [], failed: [] };
  return assignPoolPassesToContractor({
    passIds,
    orgDepartmentId: input.orgDepartmentId,
    userId: input.userId,
  });
};

export interface IRevokeToPoolResult {
  pass_id: string;
  pass_number: string;
  status: 'returned_to_pool';
  /** true, если профиль в Sigur уже удалён (orphan) — sigur_employee_id обнулён. */
  sigur_orphan?: boolean;
}

/**
 * Sigur через axios отдаёт «нет такого профиля» по-разному.
 * - 404 — каноничный «не найден».
 * - 422 — Sigur 1.6.3.14 quirk: GET /api/v1/employees/{id} на удалённый профиль
 *   возвращает 422 (Unprocessable Entity), а не 404. Поэтому 422 на read-операции
 *   тоже трактуем как «orphan». Использовать ТОЛЬКО для probe-чтения; на PUT/POST
 *   422 — это настоящая validation error.
 */
function isSigurNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { response?: { status?: number }; status?: number; message?: string };
  const status = e.response?.status ?? e.status;
  if (status === 404 || status === 422) return true;
  const msg = (e.message || '').toLowerCase();
  return msg.includes('not found') || msg.includes('404');
}

/** Сколько раз воркер пытается досинхронизировать отзыв в Sigur, прежде чем 'failed'. */
export const MAX_REVOKE_SYNC_ATTEMPTS = 5;

/** Возможные агрегатные статусы заявки подрядчика. */
export type SubmissionStatus = 'pending' | 'partially_applied' | 'approved' | 'rejected';

/**
 * Чистый пересчёт агрегатного статуса заявки по счётчикам пропусков.
 * Повторяет логику decideSubmission плюс явный случай пустой заявки (total===0):
 * все пропуска ушли из заявки → закрываем как 'rejected' (применять нечего).
 * reviewed_at/reviewed_by НЕ трогает — это ответственность вызывающего кода.
 */
export const computeSubmissionStatus = (
  current: string,
  counts: { total: number; pending: number; approved: number; rejected: number },
): SubmissionStatus => {
  if (counts.total === 0) return 'rejected';
  let next: SubmissionStatus = current as SubmissionStatus;
  if (counts.pending === 0) {
    if (counts.rejected === 0) next = 'approved';
    else if (counts.approved === 0) next = 'rejected';
    else next = 'partially_applied'; // финальный mixed (pending===0)
  } else if (counts.approved > 0 || counts.rejected > 0) {
    next = 'partially_applied'; // частично решено, но есть pending
  }
  return next;
};

/**
 * Быстрый путь отзыва: пропуск МГНОВЕННО возвращается в пул в БД, а перенос/
 * блокировка профиля в Sigur откладывается на фоновый воркер
 * (sigur_sync_state='pending_revoke'). UI получает ответ сразу.
 *
 * Покрывает все «занятые» статусы (assigned/submitted/applied/blocked).
 * sigur_employee_id СОХРАНЯЕМ — он нужен воркеру (processRevokePass).
 * В dry-run или при отсутствии профиля синхронизировать нечего → сразу 'synced'.
 */
export const enqueueRevoke = async (input: {
  passId: string;
  userId: string;
}): Promise<IRevokeToPoolResult> => {
  const pass = await queryOne<{
    id: string; pass_number: string; status: string; sigur_employee_id: number | null;
  }>(
    `SELECT id, pass_number, status, sigur_employee_id
       FROM contractor_passes WHERE id = $1::uuid`,
    [input.passId],
  );
  if (!pass) throw new Error('Пропуск не найден');
  if (pass.status === 'in_pool') throw new Error('Пропуск уже в пуле');
  if (pass.status === 'revoked') throw new Error('Пропуск отозван и недоступен');

  const needsSigur = !isContractorSigurDryRun() && pass.sigur_employee_id != null;
  const syncState = needsSigur ? 'pending_revoke' : 'synced';

  await withTransaction(async client => {
    // Authoritative submission_id под блокировкой строки пропуска (защита от гонки:
    // pre-tx SELECT может устареть, если параллельно меняли привязку к заявке).
    const locked = await client.query<{ submission_id: string | null }>(
      `SELECT submission_id FROM contractor_passes WHERE id = $1::uuid FOR UPDATE`,
      [pass.id],
    );
    const oldSubmissionId = locked.rows[0]?.submission_id ?? null;

    await client.query(
      `UPDATE contractor_passes
          SET status = 'in_pool',
              org_department_id = NULL,
              holder_name = NULL,
              submission_id = NULL,
              access_point_names = NULL,
              approval_status = 'not_submitted',
              is_active = false,
              sigur_sync_state = $2,
              sigur_sync_attempts = 0,
              sigur_sync_error = NULL,
              sigur_sync_updated_at = now(),
              updated_at = now()
        WHERE id = $1::uuid`,
      [pass.id, syncState],
    );
    await client.query(
      `UPDATE contractor_pass_holders
          SET valid_until = now()
        WHERE pass_id = $1::uuid AND valid_until IS NULL`,
      [pass.id],
    );

    // Пересчёт агрегатного статуса заявки, из которой только что ушёл пропуск.
    // Иначе заявка может зависнуть в 'partially_applied' без pending-пропусков.
    if (oldSubmissionId) {
      const agg = await client.query<{
        current: string; total: string; pending: string; approved: string; rejected: string;
      }>(
        `SELECT s.status AS current,
                COUNT(p.*)::text                                            AS total,
                COUNT(p.*) FILTER (WHERE p.approval_status = 'pending')::text  AS pending,
                COUNT(p.*) FILTER (WHERE p.approval_status = 'approved')::text AS approved,
                COUNT(p.*) FILTER (WHERE p.approval_status = 'rejected')::text AS rejected
           FROM contractor_submissions s
           LEFT JOIN contractor_passes p ON p.submission_id = s.id
          WHERE s.id = $1::uuid
          GROUP BY s.status`,
        [oldSubmissionId],
      );
      const row = agg.rows[0];
      if (row) {
        const counts = {
          total: Number(row.total),
          pending: Number(row.pending),
          approved: Number(row.approved),
          rejected: Number(row.rejected),
        };
        const next = computeSubmissionStatus(row.current, counts);
        if (next !== row.current) {
          // reviewed_at проставляем только при финализации (pending===0), сохраняя
          // уже существующее время согласования; reviewed_by авто-переходом не трогаем.
          const stampReviewed = counts.pending === 0;
          await client.query(
            `UPDATE contractor_submissions
                SET status = $1,
                    reviewed_at = ${stampReviewed ? 'COALESCE(reviewed_at, now())' : 'reviewed_at'}
              WHERE id = $2::uuid AND status IN ('pending', 'partially_applied')`,
            [next, oldSubmissionId],
          );
        }
      }
    }
  });

  void input.userId;
  return {
    pass_id: pass.id,
    pass_number: pass.pass_number,
    status: 'returned_to_pool',
  };
};

/** Зависший 'revoking' (упавший воркер) переклеймливается через столько мс. */
export const REVOKING_STALE_MS = 2 * 60_000;

/**
 * Кластер-безопасно «клеймит» до limit отзывов: одним UPDATE ... FOR UPDATE
 * SKIP LOCKED переводит pending_revoke (и зависшие revoking) в 'revoking', чтобы
 * при нескольких инстансах (PM2 cluster -i) один отзыв не обработался дважды.
 * Возвращает id заклеймленных строк.
 */
export const claimRevokeTasks = async (limit = 25): Promise<string[]> => {
  const rows = await query<{ id: string }>(
    `UPDATE contractor_passes p
        SET sigur_sync_state = 'revoking', sigur_sync_updated_at = now()
      WHERE p.id IN (
        SELECT id FROM contractor_passes
         WHERE sigur_sync_attempts < $1
           AND (
             sigur_sync_state = 'pending_revoke'
             OR (sigur_sync_state = 'revoking'
                 AND sigur_sync_updated_at < now() - ($2::bigint * interval '1 millisecond'))
           )
         ORDER BY sigur_sync_updated_at ASC NULLS FIRST
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      )
      RETURNING p.id`,
    [MAX_REVOKE_SYNC_ATTEMPTS, REVOKING_STALE_MS, limit],
  );
  return rows.map(r => r.id);
};

/**
 * Фоновая досинхронизация отозванного пропуска с Sigur: профиль move обратно в
 * папку пула + переименование в «Пропуск NNNN» + blocked=true. Вызывается
 * шедулером для заклеймленных строк (sigur_sync_state='revoking').
 *
 * Защита от гонки: если пропуск успели переназначить (status≠'in_pool'),
 * отзыв отменяется. Финальные UPDATE идут с WHERE sigur_sync_state='revoking',
 * поэтому параллельный assign (выставляет 'synced') «выигрывает» и не
 * перетирается. При ошибке Sigur — инкремент попыток; после
 * MAX_REVOKE_SYNC_ATTEMPTS → 'failed' (+ проброс ошибки наверх для Sentry).
 */
export const processRevokePass = async (passId: string): Promise<void> => {
  const cur = await queryOne<{
    pass_number: string; status: string; sigur_sync_state: string; sigur_employee_id: number | null;
  }>(
    `SELECT pass_number, status, sigur_sync_state, sigur_employee_id
       FROM contractor_passes WHERE id = $1::uuid`,
    [passId],
  );
  // Обрабатываем только заклеймленные строки.
  if (!cur || cur.sigur_sync_state !== 'revoking') return;

  // Переназначен между enqueue и обработкой — отзыв отменяем (assign сам почистил Sigur).
  if (cur.status !== 'in_pool') {
    await execute(
      `UPDATE contractor_passes
          SET sigur_sync_state = 'synced', sigur_sync_error = NULL, sigur_sync_updated_at = now()
        WHERE id = $1::uuid AND sigur_sync_state = 'revoking'`,
      [passId],
    );
    return;
  }

  if (isContractorSigurDryRun() || cur.sigur_employee_id == null) {
    await execute(
      `UPDATE contractor_passes
          SET sigur_sync_state = 'synced', sigur_sync_error = NULL, sigur_sync_updated_at = now()
        WHERE id = $1::uuid AND sigur_sync_state = 'revoking'`,
      [passId],
    );
    return;
  }

  const sigurEmployeeId = cur.sigur_employee_id;
  try {
    const poolDeptId = await requireFreePoolDepartmentId();
    const connection = await sigurService.getBackgroundConnectionType();

    let orphanInSigur = false;
    // Probe-чтение: Sigur 1.6.3.14 на GET удалённого профиля отвечает 422 (а не
    // 404). Так отделяем «профиль удалён» (orphan) от «реальной ошибки Sigur».
    try {
      await sigurService.getEmployeeById(sigurEmployeeId, connection);
    } catch (e) {
      if (isSigurNotFound(e)) orphanInSigur = true;
      else throw new SigurOperationError('move', sigurEmployeeId, e);
    }

    if (!orphanInSigur) {
      try {
        await moveSigurEmployee(sigurEmployeeId, poolDeptId, connection);
      } catch (e) {
        if (isSigurNotFound(e)) orphanInSigur = true;
        else throw new SigurOperationError('move', sigurEmployeeId, e);
      }
    }

    if (!orphanInSigur) {
      try {
        await updateSigurEmployee(
          sigurEmployeeId,
          { name: `Пропуск ${cur.pass_number}`, blocked: true },
          connection,
        );
      } catch (e) {
        if (isSigurNotFound(e)) orphanInSigur = true;
        else {
          // некритично — профиль перемещён, оставляем как есть, логируем деградацию
          console.warn('[processRevokePass] rename/block warning', {
            sigurEmployeeId, passNumber: cur.pass_number,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    await execute(
      `UPDATE contractor_passes
          SET sigur_sync_state = 'synced',
              sigur_sync_error = NULL,
              sigur_sync_updated_at = now(),
              sigur_employee_id = CASE WHEN $2::boolean THEN NULL ELSE sigur_employee_id END
        WHERE id = $1::uuid AND sigur_sync_state = 'revoking'`,
      [passId, orphanInSigur],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await execute(
      `UPDATE contractor_passes
          SET sigur_sync_attempts = sigur_sync_attempts + 1,
              sigur_sync_error = $2,
              sigur_sync_state = CASE WHEN sigur_sync_attempts + 1 >= $3 THEN 'failed' ELSE 'pending_revoke' END,
              sigur_sync_updated_at = now()
        WHERE id = $1::uuid AND sigur_sync_state = 'revoking'`,
      [passId, msg, MAX_REVOKE_SYNC_ATTEMPTS],
    );
    throw e;
  }
};

export interface IFailedSyncPass {
  id: string;
  pass_number: string;
  sigur_sync_error: string | null;
  sigur_sync_attempts: number;
  sigur_sync_updated_at: string | null;
}

/** Пропуска, у которых досинхронизация отзыва в Sigur застряла (sigur_sync_state='failed'). */
export const listFailedSyncs = async (): Promise<IFailedSyncPass[]> =>
  query<IFailedSyncPass>(
    `SELECT id, pass_number, sigur_sync_error, sigur_sync_attempts, sigur_sync_updated_at
       FROM contractor_passes
      WHERE sigur_sync_state = 'failed'
      ORDER BY sigur_sync_updated_at DESC NULLS LAST`,
  );

/** Сбросить застрявший отзыв на повторную обработку. true — если строка была 'failed'. */
export const retryRevokeSync = async (passId: string): Promise<boolean> => {
  const n = await execute(
    `UPDATE contractor_passes
        SET sigur_sync_state = 'pending_revoke',
            sigur_sync_attempts = 0,
            sigur_sync_error = NULL,
            sigur_sync_updated_at = now()
      WHERE id = $1::uuid AND sigur_sync_state = 'failed'`,
    [passId],
  );
  return n > 0;
};

/** Отозвать пропуск из пула (физически из Sigur не удаляем — оставляем как blocked-инвентарь). */
export const revokePoolPass = async (passId: string, userId: string): Promise<void> => {
  await withTransaction(async client => {
    await client.query(
      `UPDATE contractor_passes
          SET status = 'revoked', updated_at = now()
        WHERE id = $1::uuid AND status = 'in_pool'`,
      [passId],
    );
  });
  void userId;
};
