import { query } from '../config/postgres.js';
import type { PoolClient } from 'pg';
import { moscowTodayIso } from '../utils/date.utils.js';

/**
 * Кэш глобальных KPI-ролей (object_kpi_global_roles).
 *
 * Зачем кэш вообще: «Руководитель экономического отдела» не системная роль —
 * system_role_id у пользователя один, и выдача ему роли «Экономист» отобрала бы
 * текущую. Персональных грантов на страницы в модели прав нет (role_page_access
 * ключуется по role_code), поэтому доступ выдаётся авто-грантом по факту о человеке,
 * как это уже сделано для «Заявок на поиск сотрудников» (hiring-access.service.ts).
 * Авто-грант дёргается на каждой проверке прав, поэтому ходить за ним в БД нельзя.
 *
 * Устройство скопировано с roles-cache.service.ts: TTL 5 минут + promise-dedup,
 * чтобы на холодном кэше один HTTP-запрос не сделал несколько одинаковых SELECT.
 *
 * ВАЖНО: этот кэш годится только для показа вкладки и гардов чтения. Денежные
 * операции (пересмотр закрытого месяца) обязаны перепроверять роль в БД внутри
 * своей транзакции — см. isEconomicsHeadLive(). Инвалидация кэша локальна для
 * процесса, поэтому на соседнем инстансе снятая роль живёт до 5 минут.
 */

const ROLES_CACHE_TTL_MS = 300_000;

let economicsHeadCache: Set<number> | null = null;
let economicsHeadCacheExpiresAt = 0;
let economicsHeadInflight: Promise<void> | null = null;

async function loadEconomicsHeadCache(): Promise<void> {
  const now = Date.now();
  if (economicsHeadCache && economicsHeadCacheExpiresAt > now) return;
  if (economicsHeadInflight) return economicsHeadInflight;

  economicsHeadInflight = (async () => {
    try {
      const today = moscowTodayIso();
      const rows = await query<{ employee_id: string | number }>(
        `SELECT employee_id
           FROM object_kpi_global_roles
          WHERE role_kind = 'economics_head'
            AND valid_from <= $1::date
            AND (valid_to IS NULL OR valid_to >= $1::date)`,
        [today],
      );

      economicsHeadCache = new Set(rows.map((row) => Number(row.employee_id)));
      economicsHeadCacheExpiresAt = Date.now() + ROLES_CACHE_TTL_MS;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load object KPI global roles cache: ${msg}`);
    } finally {
      economicsHeadInflight = null;
    }
  })();

  return economicsHeadInflight;
}

/**
 * Быстрая проверка по кэшу. Стоимость — Set.has в памяти; в БД ходим раз в 5 минут.
 * Вызывается только для KPI-ключей доступа, остальные страницы её не задевают.
 */
export async function isEconomicsHead(employeeId: number | null | undefined): Promise<boolean> {
  if (!employeeId) return false;
  await loadEconomicsHeadCache();
  return economicsHeadCache?.has(Number(employeeId)) === true;
}

/**
 * Проверка МИМО кэша, в текущей транзакции. Нужна перед правкой закрытого месяца:
 * роль могли снять минуту назад, а кэш этого инстанса об этом ещё не знает.
 */
export async function isEconomicsHeadLive(
  client: PoolClient,
  employeeId: number | null | undefined,
): Promise<boolean> {
  if (!employeeId) return false;
  const result = await client.query(
    `SELECT 1
       FROM object_kpi_global_roles
      WHERE role_kind = 'economics_head'
        AND employee_id = $1
        AND valid_from <= $2::date
        AND (valid_to IS NULL OR valid_to >= $2::date)
      LIMIT 1`,
    [employeeId, moscowTodayIso()],
  );
  return result.rowCount === 1;
}

export function invalidateObjectKpiRolesCache(): void {
  economicsHeadCache = null;
  economicsHeadCacheExpiresAt = 0;
  economicsHeadInflight = null;
}
