// Смена типа зоны точки доступа («внутренняя» ⇄ «внешняя») с датой начала действия.
//
// Правило даты: не раньше 1-го числа текущего месяца и не позже сегодня (МСК). Раньше нельзя,
// чтобы смена не пересчитала закрытые месяцы — как 12.10.2026, когда флаг без даты изменил
// табели с мая. Позже нельзя, чтобы тип «на сегодня» всегда совпадал с тем, что видно в таблице.
//
// История точки хранится строками «с даты — такой тип». Смена с даты D:
//   • строки с датой >= D удаляются (они всегда из текущего месяца);
//   • новая строка добавляется, только если тип накануне D другой — иначе история просто
//     «схлопывается» (отмена предыдущей смены не оставляет лишней пары строк).
//
// История нужна только расчёту часов в табеле. Экраны портала (присутствие, списки проходов,
// выгрузки СКУД) читают тип «на сегодня» из прежней таблицы skud_access_point_settings и своим
// кодом не менялись — поэтому смена типа в той же транзакции обновляет и её. Дата смены не
// позже сегодня, значит тип «на сегодня» всегда равен выбранному.

import type { Request } from 'express';
import { query, withTransaction } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import type { IAccessPointZonePeriod } from '../utils/accessPointZones.js';
import { auditService } from './audit.service.js';
import { sigurService } from './sigur.service.js';
import { getAccessPointCacheEntry, invalidateInternalPointsCache } from './skud-shared.service.js';
import { isRealIsoDate } from './skud-timesheet-detail-export.service.js';
import { currentMonthStartMsk } from './timesheet-export-mode.service.js';
import { kickAccessPointZoneReconcile } from './access-point-zone-reconcile.service.js';

export class AccessPointZoneError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AccessPointZoneError';
    this.status = status;
  }
}

export interface IZoneChangeInput {
  accessPointName: string;
  isInternal: boolean;
  effectiveFrom: string;
}

export interface IZoneChangeResult {
  /** false — история точки уже такая, ничего не записано. */
  changed: boolean;
  reconcileTaskId: number | null;
  periods: IAccessPointZonePeriod[];
}

const formatRu = (iso: string): string => iso.split('-').reverse().join('.');

/** Текст ошибки либо null, если дата допустима. */
export const validateZoneEffectiveDate = (effectiveFrom: string, now: Date = new Date()): string | null => {
  if (!isRealIsoDate(effectiveFrom)) return 'Некорректная дата';
  const monthStart = currentMonthStartMsk(now);
  const today = moscowTodayIso(now);
  if (effectiveFrom < monthStart) {
    return `Тип зоны можно менять не раньше 1-го числа текущего месяца — с ${formatRu(monthStart)}`;
  }
  if (effectiveFrom > today) return `Дата не может быть позже сегодняшней — ${formatRu(today)}`;
  return null;
};

interface IPeriodRow {
  is_internal: boolean;
  effective_from: string;
}

/**
 * История точки после смены типа с даты. Чистая функция — правило «схлопывания» проверяется
 * тестом без БД.
 */
export const applyZoneChange = (before: readonly IPeriodRow[], isInternal: boolean, effectiveFrom: string): {
  after: IPeriodRow[];
  removed: IPeriodRow[];
  inserted: IPeriodRow | null;
} => {
  const sorted = [...before].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const kept = sorted.filter(period => period.effective_from < effectiveFrom);
  const removed = sorted.filter(period => period.effective_from >= effectiveFrom);
  // Тип накануне даты: последняя строка раньше неё; истории нет — точка внешняя.
  const priorIsInternal = kept.length > 0 ? kept[kept.length - 1].is_internal : false;
  const inserted = priorIsInternal === isInternal ? null : { is_internal: isInternal, effective_from: effectiveFrom };
  return { after: inserted ? [...kept, inserted] : kept, removed, inserted };
};

const sameTimeline = (a: readonly IPeriodRow[], b: readonly IPeriodRow[]): boolean =>
  a.length === b.length && a.every((period, index) =>
    period.effective_from === b[index].effective_from && period.is_internal === b[index].is_internal);

/** Точка известна: уже есть история, привязана к объекту либо есть в списке Sigur (источник вкладки). */
const isKnownAccessPoint = async (name: string): Promise<boolean> => {
  const known = await query<{ found: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM skud_access_point_zone_periods WHERE access_point_name = $1)
          OR EXISTS (SELECT 1 FROM skud_object_access_points WHERE btrim(access_point_name) = $1)) AS found`,
    [name],
  );
  if (known[0]?.found) return true;

  for (const key of ['__all__', '__all__:external', '__all__:internal']) {
    if ((getAccessPointCacheEntry(key) ?? []).some(cached => cached.trim() === name)) return true;
  }
  if (await sigurService.isConfigured()) {
    try {
      const points = await sigurService.getAccessPoints() as Array<Record<string, unknown>>;
      if (points.some(point => String(point.name ?? '').trim() === name)) return true;
    } catch (error) {
      console.warn('[access-point-zone] список точек Sigur недоступен:', (error as Error).message);
    }
  }
  // Sigur недоступен — последний источник: по точке уже были проходы в текущем месяце.
  const events = await query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM skud_events
                     WHERE event_date >= $2::date AND btrim(access_point) = $1) AS found`,
    [name, currentMonthStartMsk()],
  );
  return Boolean(events[0]?.found);
};

