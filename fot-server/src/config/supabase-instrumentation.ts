/**
 * Лёгкий счётчик inflight-запросов к Supabase.
 *
 * Не оборачиваем сам клиент proxy: builder-цепочки supabase-js (.from().select().eq()) имеют
 * нетривиальную .then-семантику, и proxy может задеть внутренние вызовы. Вместо этого вручную
 * оборачиваем горячие точки (presence-polling UPSERT, batch_recalculate_skud_daily_summary,
 * get_descendant_department_ids) через withSupabaseSlot — этого достаточно, чтобы presence-polling
 * мог тормозить, когда pool близок к насыщению.
 */

let inflightCount = 0;

export function getSupabaseInflight(): number {
  return inflightCount;
}

export async function withSupabaseSlot<T>(_label: string, fn: () => Promise<T>): Promise<T> {
  inflightCount++;
  try {
    return await fn();
  } finally {
    inflightCount--;
  }
}
