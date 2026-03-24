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
    const name = (emp.full_name || '').toLowerCase().trim();
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

  // ─── Параллельная обработка дней (по CONCURRENCY за раз) ───
  const CONCURRENCY = 5;
  const BATCH_SIZE = 500;

  for (let chunkStart = 0; chunkStart < days.length; chunkStart += CONCURRENCY) {
    const chunk = days.slice(chunkStart, chunkStart + CONCURRENCY);

    const chunkEnd = Math.min(chunkStart + CONCURRENCY, days.length);
    const donePercent = Math.round((chunkStart / days.length) * 100);
    send({
      type: 'events_day',
      day: chunk[0],
      dayIndex: chunkStart,
      totalDays: days.length,
      percent: donePercent,
      message: `${chunk[0]} .. ${chunk[chunk.length - 1]} (${donePercent}%, ${chunkStart}/${days.length})`,
    });

    // Параллельно запрашиваем события из Sigur для всех дней в chunk
    const dayResults = await Promise.all(
      chunk.map(async (day) => {
        const dayStart = `${day}T00:00:00`;
        const dayEnd = `${day}T23:59:59`;
        const rawEvents = await sigurService.getEvents(dayStart, dayEnd, connection, 'PASS_DETECTED', { pageSize: 3000 });
        send({
          type: 'events_day',
          day,
          dayIndex: chunkStart + chunk.indexOf(day),
          totalDays: days.length,
          percent: Math.round((chunkStart + chunk.indexOf(day) + 1) / days.length * 100),
        });
        return { day, rawEvents };
      }),
    );

    // Обрабатываем результаты и собираем вставки
    const allInserts: Record<string, unknown>[] = [];

    for (const { rawEvents } of dayResults) {
      totalSigur += rawEvents.length;
      if (rawEvents.length === 0) continue;

      for (const raw of rawEvents) {
        const mapped = mapSigurEvent(raw as Record<string, unknown>);
        if (!mapped) { totalNoName++; continue; }

        if (allowedNames) {
          const nameKey = mapped.physicalPerson.toLowerCase().trim();
          const sigurEmpId = mapped.employeeId;
          if (!allowedNames.has(nameKey) && !(sigurEmpId && allowedSigurIds?.has(sigurEmpId))) {
            totalFilteredDept++;
            filteredNames.set(mapped.physicalPerson, (filteredNames.get(mapped.physicalPerson) || 0) + 1);
            continue;
          }
        }

        const dedupHash = computeDedupHash(
          mapped.physicalPerson, mapped.eventDate, mapped.eventTime,
          mapped.accessPoint, mapped.direction,
        );
        if (existingSet.has(dedupHash)) { totalSkipped++; continue; }
        existingSet.add(dedupHash);

        const nameKey = mapped.physicalPerson.toLowerCase().trim();
        let emp = mapped.employeeId != null ? sigurIdMap.get(mapped.employeeId) : undefined;
        if (!emp) emp = employeeByNameOrg.get(`${nameKey}|${organizationId}`);
        if (!emp) {
          unmatchedNames.set(mapped.physicalPerson, (unmatchedNames.get(mapped.physicalPerson) || 0) + 1);
        }
        const orgId = emp?.organization_id || organizationId;
        if (!orgId) { totalNoOrg++; continue; }

        allInserts.push({
          organization_id: orgId,
          physical_person: mapped.physicalPerson,
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
    }

    // Параллельная вставка батчей
    if (allInserts.length > 0) {
      const batches: Record<string, unknown>[][] = [];
      for (let i = 0; i < allInserts.length; i += BATCH_SIZE) {
        batches.push(allInserts.slice(i, i + BATCH_SIZE));
      }
      const results = await Promise.all(
        batches.map(batch =>
          supabase.from('skud_events').upsert(batch, { onConflict: 'dedup_hash', ignoreDuplicates: true }),
        ),
      );
      for (let i = 0; i < results.length; i++) {
        if (results[i].error) {
          errors.push(`[${chunk[0]}..] ${results[i].error!.message}`);
        } else {
          totalInserted += batches[i].length;
        }
      }
    }
  }

  // Пересчёт сводок
  if (summariesToUpdate.size > 0) {
    send({ type: 'events_summaries', count: summariesToUpdate.size });
    const pairs = [...summariesToUpdate].map(key => {
      const [empId, orgId, date] = key.split(':');
      return { org_id: orgId, emp_id: parseInt(empId, 10), date };
    });
    await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
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
  };
}
