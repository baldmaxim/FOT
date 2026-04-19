/**
 * Фоновый backfill: привязка employee_id к unmatched skud_events по ФИО.
 * Вызывается после каждого цикла поллинга, а НЕ на read-path.
 *
 * Окно 7 дней назад: ловит события, которые могли попасть в БД без привязки
 * (кэш ещё не прогрет, structure-sync ещё не прошёл, Sigur был в outage).
 * Batch 500 событий за цикл — rolling catch-up, не перегружает БД одним тиком.
 */
import { supabase } from '../config/database.js';
import { formatDateToISO } from '../utils/date.utils.js';
import { normalizePersonName } from './sigur-sync-shared.js';

const BACKFILL_WINDOW_DAYS = 7;
const BACKFILL_BATCH_LIMIT = 500;

export async function backfillUnmatchedEvents(): Promise<void> {
  const today = formatDateToISO(new Date());
  const fromDate = formatDateToISO(
    new Date(Date.now() - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000),
  );

  // Все незаархивированные сотрудники (не фильтруем по employment_status —
  // новые хайры могут быть в 'pending', уволенные без архивирования — валидны
  // для их исторических событий до увольнения).
  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name')
    .eq('is_archived', false);

  if (!employees || employees.length === 0) return;

  // Карта ФИО → employee.id с защитой от коллизий ФИО:
  // если имя встречается у нескольких сотрудников, не привязываем автоматически
  // (как byUniqueName в presence-polling).
  const nameCounts = new Map<string, number>();
  const nameToEmpId = new Map<string, number>();
  for (const emp of employees) {
    const key = normalizePersonName(emp.full_name || '');
    if (!key) continue;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    nameToEmpId.set(key, emp.id);
  }
  for (const [name, count] of nameCounts) {
    if (count > 1) nameToEmpId.delete(name);
  }

  // Выбираем старые unmatched события первыми — чтобы не копились хвосты.
  const { data: unmatchedEvents } = await supabase
    .from('skud_events')
    .select('id, physical_person, event_date')
    .gte('event_date', fromDate)
    .lte('event_date', today)
    .is('employee_id', null)
    .order('event_date', { ascending: true })
    .limit(BACKFILL_BATCH_LIMIT);

  if (!unmatchedEvents || unmatchedEvents.length === 0) return;

  const backfillEventIds: number[] = [];
  const backfillEmpIds: number[] = [];
  const pairsSet = new Set<string>();

  for (const evt of unmatchedEvents) {
    const key = normalizePersonName(evt.physical_person || '');
    const empId = nameToEmpId.get(key);
    if (!empId) continue;

    backfillEventIds.push(evt.id);
    backfillEmpIds.push(empId);
    pairsSet.add(`${empId}:${evt.event_date}`);
  }

  if (backfillEventIds.length === 0) {
    if (unmatchedEvents.length === BACKFILL_BATCH_LIMIT) {
      console.warn(
        `[backfill] ${unmatchedEvents.length} unmatched events in window, none matched by name — possible name normalization drift`,
      );
    }
    return;
  }

  console.log(
    `[backfill] window ${fromDate}..${today}: matched ${backfillEventIds.length}/${unmatchedEvents.length} events${unmatchedEvents.length === BACKFILL_BATCH_LIMIT ? ' (batch capped, will continue next tick)' : ''}`,
  );

  await supabase.rpc('bulk_update_employee_ids', {
    p_event_ids: backfillEventIds,
    p_employee_ids: backfillEmpIds,
  });

  // Пересчитываем daily_summary по реальной дате каждого связанного события.
  const pairs = [...pairsSet].map(key => {
    const [empIdStr, date] = key.split(':');
    return { emp_id: parseInt(empIdStr, 10), date };
  });

  if (pairs.length > 0) {
    await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
  }

  console.log(`[backfill] recalculated daily summary for ${pairs.length} employee-days`);
}
