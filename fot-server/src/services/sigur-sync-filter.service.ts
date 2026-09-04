/**
 * Фильтр синхронизации отделов Sigur: единственная точка записи
 * `skud_sync_department_filter` и приведения `org_departments.is_active` /
 * `is_assignable` в соответствие с ним.
 *
 * Зачем отдельный сервис:
 * - Раньше запись шла как DELETE-all + INSERT ВНЕ транзакции (контроллер и
 *   фоновый ремап sigur-id), а реконсиляция активности была третьей отдельной
 *   операцией. Обрыв между шагами оставлял пустой whitelist — а пустой whitelist
 *   означает «ничего не синхронизируем» и реконсиляцию, гасящую все sigur-отделы.
 * - Теперь это одна транзакция под table-lock, а запись идемпотентна: повторное
 *   сохранение того же набора не меняет ни одной строки.
 *
 * Правила активности:
 * - `allowedIds` — whitelist, его потомки и структурные предки (путь до корня);
 * - `assignableIds` — whitelist и потомки: предок нужен для целостности дерева,
 *   но назначать в него нельзя;
 * - `safetyVisibleIds` — отделы с действующими сотрудниками И ВСЕ ИХ ПРЕДКИ.
 *   Их нельзя гасить: погашенный узел уносит из дерева всё поддерево, людей —
 *   из сводки подачи табеля, и рвёт скоуп табельщицы. Вне `allowedIds` они
 *   остаются видимыми, но неназначаемыми.
 * - ВКЛЮЧИТЬ отдел можно только по снимку Sigur (`aliveSigurIds`): whitelist и
 *   иерархия БД помнят строки, давно удалённые в Sigur, и без снимка реконсиляция
 *   воскрешала их (03–04.09.2026: «дубли папок», 88 фантомов). Фоновый ремап
 *   sigur-id активность не трогает вовсе: включать/выключать отделы имеют право
 *   только синк (по своему снимку) и пользователь при сохранении фильтра.
 */
import * as Sentry from '@sentry/node';
import type { PoolClient } from 'pg';
import { withTransaction } from '../config/postgres.js';
import { invalidateDeptTreeCache, invalidateSyncFilterCache } from './skud-shared.service.js';

export interface ISyncFilterInputRow {
  sigur_department_id: number;
  sigur_department_name: string | null;
}

export interface ISyncFilterWarning {
  department_id: string;
  name: string;
  employees: number;
}

export interface IReconcileActivityResult {
  activated: number;
  deactivated: number;
  assignableChanged: number;
  warnings: ISyncFilterWarning[];
  /** Неактивные отделы, которые надо включить, но снимка Sigur нет: включит ближайший синк. */
  deferredActivation: number;
}

export interface ISaveSyncFilterResult extends IReconcileActivityResult {
  inserted: number;
  updated: number;
  deleted: number;
}

interface IDepartmentRow {
  id: string;
  sigur_department_id: number | null;
  parent_id: string | null;
  name: string | null;
  is_active: boolean;
  is_assignable: boolean;
}

const BATCH = 500;

/** Попытка обнулить непустой фильтр без явного подтверждения. */
export class EmptySyncFilterError extends Error {
  readonly code = 'EMPTY_SYNC_FILTER';
  readonly currentCount: number;

  constructor(currentCount: number) {
    super('Пустой фильтр отключает синхронизацию с Sigur');
    this.name = 'EmptySyncFilterError';
    this.currentCount = currentCount;
  }
}

/** Дедупликация по sigur_department_id: последнее имя выигрывает. */
export function dedupeSyncFilterRows(rows: ISyncFilterInputRow[]): ISyncFilterInputRow[] {
  const byId = new Map<number, ISyncFilterInputRow>();
  for (const row of rows) {
    if (!Number.isFinite(row.sigur_department_id)) continue;
    byId.set(row.sigur_department_id, {
      sigur_department_id: row.sigur_department_id,
      sigur_department_name: row.sigur_department_name ?? null,
    });
  }
  return [...byId.values()];
}

function collectAncestors(ids: Iterable<string>, parentById: Map<string, string | null>): Set<string> {
  const result = new Set<string>(ids);
  for (const id of [...result]) {
    let current = parentById.get(id) ?? null;
    while (current !== null && !result.has(current)) {
      result.add(current);
      current = parentById.get(current) ?? null;
    }
  }
  return result;
}

function collectDescendants(ids: Iterable<string>, childrenByParent: Map<string, string[]>): Set<string> {
  const result = new Set<string>();
  const queue = [...ids];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    for (const child of childrenByParent.get(current) ?? []) {
      if (!result.has(child)) queue.push(child);
    }
  }
  return result;
}

async function updateFlagBatched(
  client: PoolClient,
  column: 'is_active' | 'is_assignable',
  ids: string[],
  value: boolean,
): Promise<number> {
  let changed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    // IS DISTINCT FROM: повторный прогон не переписывает уже верные строки.
    const res = await client.query(
      `UPDATE org_departments SET ${column} = $2
        WHERE id = ANY($1::uuid[]) AND ${column} IS DISTINCT FROM $2`,
      [batch, value],
    );
    changed += res.rowCount ?? 0;
  }
  return changed;
}

