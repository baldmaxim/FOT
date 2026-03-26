import { sigurService } from './sigur.service.js';
import { supabase } from '../config/database.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { computeDedupHash } from '../utils/dedup.utils.js';
import { buildInclusiveDateRange } from '../utils/date.utils.js';
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
}

// ─── Чистая функция синхронизации ───

export async function syncEventsLogic(
  organizationId: string,
  startDate: string,
  endDate: string,
  connection?: 'external' | 'internal',
  onProgress?: (data: Record<string, unknown>) => void,
  context?: ISyncContext,
): Promise<ISyncEventsResult> {
  if (!sigurService.isConfigured()) throw new Error('Sigur не настроен');

  const send = onProgress || (() => {});
  const days = buildInclusiveDateRange(startDate, endDate);

  send({ type: 'events_start', totalDays: days.length });

  // 1. Загружаем сотрудников
  const { data: employeesData } = await supabase
    .from('employees')
    .select('id, organization_id, full_name, sigur_employee_id')
    .eq('is_archived', false);

  const employeeByNameOrg = new Map<string, { id: number; organization_id: string }>();
  const sigurIdMap = new Map<number, { id: number; organization_id: string }>();
  for (const emp of employeesData || []) {
    const name = normalizePersonName(emp.full_name || '');
    const empRef = { id: emp.id, organization_id: emp.organization_id };
    const key = `${name}|${emp.organization_id}`;
    if (!employeeByNameOrg.has(key)) employeeByNameOrg.set(key, empRef);
    if (emp.sigur_employee_id != null) sigurIdMap.set(emp.sigur_employee_id, empRef);
  }

  // 2. Whitelist
  const whitelist = await getWhitelistedDepartmentIdsCached(organizationId, context);
  let allowedNames: Set<string> | null = null;
  let allowedSigurIds: Set<number> | null = null;

  if (whitelist) {
    const dbWhitelistSets = await getWhitelistedDbEmployeeSets(organizationId, whitelist);
    if (dbWhitelistSets && (dbWhitelistSets.allowedNames.size > 0 || dbWhitelistSets.allowedSigurIds.size > 0)) {
      allowedNames = dbWhitelistSets.allowedNames;
      allowedSigurIds = dbWhitelistSets.allowedSigurIds;
      console.log(
        `[syncEvents] whitelist resolved from DB employees: ${allowedNames.size} names, ${allowedSigurIds.size} sigur ids`,
      );
    } else {
      console.log('[syncEvents] whitelist DB cache is empty, falling back to Sigur employees');
      let whitelistCache = context?.whitelistedSigurEmployees || null;
      if (!whitelistCache) {
        const sigurEmployees = await getWhitelistedSigurEmployees(organizationId, connection, context, send);
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
      const { data: hashPage } = await supabase
        .from('skud_events')
        .select('dedup_hash')
        .gte('event_date', days[0])
        .lte('event_date', days[days.length - 1])
        .not('dedup_hash', 'is', null)
        .range(hashOffset, hashOffset + HASH_PAGE - 1);
      if (!hashPage || hashPage.length === 0) break;
      for (const evt of hashPage) {
        if (evt.dedup_hash) existingSet.add(evt.dedup_hash);
      }
      if (hashPage.length < HASH_PAGE) break;
      hashOffset += HASH_PAGE;
    }
    console.log(`[syncEvents] preloaded ${existingSet.size} existing hashes`);
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
    const rawEvents = await sigurService.getEvents(dayStart, dayEnd, connection, 'PASS_DETECTED', { pageSize: 3000 });
    totalSigur += rawEvents.length;

    if (rawEvents.length > 3000) {
      console.log(`[syncEvents] day ${day}: ${rawEvents.length} events (pagination worked, ${Math.ceil(rawEvents.length / 3000)} pages)`);
      paginatedDays++;
    }

    if (rawEvents.length === 0) continue;

    const dayInserts: Record<string, unknown>[] = [];

    for (const raw of rawEvents) {
      const mapped = mapSigurEvent(raw as Record<string, unknown>);
      if (!mapped) {
        totalNoName++;
        if (noNameSamples.length < 3) {
          const r = raw as Record<string, unknown>;
          noNameSamples.push({ eventType: r.eventType, timestamp: r.timestamp, keys: Object.keys(r) });
        }
        continue;
      }

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
        mapped.accessPoint, mapped.direction,
      );
      if (existingSet.has(dedupHash)) { totalSkipped++; continue; }
      existingSet.add(dedupHash);

      const nameKey = normalizePersonName(personName);
      let emp = mapped.employeeId != null ? sigurIdMap.get(mapped.employeeId) : undefined;
      if (emp) {
        matchedBySigurId++;
      } else {
        emp = employeeByNameOrg.get(`${nameKey}|${organizationId}`);
        if (emp) matchedByName++;
      }
      if (emp) {
        matchedEvents++;
      } else {
        unmatchedEvents++;
        unmatchedNames.set(personName, (unmatchedNames.get(personName) || 0) + 1);
      }
      const orgId = emp?.organization_id || organizationId;
      if (!orgId) { totalNoOrg++; continue; }

      dayInserts.push({
        organization_id: orgId,
        physical_person: personName,
        card_number: mapped.cardNumber || null,
        event_date: mapped.eventDate,
        event_time: mapped.eventTime,
        access_point: mapped.accessPoint,
        direction: mapped.direction,
        employee_id: emp?.id || null,
        dedup_hash: dedupHash,
      });

      if (emp) summariesToUpdate.add(`${emp.id}:${orgId}:${mapped.eventDate}`);
    }

    // Вставка батчами с паузами (защита от 502 на облачном Supabase)
    for (let i = 0; i < dayInserts.length; i += BATCH_SIZE) {
      const batch = dayInserts.slice(i, i + BATCH_SIZE);
      const { error: insertError } = await supabase.from('skud_events').upsert(batch, { onConflict: 'dedup_hash', ignoreDuplicates: true });
      if (insertError) {
        errors.push(`[${day}] ${insertError.message}`);
      } else {
        totalInserted += batch.length;
      }
      if (i + BATCH_SIZE < dayInserts.length) await sleep(BATCH_DELAY_MS);
    }

    // Детальный SSE-отчёт по дню
    send({
      type: 'events_day_done',
      day,
      sigurCount: rawEvents.length,
      insertedCount: dayInserts.length,
    });

    if (dayIdx < days.length - 1) await sleep(DAY_DELAY_MS);
  }

  // Пересчёт сводок (батчами по 200 для защиты от 502)
  if (summariesToUpdate.size > 0) {
    send({ type: 'events_summaries', count: summariesToUpdate.size });
    const allPairs = [...summariesToUpdate].map(key => {
      const [empId, orgId, date] = key.split(':');
      return { org_id: orgId, emp_id: parseInt(empId, 10), date };
    });
    const SUMMARY_BATCH = 200;
    for (let i = 0; i < allPairs.length; i += SUMMARY_BATCH) {
      const chunk = allPairs.slice(i, i + SUMMARY_BATCH);
      await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: chunk });
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

  console.log(`[syncEvents] done: ${totalInserted} imported, ${totalSkipped} skipped, ${totalFilteredDept} filtered`);
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
  };
}
