/**
 * Лёгкий счётчик inflight-запросов к БД (pg-Pool).
 *
 * Вручную оборачиваем горячие точки (presence-polling INSERT batches,
 * batch_recalculate_skud_daily_summary, get_descendant_department_ids) через
 * withDbSlot — этого достаточно, чтобы presence-polling мог тормозить, когда
 * pool близок к насыщению.
 *
 * До Phase 10F файл назывался supabase-instrumentation.ts; имя сменилось
 * вместе с удалением Supabase SDK из runtime. Семантика семафора и счётчик
 * inflight не менялись.
 */

let inflightCount = 0;

export function getDbInflight(): number {
  return inflightCount;
}

export async function withDbSlot<T>(_label: string, fn: () => Promise<T>): Promise<T> {
  inflightCount++;
  try {
    return await fn();
  } finally {
    inflightCount--;
  }
}
