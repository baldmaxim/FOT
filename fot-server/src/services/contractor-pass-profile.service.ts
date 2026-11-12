/**
 * Профиль Sigur пропуска подрядчика перед «Открыть пропуска».
 *
 * Профиль-контейнер пропуска мог попасть в «Уволенные» Sigur (одобренное удаление строки
 * «Пропуск N» в «Сотрудниках» подрядчика оформлялось кадровым увольнением, а синк держит
 * уволенных в архивной папке) и там быть удалён вручную в Sigur Manager. Одобрение после
 * этого падало на 422 (НСТ 6579/6588, 12.11.2026; 5628, 15.10.2026).
 *
 * Здесь профиль приводится в рабочее состояние до записи карты:
 *  - удалён → создаётся заново в папке подрядчика (как при выпуске в пул: «Пропуск N»,
 *    FOT-POOL:N, заблокирован), ссылка переносится в contractor_passes, зеркало employees
 *    и ростер — CAS по старому id, без второй строки зеркала;
 *  - «уволен» (зеркало fired или карточка в архивной папке) → возвращается в папку
 *    подрядчика durable-операцией, БЕЗ разблокировки: доступ открывает само одобрение.
 */
import * as Sentry from '@sentry/node';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import { sigurService } from './sigur.service.js';
import type { ConnectionType } from './sigur-base.service.js';
import { settingsService } from './settings.service.js';
import { auditService } from './audit.service.js';
import { employeeCache } from './employee-cache.service.js';
import { getOrgSigurDepartmentId } from './contractor-scope.service.js';
import {
  buildPoolProfileInput,
  findPoolProfileIdsInList,
  getFreePoolDepartmentId,
} from './contractor-pool.service.js';
import {
  createSigurEmployee,
  deleteSigurEmployee,
  moveSigurEmployee,
  updateSigurEmployee,
} from './sigur-live-employees-crud.service.js';
import {
  executeOperation,
  openRehireOperation,
  openRepairOperation,
  probeSigurCard,
  type ISigurCardProbe,
} from './employee-lifecycle-operations.service.js';

export interface IPassProfileRef {
  id: string;
  passNumber: string;
  sigurEmployeeId: number;
  orgDepartmentId: string | null;
}

export type TPassProfileRestore = 'rehire' | 'repair' | 'move' | null;

export interface IPassProfileReady {
  /** Актуальный профиль пропуска: после пересоздания — новый id. */
  sigurEmployeeId: number;
  recreated: boolean;
  restored: TPassProfileRestore;
}

/**
 * Невыданный живой пропуск, чей это профиль Sigur (свободный, поданный, ждущий нового
 * держателя). Такой профиль — контейнер пропуска, а не человек: «удаление» строки
 * «Пропуск N» в «Сотрудниках» подрядчика не должно его увольнять или удалять — иначе
 * профиль уходит в «Уволенные» Sigur и следующее «Открыть» падает на 422.
 */
export async function findUnissuedPassByProfile(
  sigurEmployeeId: number,
): Promise<{ id: string; pass_number: string } | null> {
  return queryOne<{ id: string; pass_number: string }>(
    `SELECT id, pass_number
       FROM contractor_passes
      WHERE sigur_employee_id = $1
        AND status NOT IN ('applied', 'revoked')
      ORDER BY updated_at DESC
      LIMIT 1`,
    [sigurEmployeeId],
  );
}

/** Профиль удалён: точечный GET отвечает 404, в Sigur 1.6.3.14 — 422. Только для GET по id. */
export const isPassProfileDeleted = (probe: ISigurCardProbe): boolean =>
  probe.state === 'deleted' || (probe.state === 'unknown' && probe.httpStatus === 422);

const normalizeId = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Профили «Пропуск N» / FOT-POOL:N в папках подрядчика, архива и пула, не занятые другим
 * живым пропуском. Переиспользуется только «свой» осиротевший профиль: в папке подрядчика
 * и без карт (остаток прерванного пересоздания). Любой другой найденный профиль — ручная
 * проверка: на нём может висеть чужая карта, которая после одобрения открыла бы доступ.
 */
