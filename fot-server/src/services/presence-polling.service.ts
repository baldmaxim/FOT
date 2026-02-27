import { sigurService } from './sigur.service.js';
import { supabase } from '../config/database.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { computeDedupHash } from '../utils/dedup.utils.js';

const POLL_INTERVAL = 60_000; // 1 минута
const EVENT_WINDOW_MINUTES = 5; // окно опроса — последние 5 минут
const EMPLOYEE_CACHE_TTL = 5 * 60_000; // 5 минут
const BATCH_SIZE = 500;

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let fullDaySynced = false;
let lastSyncedDay = '';

// Кэш сотрудников: по имени (name|org_id) и по sigur_employee_id
let employeeCache: {
  byNameOrg: Map<string, { id: number; organization_id: string }>;
  bySigurId: Map<number, { id: number; organization_id: string }>;
  fetchedAt: number;
} | null = null;

interface EmployeeMaps {
  byNameOrg: Map<string, { id: number; organization_id: string }>;
  bySigurId: Map<number, { id: number; organization_id: string }>;
}

async function getEmployeeMaps(): Promise<EmployeeMaps> {
  if (employeeCache && (Date.now() - employeeCache.fetchedAt) < EMPLOYEE_CACHE_TTL) {
    return employeeCache;
  }

  const { data } = await supabase
    .from('employees')
    .select('id, organization_id, full_name, sigur_employee_id')
    .eq('is_archived', false);

  const byNameOrg = new Map<string, { id: number; organization_id: string }>();
  const bySigurId = new Map<number, { id: number; organization_id: string }>();
  for (const emp of data || []) {
    const name = (emp.full_name || '').toLowerCase().trim();
    const ref = { id: emp.id, organization_id: emp.organization_id };
    // Ключ: name|org_id — исключает конфликт при одинаковых ФИО в разных org
    const key = `${name}|${emp.organization_id}`;
    if (!byNameOrg.has(key)) byNameOrg.set(key, ref);
    if (emp.sigur_employee_id != null) bySigurId.set(emp.sigur_employee_id, ref);
  }

  employeeCache = { byNameOrg, bySigurId, fetchedAt: Date.now() };
  console.log(`[presence-polling] cached ${byNameOrg.size} employees`);
  return employeeCache;
}

async function getFallbackOrgId(): Promise<string | null> {
  const { data } = await supabase.from('organizations').select('id').limit(1);
  return data?.[0]?.id || null;
}

async function pollEvents(): Promise<void> {
  try {
    if (!sigurService.isConfigured()) return;

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    // Сброс при смене дня (если сервер работает через полночь)
    if (lastSyncedDay !== todayStr) {
      fullDaySynced = false;
      lastSyncedDay = todayStr;
    }

    // При первом запуске — полный fetch за весь день, потом только последние 5 минут
    let startTime: string;
    const endTime = `${todayStr}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    if (!fullDaySynced) {
      startTime = `${todayStr}T00:00:00`;
      fullDaySynced = true;
      console.log('[presence-polling] full-day sync for', todayStr);
    } else {
      const windowStart = new Date(now.getTime() - EVENT_WINDOW_MINUTES * 60_000);
      startTime = `${todayStr}T${pad(windowStart.getHours())}:${pad(windowStart.getMinutes())}:${pad(windowStart.getSeconds())}`;
    }

    const rawEvents = await sigurService.getEvents(startTime, endTime, undefined, 'PASS_DETECTED');
    if (rawEvents.length === 0) return;

    const { byNameOrg, bySigurId } = await getEmployeeMaps();
    const fallbackOrgId = await getFallbackOrgId();

    // Дедупликация: загружаем существующие хэши за сегодня
    const { data: existingEvents } = await supabase
      .from('skud_events')
      .select('dedup_hash')
      .eq('event_date', todayStr)
      .not('dedup_hash', 'is', null);

    const existingSet = new Set<string>();
    for (const evt of existingEvents || []) {
      if (evt.dedup_hash) existingSet.add(evt.dedup_hash);
    }

    const inserts: {
      organization_id: string;
      physical_person: string;
      card_number: string | null;
      event_date: string;
      event_time: string;
      access_point: string | null;
      direction: 'entry' | 'exit' | null;
      employee_id: number | null;
      dedup_hash: string;
    }[] = [];
    const summariesToUpdate = new Set<string>();

    for (const raw of rawEvents) {
      const mapped = mapSigurEvent(raw as Record<string, unknown>);
      if (!mapped) continue;

      const dedupHash = computeDedupHash(
        mapped.physicalPerson, mapped.eventDate, mapped.eventTime,
        mapped.accessPoint, mapped.direction,
      );
      if (existingSet.has(dedupHash)) continue;
      existingSet.add(dedupHash);

      // Маппинг: sigur_employee_id → name|org (учитывает дубли ФИО)
      const nameKey = mapped.physicalPerson.toLowerCase().trim();
      let emp: { id: number; organization_id: string } | undefined;
      if (mapped.employeeId != null) {
        emp = bySigurId.get(mapped.employeeId);
      }
      if (!emp && fallbackOrgId) {
        emp = byNameOrg.get(`${nameKey}|${fallbackOrgId}`);
      }
      // Пропускаем события сотрудников, которых нет в БД (не синхронизированы)
      if (!emp) continue;
      const orgId = emp.organization_id;

      inserts.push({
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

      if (emp) {
        summariesToUpdate.add(`${emp.id}:${orgId}:${mapped.eventDate}`);
      }
    }

    // Вставка батчами
    let totalInserted = 0;
    for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
      const batch = inserts.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from('skud_events').upsert(batch, { onConflict: 'dedup_hash', ignoreDuplicates: true });
      if (error) {
        console.error('[presence-polling] insert error:', error.message);
      } else {
        totalInserted += batch.length;
      }
    }

    // Пересчёт сводок (пакетный RPC)
    if (summariesToUpdate.size > 0) {
      const pairs = [...summariesToUpdate].map(key => {
        const [empId, orgId, date] = key.split(':');
        return { org_id: orgId, emp_id: parseInt(empId, 10), date };
      });
      await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
    }

    if (totalInserted > 0) {
      console.log(`[presence-polling] inserted ${totalInserted} events, recalculated ${summariesToUpdate.size} summaries`);
    }
  } catch (error) {
    console.error('[presence-polling] error:', (error as Error).message);
  }
}

export function startPresencePolling(): void {
  if (pollingTimer) return;
  if (!sigurService.isConfigured()) {
    console.log('[presence-polling] Sigur not configured, skipping');
    return;
  }
  console.log('[presence-polling] started (interval: 60s)');
  // Первый опрос через 10 сек после старта (дать время на warmup кэша)
  setTimeout(() => pollEvents(), 10_000);
  pollingTimer = setInterval(pollEvents, POLL_INTERVAL);
}

export function stopPresencePolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    console.log('[presence-polling] stopped');
  }
}
