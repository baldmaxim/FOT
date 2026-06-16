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
import { query, execute, queryOne, withTransaction } from '../config/postgres.js';
import { settingsService } from './settings.service.js';
import { sigurService } from './sigur.service.js';
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

export interface IPoolCell {
  pass_number: string;
  status: 'free' | 'occupied';
  /** id строки in_pool (нужен для назначения); null для занятых. */
  id: string | null;
}

export interface IPoolMatrixResult {
  cells: IPoolCell[];
  totals: { free: number; occupied: number };
}

/**
 * Плоская матрица всего пула для UI: одна ячейка на номер пропуска, с цветом по
 * статусу. Дедупликация по pass_number та же, что в getPoolRanges:
 *   free     — ВСЕ строки номера in_pool без org → берём id свободной строки;
 *   occupied — есть хоть одна занятая строка → id=null.
 * revoked в выборку не попадает.
 */
export const getPoolMatrix = async (): Promise<IPoolMatrixResult> => {
  const cells = await query<IPoolCell>(
    `SELECT pass_number,
            CASE
              WHEN bool_and(status = 'in_pool' AND org_department_id IS NULL)
                THEN 'free'
              ELSE 'occupied'
            END AS status,
            (array_agg(id) FILTER (WHERE status = 'in_pool' AND org_department_id IS NULL))[1] AS id
       FROM contractor_passes
      WHERE pass_number ~ '^[0-9]+$'
        AND status <> 'revoked'
      GROUP BY pass_number
      ORDER BY pass_number::bigint ASC`,
  );

  let free = 0;
  let occupied = 0;
  for (const c of cells) {
    if (c.status === 'free') free += 1; else occupied += 1;
  }

  return { cells, totals: { free, occupied } };
};

export interface IAddPoolInput {
  from: number;
  to?: number;
  cards: Array<{ uid: string; sequence: number }>;
  createdBy: string;
}

export interface IAddPoolResult {
  created: string[];
  failed: Array<{ pass_number: string; error: string }>;
  warnings: string[];
}

/**
 * Массовое добавление карт в общий пул. Для каждой:
 *   1) создаём в Sigur заблокированный профиль «Пропуск NNNN» в выбранной папке;
 *   2) привязываем карту по UID-кандидатам;
 *   3) INSERT contractor_passes (status='in_pool', org_department_id=NULL).
 * Идемпотентно по pass_number в пуле (частичный UNIQUE).
 */
export const addPassesToPool = async (input: IAddPoolInput): Promise<IAddPoolResult> => {
  const dryRun = isContractorSigurDryRun();
  const poolDeptId = dryRun ? 0 : await requireFreePoolDepartmentId();
  const connection = dryRun ? undefined : await sigurService.getBackgroundConnectionType();

  const maxSeq = input.cards.reduce((m, c) => Math.max(m, c.sequence), 0);
  const lastNumber = Math.max(input.to ?? 0, input.from + maxSeq);
  const width = Math.max(2, String(lastNumber).length);

  const created: string[] = [];
  const failed: Array<{ pass_number: string; error: string }> = [];
  const warnings: string[] = [];

  const cards = [...input.cards].sort((a, b) => a.sequence - b.sequence);
  for (const card of cards) {
    const num = input.from + card.sequence;
    if (input.to && num > input.to) {
      failed.push({ pass_number: String(num), error: `вне пула (> ${input.to})` });
      continue;
    }
    const passNumber = String(num).padStart(width, '0');
    const cardUid = card.uid.trim();

    // Идемпотентность: если уже в пуле — пропускаем.
    const exists = await queryOne<{ id: string }>(
      `SELECT id FROM contractor_passes
        WHERE pass_number = $1 AND org_department_id IS NULL`,
      [passNumber],
    );
    if (exists) {
      warnings.push(`${passNumber}: уже в пуле`);
      continue;
    }

    try {
      let sigurEmployeeId: number;
      if (dryRun) {
        sigurEmployeeId = -(Date.now() + num);
      } else {
        const profile = await createSigurEmployee({
          name: `Пропуск ${passNumber}`,
          departmentId: poolDeptId,
          description: `FOT-POOL:${passNumber}`,
          blocked: true,
        }, connection);
        sigurEmployeeId = profile.sigurEmployeeId;
        try {
          // Карта обязательна: при отсутствии в Sigur — создаём из UID/W26.
          await assignSigurEmployeeCardBinding(sigurEmployeeId, [cardUid], undefined, connection, true);
        } catch (cardError) {
          const m = cardError instanceof Error ? cardError.message : String(cardError);
          // Провал привязки карты => пропуск в пул не попадает. В БД не пишем,
          // подчищаем только что созданный Sigur-профиль (best-effort).
          try {
            await sigurService.deleteEmployee(sigurEmployeeId, connection);
          } catch (cleanupError) {
            warnings.push(`${passNumber} очистка профиля: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
          failed.push({ pass_number: passNumber, error: `карта: ${m}` });
          continue;
        }
      }

      await execute(
        `INSERT INTO contractor_passes
           (org_department_id, pass_number, sigur_employee_id, card_uid, status, created_by)
         VALUES (NULL, $1, $2, $3, 'in_pool', $4::uuid)
         ON CONFLICT DO NOTHING`,
        [passNumber, sigurEmployeeId, cardUid, input.createdBy],
      );
      created.push(passNumber);
    } catch (passError) {
      const msg = passError instanceof Error ? passError.message : String(passError);
      failed.push({ pass_number: passNumber, error: msg });
    }
  }

  return { created, failed, warnings };
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