/**
 * Приводит is_active/is_assignable в соответствие с whitelist. Выполняется
 * ТОЛЬКО внутри транзакции вызывающего — вместе с записью самого фильтра.
 * Ручные отделы (sigur_department_id IS NULL) не трогаются.
 *
 * aliveSigurIds — отделы текущего снимка Sigur (/departments). ВКЛЮЧАЕМ только то,
 * что есть в снимке: строка вне снимка — фантом, удалённый в Sigur, и воскрешать
 * её нельзя ни по whitelist, ни ради числящихся людей (о таких только сигналим).
 * null = снимок недоступен → никого не включаем (deferredActivation), это сделает
 * ближайший синк по своему снимку; гашение и назначаемость приводятся как обычно.
 */
export async function reconcileDepartmentsActivity(
  client: PoolClient,
  whitelistSigurIds: number[],
  aliveSigurIds: ReadonlySet<number> | null,
): Promise<IReconcileActivityResult> {
  // ORDER BY is_active ASC → активная строка выигрывает Map.set при осиротевшем
  // дубликате с тем же sigur_id (между пересозданием компании и consolidate).
  const { rows } = await client.query<IDepartmentRow>(
    `SELECT id, sigur_department_id, parent_id, name, is_active, is_assignable
       FROM org_departments
      ORDER BY is_active ASC, id ASC`,
  );

  const rowById = new Map(rows.map(row => [row.id, row]));
  const sigurIdToDbId = new Map<number, string>();
  const parentById = new Map<string, string | null>();
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    parentById.set(row.id, row.parent_id);
    if (row.sigur_department_id != null) sigurIdToDbId.set(row.sigur_department_id, row.id);
    if (row.parent_id) {
      const siblings = childrenByParent.get(row.parent_id) ?? [];
      siblings.push(row.id);
      childrenByParent.set(row.parent_id, siblings);
    }
  }

  const whitelistDbIds: string[] = [];
  for (const sigurId of whitelistSigurIds) {
    const dbId = sigurIdToDbId.get(sigurId);
    if (dbId) whitelistDbIds.push(dbId);
  }

  const assignableIds = collectDescendants(whitelistDbIds, childrenByParent);
  const allowedIds = collectAncestors(assignableIds, parentById);

  const { rows: populatedRows } = await client.query<{ org_department_id: string; employees: string }>(
    `SELECT org_department_id, count(*)::text AS employees
       FROM employees
      WHERE is_archived = false AND org_department_id IS NOT NULL
      GROUP BY org_department_id`,
  );
  const employeesByDept = new Map<string, number>();
  for (const row of populatedRows) {
    employeesByDept.set(row.org_department_id, Number(row.employees));
  }
  const safetyVisibleIds = collectAncestors(employeesByDept.keys(), parentById);

  const nameById = new Map(rows.map(row => [row.id, row.name ?? '']));
  const sigurDbIds = rows.filter(row => row.sigur_department_id != null).map(row => row.id);

  const toActivate: string[] = [];
  const toDeactivate: string[] = [];
  const toAssignable: string[] = [];
  const toUnassignable: string[] = [];
  const warnings: ISyncFilterWarning[] = [];
  const absentWithPeople: string[] = [];
  let deferredActivation = 0;

  for (const id of sigurDbIds) {
    const row = rowById.get(id)!;
    const allowed = allowedIds.has(id);
    const protectedByPeople = safetyVisibleIds.has(id);

    if (!allowed && !protectedByPeople) {
      toDeactivate.push(id);
    } else if (!row.is_active) {
      // Активная строка остаётся как есть; неактивную включаем только по снимку Sigur.
      if (aliveSigurIds === null) {
        deferredActivation++;
      } else if (aliveSigurIds.has(row.sigur_department_id as number)) {
        toActivate.push(id);
      } else if (protectedByPeople) {
        absentWithPeople.push(`${nameById.get(id) || id} (${employeesByDept.get(id) ?? 0})`);
      }
    }

    if (assignableIds.has(id)) toAssignable.push(id);
    else toUnassignable.push(id);

    if (!allowed && protectedByPeople) {
      warnings.push({
        department_id: id,
        name: nameById.get(id) ?? '',
        employees: employeesByDept.get(id) ?? 0,
      });
    }
  }

  const activated = await updateFlagBatched(client, 'is_active', toActivate, true);
  const deactivated = await updateFlagBatched(client, 'is_active', toDeactivate, false);
  const assignableChanged =
    (await updateFlagBatched(client, 'is_assignable', toAssignable, true))
    + (await updateFlagBatched(client, 'is_assignable', toUnassignable, false));

  if (warnings.length > 0) {
    const preview = warnings.slice(0, 10).map(item => `${item.name} (${item.employees})`).join(', ');
    const message = `[sync-filter] ${warnings.length} отделов вне фильтра оставлены активными ради сотрудников: ${preview}`;
    console.warn(message);
    Sentry.captureMessage(message, { level: 'warning', tags: { service: 'sync-filter' } });
  }
  if (absentWithPeople.length > 0) {
    // «surface, don't mask»: людей в отделе, которого нет в Sigur, надо перевести руками.
    const message = `[sync-filter] ${absentWithPeople.length} неактивных отделов с сотрудниками нет в снимке Sigur — не включаем: `
      + absentWithPeople.slice(0, 10).join(', ');
    console.warn(message);
    Sentry.captureMessage(message, { level: 'warning', tags: { service: 'sync-filter' } });
  }
  if (deferredActivation > 0) {
    console.warn(`[sync-filter] снимок Sigur недоступен: включение ${deferredActivation} отделов отложено до ближайшего синка`);
  }

  return { activated, deactivated, assignableChanged, warnings, deferredActivation };
}

