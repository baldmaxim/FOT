import { sigurService } from './sigur.service.js';
import { query, execute } from '../config/postgres.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { computeDedupHash, computeFailureDedupHash } from '../utils/dedup.utils.js';
import { buildInclusiveDateRange, buildMoscowEventTimestamp } from '../utils/date.utils.js';
import {
  buildWhitelistedEmployeesCache,
  getWhitelistedDbEmployeeSets,
  getWhitelistedDepartmentIdsCached,
  getWhitelistedSigurEmployees,
  normalizePersonName,
  type ISyncContext,
} from './sigur-sync-shared.js';

// ─── Типы результатов ───

export interface ISyncEventsResult {
  sigurTotal: number;
  imported: number;
  skipped: number;
  droppedNoName: number;
  droppedNoOrg: number;
  filteredByDept: number;
  unmatchedEmployees: number;
  filteredEmployeeNames: string[];
  matched: number;
  errors: string[];
  // Расширенная диагностика (optional, обратно совместимо)
  matchedEvents?: number;
  unmatchedEvents?: number;
  /** @deprecated — пагинация работает, усечение невозможно. Используйте paginatedDays. */
  truncatedDays?: number;
  paginatedDays?: number;
  noNameSamples?: unknown[];
  matchedBySigurId?: number;
  matchedByName?: number;
  // Ошибочные события Sigur (PASS_DENY и т.п.) — отдельная таблица skud_event_failures.
  failuresFetched?: number;
  failuresImported?: number;
  failuresSkipped?: number;
  failuresByType?: Record<string, number>;
}

// ─── Чистая функция синхронизации ───

