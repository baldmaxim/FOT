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
          await assignSigurEmployeeCardBinding(sigurEmployeeId, [cardUid], undefined, connection);
        } catch (cardError) {
          const m = cardError instanceof Error ? cardError.message : String(cardError);
          warnings.push(`${passNumber} карта: ${m}`);
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

  const rows = await query<{ id: string; pass_number: string; sigur_employee_id: number | null; status: string }>(
    `SELECT id, pass_number, sigur_employee_id, status
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
      }
      await execute(
        `UPDATE contractor_passes
            SET org_department_id = $1::uuid,
                status = 'assigned',
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

/**
 * Отозвать отправленный подрядчику пропуск обратно в общий пул.
 *
 * Покрывает все «занятые» статусы (assigned/submitted/applied/blocked).
 * В Sigur: профиль move обратно в папку пула + переименование в «Пропуск NNNN»
 * + blocked=true. В PG: status='in_pool', org_department_id=NULL, holder_name=NULL,
 * submission_id=NULL, access_point_names=NULL, approval_status='not_submitted';
 * открытая holder-строка закрывается valid_until=now().
 */
export const revokePassToPool = async (input: {
  passId: string;
  userId: string;
}): Promise<IRevokeToPoolResult> => {
  const dryRun = isContractorSigurDryRun();
  const connection = dryRun ? undefined : await sigurService.getBackgroundConnectionType();

  const pass = await queryOne<{
    id: string; pass_number: string; status: string;
    sigur_employee_id: number | null; org_department_id: string | null;
  }>(
    `SELECT id, pass_number, status, sigur_employee_id, org_department_id
       FROM contractor_passes WHERE id = $1::uuid`,
    [input.passId],
  );
  if (!pass) throw new Error('Пропуск не найден');
  if (pass.status === 'in_pool') {
    throw new Error('Пропуск уже в пуле');
  }
  if (pass.status === 'revoked') {
    throw new Error('Пропуск отозван и недоступен');
  }

  const poolDeptId = dryRun ? 0 : await requireFreePoolDepartmentId();

  let orphanInSigur = false;
  if (!dryRun && pass.sigur_employee_id) {
    // Probe-чтение: Sigur 1.6.3.14 на GET удалённого профиля отвечает 422 (а не
    // 404), а updateSigurEmployee внутри делает префлайт-getProfile, который на
    // orphan сразу падает 422. Проверяем существование явно — так разделяем
    // «профиль удалён» (orphan path) и «реальная ошибка Sigur» (502).
    try {
      await sigurService.getEmployeeById(pass.sigur_employee_id, connection);
    } catch (e) {
      if (isSigurNotFound(e)) {
        orphanInSigur = true;
        console.warn('[revokePassToPool] Sigur profile missing (probe), unbinding', {
          passId: pass.id,
          passNumber: pass.pass_number,
          sigurEmployeeId: pass.sigur_employee_id,
        });
      } else {
        throw new SigurOperationError('move', pass.sigur_employee_id, e);
      }
    }

    if (!orphanInSigur) {
      try {
        await moveSigurEmployee(pass.sigur_employee_id, poolDeptId, connection);
      } catch (e) {
        if (isSigurNotFound(e)) {
          orphanInSigur = true;
          console.warn('[revokePassToPool] Sigur profile vanished between probe and move', {
            passId: pass.id,
            sigurEmployeeId: pass.sigur_employee_id,
          });
        } else {
          throw new SigurOperationError('move', pass.sigur_employee_id, e);
        }
      }
    }

    if (!orphanInSigur) {
      try {
        await updateSigurEmployee(
          pass.sigur_employee_id,
          { name: `Пропуск ${pass.pass_number}`, blocked: true },
          connection,
        );
      } catch (e) {
        if (isSigurNotFound(e)) {
          orphanInSigur = true;
          console.warn('[revokePassToPool] Sigur profile vanished mid-revoke', {
            passId: pass.id,
            sigurEmployeeId: pass.sigur_employee_id,
          });
        } else {
          // некритично — оставляем как есть, но логируем деградацию
          console.warn('[revokePassToPool] rename/block warning', {
            sigurEmployeeId: pass.sigur_employee_id,
            passNumber: pass.pass_number,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }

  await withTransaction(async client => {
    await client.query(
      `UPDATE contractor_passes
          SET status = 'in_pool',
              org_department_id = NULL,
              holder_name = NULL,
              submission_id = NULL,
              access_point_names = NULL,
              approval_status = 'not_submitted',
              is_active = false,
              sigur_employee_id = CASE WHEN $2::boolean THEN NULL ELSE sigur_employee_id END,
              updated_at = now()
        WHERE id = $1::uuid`,
      [pass.id, orphanInSigur],
    );
    await client.query(
      `UPDATE contractor_pass_holders
          SET valid_until = now()
        WHERE pass_id = $1::uuid AND valid_until IS NULL`,
      [pass.id],
    );
  });

  void input.userId;
  return {
    pass_id: pass.id,
    pass_number: pass.pass_number,
    status: 'returned_to_pool',
    ...(orphanInSigur ? { sigur_orphan: true } : {}),
  };
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