export interface ISaveSyncFilterOptions {
  source: string;
  /** Разрешить пустой набор при непустом фильтре (пустой whitelist выключает синхронизацию). */
  allowEmpty?: boolean;
  /**
   * Реконсиляция активности отделов после записи. Не задана — пишутся ТОЛЬКО строки
   * фильтра: так работает фоновый ремап sigur-id, которому включать/выключать отделы
   * нельзя. Пользовательское сохранение передаёт снимок Sigur (aliveSigurIds,
   * null = недоступен) — см. reconcileDepartmentsActivity.
   */
  reconcile?: { aliveSigurIds: ReadonlySet<number> | null };
}

const noActivityChanges = (): IReconcileActivityResult => ({
  activated: 0,
  deactivated: 0,
  assignableChanged: 0,
  warnings: [],
  deferredActivation: 0,
});

/**
 * Единственный путь записи фильтра. Одна транзакция: lock → upsert → удаление
 * лишних → (при options.reconcile) реконсиляция активности. Кэши сбрасываются
 * только после коммита.
 *
 * allowEmpty=false (по умолчанию) запрещает обнулить непустой фильтр: пустой
 * whitelist выключает синхронизацию целиком.
 */
export async function saveSyncFilterWithReconciliation(
  inputRows: ISyncFilterInputRow[],
  options: ISaveSyncFilterOptions,
): Promise<ISaveSyncFilterResult> {
  const rows = dedupeSyncFilterRows(inputRows);

  const result = await withTransaction(async client => {
    // Без блокировки два параллельных сохранения дают объединение наборов:
    // каждый видит собственный INSERT, а их DELETE не пересекаются.
    await client.query('LOCK TABLE skud_sync_department_filter IN SHARE ROW EXCLUSIVE MODE');

    const { rows: currentRows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM skud_sync_department_filter',
    );
    const currentCount = Number(currentRows[0]?.count ?? '0');

    if (rows.length === 0 && currentCount > 0 && !options.allowEmpty) {
      throw new EmptySyncFilterError(currentCount);
    }

    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const params: unknown[] = [];
      const placeholders: string[] = [];
      for (const row of batch) {
        params.push(row.sigur_department_id, row.sigur_department_name);
        placeholders.push(`($${params.length - 1}, $${params.length})`);
      }
      // Идемпотентный upsert: имя переписывается, только если реально изменилось,
      // поэтому повторное сохранение того же набора возвращает нули.
      const res = await client.query<{ inserted: boolean }>(
        `INSERT INTO skud_sync_department_filter (sigur_department_id, sigur_department_name)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (sigur_department_id) DO UPDATE
            SET sigur_department_name = EXCLUDED.sigur_department_name
          WHERE skud_sync_department_filter.sigur_department_name
                IS DISTINCT FROM EXCLUDED.sigur_department_name
         RETURNING (xmax = 0) AS inserted`,
        params,
      );
      for (const row of res.rows) {
        if (row.inserted) inserted++;
        else updated++;
      }
    }

    const deleteRes = rows.length > 0
      ? await client.query(
        'DELETE FROM skud_sync_department_filter WHERE sigur_department_id <> ALL($1::int[])',
        [rows.map(row => row.sigur_department_id)],
      )
      : await client.query('DELETE FROM skud_sync_department_filter');

    const reconciled = options.reconcile
      ? await reconcileDepartmentsActivity(
        client,
        rows.map(row => row.sigur_department_id),
        options.reconcile.aliveSigurIds,
      )
      : noActivityChanges();

    return {
      inserted,
      updated,
      deleted: deleteRes.rowCount ?? 0,
      ...reconciled,
    };
  });

  // Кэши сбрасываем только после коммита: иначе на откате в них попадёт состояние,
  // которого в БД нет. Дерево отделов меняется только при реконсиляции.
  invalidateSyncFilterCache();
  if (options.reconcile) invalidateDeptTreeCache();

  console.log(
    `[sync-filter] saved (${options.source}): +${result.inserted} ~${result.updated} -${result.deleted},`
    + (options.reconcile
      ? ` активность +${result.activated}/-${result.deactivated}, назначаемость ${result.assignableChanged},`
        + ` предупреждений ${result.warnings.length}, отложено ${result.deferredActivation}`
      : ' активность не трогали (только строки фильтра)'),
  );

  return result;
}
