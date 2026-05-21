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

/** Список пропусков, лежащих в общем пуле (status='in_pool'). */
export const listPool = async (filter?: { search?: string }): Promise<IPoolItem[]> => {
  const search = filter?.search?.trim();
  if (search) {
    return query<IPoolItem>(
      `SELECT id, pass_number, card_uid, sigur_employee_id, created_at
         FROM contractor_passes
        WHERE status = 'in_pool'
          AND (pass_number ILIKE $1 OR card_uid ILIKE $1)
        ORDER BY pass_number::int ASC`,
      [`%${search}%`],
    );
  }
  return query<IPoolItem>(
    `SELECT id, pass_number, card_uid, sigur_employee_id, created_at
       FROM contractor_passes
      WHERE status = 'in_pool'
      ORDER BY pass_number::int ASC`,
  );
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
