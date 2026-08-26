// Порядок выполнения группы запросов: параллельно на пуле, последовательно на
// клиенте транзакции.
//
// Живёт в utils, а не в config/postgres.ts, намеренно: сервисы табеля мокают
// postgres.js целиком, и любой новый экспорт оттуда ломал бы их моки. Сам хелпер
// к БД не обращается — он лишь управляет порядком вызовов.

import type { DbExecutor } from '../config/postgres.js';

/**
 * pg не допускает конкурентных запросов на одном соединении: в pg@9 такой вызов
 * помечен deprecated и печатает предупреждение на каждый случай. Фактически запросы
 * встают в очередь и результаты не путаются, но полагаться на это нельзя.
 *
 * Параллельность на пуле сохраняем намеренно: те же функции обслуживают
 * интерактивный табель и Excel-выгрузки — там последовательное выполнение было бы
 * заметным замедлением.
 *
 * Принимает функции, а не готовые промисы: промис стартует в момент создания,
 * и последовательность бы не соблюдалась.
 */
export async function runMaybeParallel<T extends readonly (() => Promise<unknown>)[]>(
  exec: DbExecutor | undefined,
  ...thunks: T
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  type Result = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };

  if (!exec) {
    return await Promise.all(thunks.map(thunk => thunk())) as Result;
  }

  const results: unknown[] = [];
  for (const thunk of thunks) {
    results.push(await thunk());
  }
  return results as Result;
}