export async function changeAccessPointZone(
  input: IZoneChangeInput,
  actor: { req: Request; userId: string | null },
): Promise<IZoneChangeResult> {
  // Имя нормализуется ДО блокировки: блокировка и история — по одному и тому же ключу.
  const name = input.accessPointName.trim();
  if (!name) throw new AccessPointZoneError(400, 'Не указана точка доступа');
  const dateError = validateZoneEffectiveDate(input.effectiveFrom);
  if (dateError) throw new AccessPointZoneError(400, dateError);
  if (!(await isKnownAccessPoint(name))) {
    throw new AccessPointZoneError(400, 'Точка доступа не найдена. Нажмите «Обновить» и повторите');
  }

  const today = moscowTodayIso();
  const result = await withTransaction(async client => {
    // Две смены одной точки сразу не должны удалить историю друг друга.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`skud_ap_zone:${name}`]);

    const before = (await client.query<IPeriodRow>(
      `SELECT is_internal, effective_from::text AS effective_from
         FROM skud_access_point_zone_periods
        WHERE access_point_name = $1
        ORDER BY effective_from`,
      [name],
    )).rows;
    const { after, removed, inserted } = applyZoneChange(before, input.isInternal, input.effectiveFrom);
    const toPeriods = (rows: readonly IPeriodRow[]): IAccessPointZonePeriod[] =>
      rows.map(row => ({ access_point_name: name, is_internal: row.is_internal, effective_from: row.effective_from }));

    // Повтор той же смены: история не изменилась — ни записи, ни задачи, ни аудита.
    if (sameTimeline(before, after)) {
      return { changed: false, reconcileTaskId: null, periods: toPeriods(before) };
    }

    await client.query(
      'DELETE FROM skud_access_point_zone_periods WHERE access_point_name = $1 AND effective_from >= $2::date',
      [name, input.effectiveFrom],
    );
    if (inserted) {
      await client.query(
        `INSERT INTO skud_access_point_zone_periods (access_point_name, is_internal, effective_from)
         VALUES ($1, $2, $3::date)`,
        [name, inserted.is_internal, inserted.effective_from],
      );
    }

    // Тип «на сегодня» для экранов портала: внутренняя точка — строка есть, внешняя — строки нет.
    if (input.isInternal) {
      await client.query(
        `INSERT INTO skud_access_point_settings (department_id, access_point_name, is_internal)
         SELECT COALESCE(
                  (SELECT department_id FROM skud_access_point_settings ORDER BY id LIMIT 1),
                  (SELECT id FROM org_departments WHERE parent_id IS NULL ORDER BY created_at, id LIMIT 1)
                ), $1, true
          WHERE NOT EXISTS (
            SELECT 1 FROM skud_access_point_settings WHERE btrim(access_point_name) = $1 AND is_internal = true
          )`,
        [name],
      );
    } else {
      await client.query('DELETE FROM skud_access_point_settings WHERE btrim(access_point_name) = $1', [name]);
    }

    const task = (await client.query<{ id: number }>(
      `INSERT INTO skud_access_point_zone_reconcile (access_point_name, from_date, to_date)
       VALUES ($1, $2::date, $3::date)
       RETURNING id`,
      [name, input.effectiveFrom, today],
    )).rows[0];

    await auditService.logFromRequestWithClient(client, actor.req, actor.userId, 'SKUD_ACCESS_POINT_ZONE_CHANGED', {
      entityType: 'skud_access_point',
      entityId: name,
      details: {
        access_point_name: name,
        is_internal: input.isInternal,
        effective_from: input.effectiveFrom,
        // Смена задним числом удаляет более поздние строки — в аудите вся история до и после.
        timeline_before: before,
        removed_periods: removed,
        timeline_after: after,
        reconcile_task_id: Number(task.id),
      },
    });

    return { changed: true, reconcileTaskId: Number(task.id), periods: toPeriods(after) };
  });

  if (result.changed) {
    invalidateInternalPointsCache();
    // Пересборка сводки и «Дороги» — в фоне: ответ не ждёт тысяч пересчётов.
    kickAccessPointZoneReconcile();
  }
  return result;
}