async function findReusableProfile(
  pass: IPassProfileRef,
  orgSigurDepartmentId: number,
  archiveDepartmentId: number | null,
  connection?: ConnectionType,
): Promise<number | null> {
  const freePoolDepartmentId = await getFreePoolDepartmentId();
  const departmentIds = [...new Set([orgSigurDepartmentId, archiveDepartmentId, freePoolDepartmentId]
    .filter((d): d is number => d != null && d > 0))];

  const departmentById = new Map<number, number>();
  for (const departmentId of departmentIds) {
    const list = await sigurService.getEmployees({ departmentId }, connection) as Record<string, unknown>[];
    for (const id of findPoolProfileIdsInList(list, pass.passNumber)) {
      departmentById.set(id, departmentId);
    }
  }
  const ids = [...departmentById.keys()];
  if (ids.includes(pass.sigurEmployeeId)) {
    throw new Error(`Sigur не отдаёт профиль ${pass.sigurEmployeeId}, но он есть в списке — повторите позже`);
  }
  if (ids.length === 0) return null;

  const taken = await query<{ sid: string }>(
    `SELECT DISTINCT sigur_employee_id::text AS sid
       FROM contractor_passes
      WHERE sigur_employee_id = ANY($1::bigint[])
        AND id <> $2::uuid
        AND status <> 'revoked'`,
    [ids, pass.id],
  );
  const takenIds = new Set(taken.map(r => Number(r.sid)));
  const free = ids.filter(id => !takenIds.has(id));
  if (free.length === 0) return null;

  const reusable: number[] = [];
  for (const id of free) {
    if (departmentById.get(id) !== orgSigurDepartmentId) continue;
    const cards = await sigurService.getCardBindings({ employeeId: id }, connection) as unknown[];
    if (cards.length === 0) reusable.push(id);
  }
  if (free.length > 1 || reusable.length !== free.length) {
    throw new Error(
      `профиль пропуска удалён в Sigur, а в Sigur есть другие профили «Пропуск ${pass.passNumber}» `
      + `(${free.join(', ')}) — нужна ручная проверка`,
    );
  }
  return reusable[0];
}

/**
 * Перенос ссылки на новый профиль одной транзакцией, CAS по старому id: пропуск, зеркало
 * employees (та же строка — без второй строки после синка) и строка ростера подрядчика.
 */
async function relinkPassProfile(pass: IPassProfileRef, oldId: number, newId: number): Promise<number[]> {
  return withTransaction(async (client) => {
    const passUpdate = await client.query(
      `UPDATE contractor_passes
          SET sigur_employee_id = $3, updated_at = now()
        WHERE id = $1::uuid AND sigur_employee_id = $2`,
      [pass.id, oldId, newId],
    );
    if (passUpdate.rowCount !== 1) {
      throw new Error('пропуск изменился во время восстановления профиля — повторите');
    }
    const employees = await client.query<{ id: number }>(
      `UPDATE employees
          SET sigur_employee_id = $2, updated_at = now()
        WHERE id = (
                SELECT id FROM employees
                 WHERE sigur_employee_id = $1
                 ORDER BY is_archived ASC, id DESC
                 LIMIT 1
              )
          AND NOT EXISTS (
                SELECT 1 FROM employees WHERE sigur_employee_id = $2 AND is_archived = false
              )
        RETURNING id`,
      [oldId, newId],
    );
    if (pass.orgDepartmentId) {
      await client.query(
        `UPDATE contractor_roster
            SET sigur_employee_id = $3, updated_at = now()
          WHERE org_department_id = $1::uuid
            AND sigur_employee_id = $2
            AND NOT EXISTS (
                  SELECT 1 FROM contractor_roster r2
                   WHERE r2.org_department_id = $1::uuid AND r2.sigur_employee_id = $3
                )`,
        [pass.orgDepartmentId, oldId, newId],
      );
    }
    return employees.rows.map(r => Number(r.id));
  });
}

/** Удалённый профиль → новый «Пропуск N» в папке подрядчика. Сериализовано по пропуску. */
async function recreatePassProfile(
  pass: IPassProfileRef,
  archiveDepartmentId: number | null,
  userId: string | null,
  connection?: ConnectionType,
): Promise<{ sigurEmployeeId: number; recreated: boolean }> {
  if (!pass.orgDepartmentId) {
    throw new Error('профиль пропуска удалён в Sigur, а пропуск не назначен подрядчику');
  }
  const orgDepartmentId = pass.orgDepartmentId;
  const orgSigurDepartmentId = await getOrgSigurDepartmentId(orgDepartmentId);
  const oldId = pass.sigurEmployeeId;

  return withTransaction(async (lockClient) => {
    // Два одновременных «Открыть» по одному пропуску не создают два профиля:
    // второй дождётся первого и увидит уже новый id.
    await lockClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`contractor_pass:${pass.id}`]);
    const fresh = await queryOne<{ sigur_employee_id: string | null }>(
      'SELECT sigur_employee_id::text AS sigur_employee_id FROM contractor_passes WHERE id = $1::uuid',
      [pass.id],
    );
    const currentId = normalizeId(fresh?.sigur_employee_id);
    if (currentId !== oldId) {
      if (currentId == null) throw new Error('у пропуска больше нет профиля Sigur');
      return { sigurEmployeeId: currentId, recreated: false };
    }

    const reusedId = await findReusableProfile(pass, orgSigurDepartmentId, archiveDepartmentId, connection);
    const created = { id: null as number | null };
    let newId: number;
    try {
      if (reusedId != null) {
        await updateSigurEmployee(reusedId, { blocked: true }, connection);
        newId = reusedId;
      } else {
        const profile = await createSigurEmployee(
          buildPoolProfileInput(pass.passNumber, orgSigurDepartmentId),
          connection,
          { onCreated: (id) => { created.id = id; } },
        );
        newId = profile.sigurEmployeeId;
      }
      const employeeIds = await relinkPassProfile(pass, oldId, newId);
      for (const employeeId of employeeIds) employeeCache.invalidate(employeeId);
    } catch (error) {
      // Компенсация: созданный здесь профиль без ссылки из ФОТ не оставляем.
      if (created.id != null) {
        try {
          await deleteSigurEmployee(created.id, connection);
        } catch (cleanupError) {
          console.error(
            `[contractor-pass-profile] пропуск ${pass.passNumber}: не удалось удалить созданный профиль ${created.id}`,
            cleanupError,
          );
        }
      }
      throw error;
    }

    await auditService.log({
      user_id: userId,
      action: 'UPDATE_EMPLOYEE',
      entity_type: 'sigur_employee',
      entity_id: String(newId),
      details: {
        action: 'recreate_pass_profile',
        pass_id: pass.id,
        pass_number: pass.passNumber,
        previous_sigur_employee_id: oldId,
        reused: reusedId != null,
      },
    });
    console.log(
      `[contractor-pass-profile] пропуск ${pass.passNumber}: профиль ${oldId} удалён в Sigur → `
      + `${reusedId != null ? 'найден' : 'создан'} ${newId}`,
    );
    return { sigurEmployeeId: newId, recreated: true };
  });
}