export async function syncEventsLogic(
  startDate: string,
  endDate: string,
  connection?: 'external' | 'internal',
  onProgress?: (data: Record<string, unknown>) => void,
  context?: ISyncContext,
): Promise<ISyncEventsResult> {
  if (!(await sigurService.isConfigured())) throw new Error('Sigur не настроен');

  const send = onProgress || (() => {});
  const days = buildInclusiveDateRange(startDate, endDate);

  send({ type: 'events_start', totalDays: days.length });

  // 1. Загружаем сотрудников
  send({ type: 'events_preparing', phase: 'db_employees' });
  const employeesData = await query<{
    id: number;
    full_name: string | null;
    sigur_employee_id: number | null;
  }>(
    'SELECT id, full_name, sigur_employee_id FROM employees WHERE is_archived = false',
  );

  const employeeByName = new Map<string, { id: number }>();
  const sigurIdMap = new Map<number, { id: number }>();
  for (const emp of employeesData || []) {
    const name = normalizePersonName(emp.full_name || '');
    const empRef = { id: emp.id };
    if (!employeeByName.has(name)) employeeByName.set(name, empRef);
    if (emp.sigur_employee_id != null) sigurIdMap.set(emp.sigur_employee_id, empRef);
  }

  // 2. Whitelist
  send({ type: 'events_preparing', phase: 'whitelist_db_cache' });
  const whitelist = await getWhitelistedDepartmentIdsCached(connection, context);
  let allowedNames: Set<string> | null = null;
  let allowedSigurIds: Set<number> | null = null;

  if (whitelist) {
    const dbWhitelistSets = await getWhitelistedDbEmployeeSets(whitelist);
    if (dbWhitelistSets && (dbWhitelistSets.allowedNames.size > 0 || dbWhitelistSets.allowedSigurIds.size > 0)) {
      allowedNames = dbWhitelistSets.allowedNames;
      allowedSigurIds = dbWhitelistSets.allowedSigurIds;
      console.log(
        `[syncEvents] whitelist resolved from DB employees: ${allowedNames.size} names, ${allowedSigurIds.size} sigur ids`,
      );
    } else {
      console.log('[syncEvents] whitelist DB cache is empty, falling back to Sigur employees');
      send({ type: 'events_preparing', phase: 'sigur_employees' });
      let whitelistCache = context?.whitelistedSigurEmployees || null;
      if (!whitelistCache) {
        const sigurEmployees = await getWhitelistedSigurEmployees(connection, context, send);
        whitelistCache = buildWhitelistedEmployeesCache(sigurEmployees);
        if (context) {
          context.whitelistedSigurEmployees = whitelistCache;
        }
      }
      allowedNames = whitelistCache.allowedNames;
      allowedSigurIds = whitelistCache.allowedSigurIds;
    }
  }

  const errors: string[] = [];
  let totalSigur = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalNoName = 0;
  let totalNoOrg = 0;
  let totalFilteredDept = 0;
  let paginatedDays = 0;
  let matchedBySigurId = 0;
  let matchedByName = 0;
  let matchedEvents = 0;
  let unmatchedEvents = 0;
  let totalFailuresFetched = 0;
  let totalFailuresInserted = 0;
  let totalFailuresSkipped = 0;
  const failuresByType = new Map<string, number>();
  const noNameSamples: unknown[] = [];
  const filteredNames = new Map<string, number>();
  const unmatchedNames = new Map<string, number>();
  const summariesToUpdate = new Set<string>();

  // ─── Предзагрузка existing hashes за весь период одним запросом ───
  send({ type: 'events_loading_hashes' });
  const existingSet = new Set<string>();
  {
    const HASH_PAGE = 10000;
    let hashOffset = 0;
    while (true) {
      const hashPage = await query<{ dedup_hash: string | null }>(
        `SELECT dedup_hash FROM skud_events
         WHERE event_date >= $1 AND event_date <= $2 AND dedup_hash IS NOT NULL
         LIMIT ${HASH_PAGE} OFFSET ${hashOffset}`,
        [days[0], days[days.length - 1]],
      );
      if (!hashPage || hashPage.length === 0) break;
      for (const evt of hashPage) {
        if (evt.dedup_hash) existingSet.add(evt.dedup_hash);
      }
      if (hashPage.length < HASH_PAGE) break;
      hashOffset += HASH_PAGE;
    }
    console.log(`[syncEvents] preloaded ${existingSet.size} existing hashes`);
  }

  // ─── Предзагрузка хэшей failures (skud_event_failures) ───
  const existingFailureSet = new Set<string>();
  {
    const HASH_PAGE = 10000;
    let hashOffset = 0;
    while (true) {
      const hashPage = await query<{ dedup_hash: string | null }>(
        `SELECT dedup_hash FROM skud_event_failures
         WHERE event_date >= $1 AND event_date <= $2 AND dedup_hash IS NOT NULL
         LIMIT ${HASH_PAGE} OFFSET ${hashOffset}`,
        [days[0], days[days.length - 1]],
      );
      if (!hashPage || hashPage.length === 0) break;
      for (const evt of hashPage) {
        if (evt.dedup_hash) existingFailureSet.add(evt.dedup_hash);
      }
      if (hashPage.length < HASH_PAGE) break;
      hashOffset += HASH_PAGE;
    }
    console.log(`[syncEvents] preloaded ${existingFailureSet.size} existing failure hashes`);
  }

  // ─── Последовательная обработка с прогрессом на каждый день ───
  const BATCH_SIZE = 300;
  const BATCH_DELAY_MS = 200;
  const DAY_DELAY_MS = 300;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const day = days[dayIdx];
    const percent = Math.round((dayIdx / days.length) * 100);

    send({
      type: 'events_day',
      day,
      dayIndex: dayIdx,
      totalDays: days.length,
      percent,
    });

    const dayStart = `${day}T00:00:00`;
    const dayEnd = `${day}T23:59:59`;
    const { pass: rawEvents, failures: rawFailures } = await sigurService.getEventsWithFailures(
      dayStart,
      dayEnd,
      connection,
      { pageSize: 3000 },
    );
    totalSigur += rawEvents.length;
    totalFailuresFetched += rawFailures.length;

    if (rawEvents.length > 3000) {
      console.log(`[syncEvents] day ${day}: ${rawEvents.length} events (pagination worked, ${Math.ceil(rawEvents.length / 3000)} pages)`);
      paginatedDays++;
    }

    // Почасовая разбивка для диагностики
    if (rawEvents.length > 0) {
      const hourly: Record<string, number> = {};
      for (const evt of rawEvents) {
        const ts = (evt as Record<string, any>).timestamp as string | undefined;
        if (ts) {
          const hm = ts.match(/T(\d{2}):/);
          if (hm) hourly[hm[1]] = (hourly[hm[1]] || 0) + 1;
        }
      }
      const firstTs = (rawEvents[0] as Record<string, any>).timestamp;
      const lastTs = (rawEvents[rawEvents.length - 1] as Record<string, any>).timestamp;
      console.log(`[syncEvents] day=${day} events=${rawEvents.length} first=${firstTs} last=${lastTs} hourly=${JSON.stringify(hourly)}`);
    }

    if (rawEvents.length === 0 && rawFailures.length === 0) continue;

    const dayInserts: Record<string, unknown>[] = [];
    const dayFailureInserts: Record<string, unknown>[] = [];

    for (const raw of rawEvents) {
      const mapped = mapSigurEvent(raw as Record<string, unknown>);
      if (!mapped) {
        totalNoName++;
        if (noNameSamples.length < 10) {
          const r = raw as Record<string, unknown>;
          const ad = r.additionalData as Record<string, any> | undefined;
          noNameSamples.push({
            eventType: r.eventType,
            timestamp: r.timestamp,
            accessObjectId: (r.data as Record<string, any>)?.employeeId,
            hasName: !!ad?.accessObject?.data?.name,
            hasCard: !!(r.data as Record<string, any>)?.cardKey,
            keys: Object.keys(r),
          });
        }
        continue;
      }

      // На pass-ветке всегда `kind: 'pass'`. Failure-ветка идёт отдельным циклом ниже.
      if (mapped.kind !== 'pass') continue;

      const personName = mapped.physicalPerson;
      if (!personName) {
        totalNoName++;
        continue;
      }

      if (allowedNames) {
        const nameKey = normalizePersonName(personName);
        const sigurEmpId = mapped.employeeId;
        if (!allowedNames.has(nameKey) && !(sigurEmpId && allowedSigurIds?.has(sigurEmpId))) {
          totalFilteredDept++;
          filteredNames.set(personName, (filteredNames.get(personName) || 0) + 1);
          continue;
        }
      }

      const dedupHash = computeDedupHash(
        personName, mapped.eventDate, mapped.eventTime,
        mapped.accessPoint, mapped.direction, mapped.rawId,
      );
      if (existingSet.has(dedupHash)) { totalSkipped++; continue; }
      existingSet.add(dedupHash);

      const nameKey = normalizePersonName(personName);
      let emp = mapped.employeeId != null ? sigurIdMap.get(mapped.employeeId) : undefined;
      if (emp) {
        matchedBySigurId++;
      } else {
        emp = employeeByName.get(nameKey);
        if (emp) matchedByName++;
      }
      if (emp) {
        matchedEvents++;
      } else {
        unmatchedEvents++;
        unmatchedNames.set(personName, (unmatchedNames.get(personName) || 0) + 1);
      }

      dayInserts.push({
        physical_person: personName,
        card_number: mapped.cardNumber || null,
        event_date: mapped.eventDate,
        event_time: mapped.eventTime,
        event_at: buildMoscowEventTimestamp(mapped.eventDate, mapped.eventTime),
        access_point: mapped.accessPoint,
        direction: mapped.direction,
        employee_id: emp?.id || null,
        dedup_hash: dedupHash,
      });

      if (emp) summariesToUpdate.add(`${emp.id}:${mapped.eventDate}`);
    }

    // ─── Обработка ошибочных событий (PASS_DENY и т.п.) ───
    for (const raw of rawFailures) {
      const mapped = mapSigurEvent(raw as Record<string, unknown>);
      if (!mapped || mapped.kind !== 'failure') continue;

      // Whitelist: если у события есть имя/sigurId, режем чужие отделы. Если нет
      // (карта не распознана) — пропускаем сквозь whitelist, событие может быть
      // важным с точки зрения наблюдения.
      if (allowedNames && mapped.physicalPerson) {
        const nameKey = normalizePersonName(mapped.physicalPerson);
        const sigurEmpId = mapped.employeeId;
        if (!allowedNames.has(nameKey) && !(sigurEmpId && allowedSigurIds?.has(sigurEmpId))) {
          continue;
        }
      }

      const failureHash = computeFailureDedupHash(
        mapped.physicalPerson,
        mapped.cardNumber,
        mapped.eventDate,
        mapped.eventTime,
        mapped.accessPoint,
        mapped.direction,
        mapped.failureType,
        mapped.rawId,
      );
      if (existingFailureSet.has(failureHash)) { totalFailuresSkipped++; continue; }
      existingFailureSet.add(failureHash);

      // Match employee — best-effort, по имени или sigur id (если они есть).
      let failureEmp: { id: number } | undefined;
      if (mapped.physicalPerson) {
        const nameKey = normalizePersonName(mapped.physicalPerson);
        failureEmp = mapped.employeeId != null ? sigurIdMap.get(mapped.employeeId) : undefined;
        if (!failureEmp) failureEmp = employeeByName.get(nameKey);
      } else if (mapped.employeeId != null) {
        failureEmp = sigurIdMap.get(mapped.employeeId);
      }

      failuresByType.set(mapped.failureType, (failuresByType.get(mapped.failureType) || 0) + 1);

      dayFailureInserts.push({
        physical_person: mapped.physicalPerson,
        card_number: mapped.cardNumber,
        event_date: mapped.eventDate,
        event_time: mapped.eventTime,
        event_at: buildMoscowEventTimestamp(mapped.eventDate, mapped.eventTime),
        access_point: mapped.accessPoint,
        direction: mapped.direction,
        employee_id: failureEmp?.id || null,
        failure_type: mapped.failureType,
        failure_type_id: mapped.failureTypeId,
        reason: mapped.reason,
        raw_event_id: mapped.rawId,
        dedup_hash: failureHash,
      });
    }

    // Вставка батчами с паузами
    const EVENT_COLUMNS = [
      'physical_person', 'card_number', 'event_date', 'event_time',
      'event_at', 'access_point', 'direction', 'employee_id', 'dedup_hash',
    ];
    for (let i = 0; i < dayInserts.length; i += BATCH_SIZE) {
      const batch = dayInserts.slice(i, i + BATCH_SIZE);
      try {
        const params: unknown[] = [];
        const placeholders: string[] = [];
        for (const row of batch) {
          const group: string[] = [];
          for (const col of EVENT_COLUMNS) {
            params.push(row[col]);
            group.push(`$${params.length}`);
          }
          placeholders.push(`(${group.join(', ')})`);
        }
        await execute(
          `INSERT INTO skud_events (${EVENT_COLUMNS.join(', ')})
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (dedup_hash, event_date) DO NOTHING`,
          params,
        );
        totalInserted += batch.length;
      } catch (insertError) {
        errors.push(`[${day}] ${(insertError as Error).message}`);
      }
      if (i + BATCH_SIZE < dayInserts.length) await sleep(BATCH_DELAY_MS);
    }

    // Вставка ошибочных событий — отдельной таблицей, без recalc-RPC.
    const FAILURE_COLUMNS = [
      'physical_person', 'card_number', 'event_date', 'event_time',
      'event_at', 'access_point', 'direction', 'employee_id',
      'failure_type', 'failure_type_id', 'reason', 'raw_event_id', 'dedup_hash',
    ];
    let dayFailuresInserted = 0;
    for (let i = 0; i < dayFailureInserts.length; i += BATCH_SIZE) {
      const batch = dayFailureInserts.slice(i, i + BATCH_SIZE);
      try {
        const params: unknown[] = [];
        const placeholders: string[] = [];
        for (const row of batch) {
          const group: string[] = [];
          for (const col of FAILURE_COLUMNS) {
            params.push(row[col]);
            group.push(`$${params.length}`);
          }
          placeholders.push(`(${group.join(', ')})`);
        }
        await execute(
          `INSERT INTO skud_event_failures (${FAILURE_COLUMNS.join(', ')})
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (dedup_hash, event_date) DO NOTHING`,
          params,
        );
        dayFailuresInserted += batch.length;
      } catch (insertError) {
        errors.push(`[${day}][failures] ${(insertError as Error).message}`);
      }
      if (i + BATCH_SIZE < dayFailureInserts.length) await sleep(BATCH_DELAY_MS);
    }
    totalFailuresInserted += dayFailuresInserted;

    // Детальный SSE-отчёт по дню
    send({
      type: 'events_day_done',
      day,
      sigurCount: rawEvents.length,
      insertedCount: dayInserts.length,
      failuresFetched: rawFailures.length,
      failuresInserted: dayFailuresInserted,
    });

    if (dayIdx < days.length - 1) await sleep(DAY_DELAY_MS);
  }

  // Пересчёт сводок (батчами по 200 для защиты от 502)
  if (summariesToUpdate.size > 0) {
    send({ type: 'events_summaries', count: summariesToUpdate.size });
    const allPairs = [...summariesToUpdate].map(key => {
      const [empId, date] = key.split(':');
      return { emp_id: parseInt(empId, 10), date };
    });
    const SUMMARY_BATCH = 200;
    for (let i = 0; i < allPairs.length; i += SUMMARY_BATCH) {
      const chunk = allPairs.slice(i, i + SUMMARY_BATCH);
      await query(
        'SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)',
        [JSON.stringify(chunk)],
      );
      if (i + SUMMARY_BATCH < allPairs.length) await sleep(BATCH_DELAY_MS);
    }
  }

  if (filteredNames.size > 0) {
    const top = [...filteredNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([n, c]) => `${n} (${c})`).join(', ');
    console.warn(`[syncEvents] отфильтрованы whitelist (top 10): ${top}`);
  }
  if (unmatchedNames.size > 0) {
    const top = [...unmatchedNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([n, c]) => `${n} (${c})`).join(', ');
    console.warn(`[syncEvents] не сопоставлены с сотрудниками (top 10): ${top}`);
  }

  console.log(
    `[syncEvents] done: ${totalInserted} imported, ${totalSkipped} skipped, ${totalFilteredDept} filtered, ` +
    `${totalFailuresInserted} failures imported (${totalFailuresSkipped} skipped) of ${totalFailuresFetched} fetched`,
  );
  return {
    sigurTotal: totalSigur,
    imported: totalInserted,
    skipped: totalSkipped,
    droppedNoName: totalNoName,
    droppedNoOrg: totalNoOrg,
    filteredByDept: totalFilteredDept,
    unmatchedEmployees: unmatchedNames.size,
    filteredEmployeeNames: [...filteredNames.keys()].slice(0, 20),
    matched: summariesToUpdate.size,
    errors,
    // Расширенная диагностика
    matchedEvents,
    unmatchedEvents,
    truncatedDays: 0,
    paginatedDays,
    noNameSamples: noNameSamples.length > 0 ? noNameSamples : undefined,
    matchedBySigurId,
    matchedByName,
    failuresFetched: totalFailuresFetched,
    failuresImported: totalFailuresInserted,
    failuresSkipped: totalFailuresSkipped,
    failuresByType: Object.fromEntries(failuresByType),
  };
}