/**
 * Профиль в «Уволенных» → обратно в папку подрядчика, без разблокировки.
 * Зеркало fired — восстановление (иначе синк снова унесёт карточку в архив),
 * зеркало активное — ремонт карточки, зеркала нет — прямой перенос.
 */
async function returnToContractorFolder(
  pass: IPassProfileRef,
  sigurEmployeeId: number,
  probe: ISigurCardProbe,
  userId: string | null,
  connection?: ConnectionType,
): Promise<TPassProfileRestore> {
  if (!pass.orgDepartmentId) return null;
  const mirror = await queryOne<{ id: number; employment_status: string }>(
    `SELECT id, employment_status FROM employees
      WHERE sigur_employee_id = $1
      ORDER BY is_archived ASC, id DESC
      LIMIT 1`,
    [sigurEmployeeId],
  );
  const mirrorFired = mirror?.employment_status === 'fired';
  if (!mirrorFired && probe.state !== 'archived') return null;

  const targetSigurDepartmentId = await getOrgSigurDepartmentId(pass.orgDepartmentId);
  if (mirror && mirrorFired) {
    const operation = await openRehireOperation({
      employeeId: Number(mirror.id),
      targetDepartmentId: pass.orgDepartmentId,
      targetSigurDepartmentId,
      createdBy: userId,
      source: 'contractor_admin',
      sigurAccessRequired: false,
    });
    await executeOperation(operation, connection);
    return 'rehire';
  }
  if (mirror) {
    const operation = await openRepairOperation({
      employeeId: Number(mirror.id),
      targetDepartmentId: pass.orgDepartmentId,
      targetSigurDepartmentId,
      createdBy: userId,
    });
    // null — по сотруднику уже идёт операция, её исполнитель доведёт карточку сам.
    if (operation) await executeOperation(operation, connection);
    return 'repair';
  }
  await moveSigurEmployee(sigurEmployeeId, targetSigurDepartmentId, connection);
  return 'move';
}

/**
 * Готовит профиль пропуска к одобрению и возвращает его актуальный id: вызывающий
 * обязан дальше использовать только его (карта, имя, точки, аудит).
 * Неудачное пересоздание — ошибка одобрения (без профиля открыть нельзя); неудачный
 * возврат из архива — предупреждение в лог, одобрение идёт как раньше.
 */
export async function ensurePassProfileReady(
  pass: IPassProfileRef,
  userId: string | null,
  connection?: ConnectionType,
): Promise<IPassProfileReady> {
  const archiveDepartmentId = (await settingsService.getSigurConnectionSettings()).archiveDepartmentId ?? null;
  let sigurEmployeeId = pass.sigurEmployeeId;
  let probe = await probeSigurCard(sigurEmployeeId, archiveDepartmentId, connection);
  let recreated = false;

  if (isPassProfileDeleted(probe)) {
    const result = await recreatePassProfile(pass, archiveDepartmentId, userId, connection);
    sigurEmployeeId = result.sigurEmployeeId;
    recreated = result.recreated;
    probe = await probeSigurCard(sigurEmployeeId, archiveDepartmentId, connection);
  }

  // Sigur не ответил внятно — дальше обычные шаги одобрения, как раньше.
  if (probe.state !== 'working' && probe.state !== 'archived') {
    return { sigurEmployeeId, recreated, restored: null };
  }

  let restored: TPassProfileRestore = null;
  try {
    restored = await returnToContractorFolder(
      { ...pass, sigurEmployeeId },
      sigurEmployeeId,
      probe,
      userId,
      connection,
    );
  } catch (error) {
    console.warn(
      `[contractor-pass-profile] пропуск ${pass.passNumber}: профиль ${sigurEmployeeId} не возвращён из архива`,
      error,
    );
    Sentry.captureException(error, {
      tags: { service: 'contractor-pass-profile', stage: 'return-from-archive' },
      extra: { passId: pass.id, passNumber: pass.passNumber, sigurEmployeeId },
    });
  }
  return { sigurEmployeeId, recreated, restored };
}
