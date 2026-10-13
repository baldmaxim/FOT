/**
 * Read-only снимок БД со «сценарной» подменой типа зоны точки доступа.
 *
 * Нужен замеру влияния смены типа зоны (report-access-point-zone-impact.ts): штатный расчёт
 * табеля вызывается несколько раз над ОДНИМ снимком БД, а отличается только то, как считать
 * точку — как в БД, принудительно внутренней или принудительно внешней. БД не меняется.
 *
 * Как это устроено:
 *  • одно соединение, транзакция REPEATABLE READ READ ONLY — все прогоны видят одно состояние;
 *  • пул и клиент транзакции подменены одной обёрткой: и запросы «через exec», и запросы
 *    «через пул» (список внутренних точек читается именно так) идут в тот же снимок, по очереди;
 *  • ответ на запрос истории типа зоны (skud_access_point_zone_periods) подставляется под
 *    сценарий — таблицы на проде до миграции 305 ещё нет, поэтому сам запрос в БД не уходит;
 *  • строки skud_daily_summary, пересчитанные уже после переключения, подменяются значениями,
 *    которые передал вызывающий (иначе «как было» собралось бы из уже испорченной сводки).
 *
 * Любой запрос, кроме чтения, отклоняется ещё до отправки в БД.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * env ДО импорта app-модулей (приём profile-unified-export.ts): NODE_ENV=test, чтобы env.ts не
 * перетёр значения override'ом; ssl-параметры вырезаются из DATABASE_URL, CA берётся из репо.
 */
export const bootstrapLocalEnv = (): { host: string; database: string } => {
  process.env.NODE_ENV = 'test';
  const text = fs.readFileSync(path.resolve(__dirname, '../../.env'), 'utf8');
  let rawUrl = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1 || trimmed.slice(0, eq).trim() !== 'DATABASE_URL') continue;
    rawUrl = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  if (!rawUrl) throw new Error('DATABASE_URL не найден в fot-server/.env');

  const url = new URL(rawUrl);
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) url.searchParams.delete(key);
  process.env.DATABASE_URL = url.toString();
  process.env.DATABASE_SSL = 'true';
  process.env.DATABASE_SSL_CA_PATH = path.resolve(__dirname, '../../../.migration/yandex-ca.pem');
  // Наружу — только хост и имя базы: пароль и логин не печатаются.
  return { host: url.hostname, database: url.pathname.replace(/^\//, '') };
};

/**
 * Как считать точку:
 *  • as-is    — как в БД (после миграции 305: живая история типа зоны);
 *  • internal — «как было»: внутренняя всегда;
 *  • external — «как сейчас на экране»: внешняя всегда;
 *  • planned  — «как будет после миграции»: внутренняя, а с даты externalFrom — внешняя.
 */
export type ZoneOverride = 'as-is' | 'internal' | 'external' | 'planned';

export interface ISummaryPatch {
  first_entry: string | null;
  last_exit: string | null;
  total_minutes: number | null;
  break_minutes: number | null;
}

export interface IScenario {
  zone: ZoneOverride;
  /** Подмена строк сводки: ключ `${employeeId}_${YYYY-MM-DD}`; null — пустая сводка. */
  summaryPatch: Map<string, ISummaryPatch | null> | null;
}

export interface IScenarioHits {
  internalPoints: number;
  summaryRows: number;
}

export interface IScenarioSnapshot {
  /** Сценарная обёртка клиента — передавать расчёту как `exec`. */
  exec: PoolClient;
  setScenario: (scenario: IScenario) => void;
  /** Сколько раз сработала каждая подмена с последнего setScenario. */
  hits: () => IScenarioHits;
  /** Прямой запрос в тот же снимок, без подмен. */
  raw: <T extends QueryResultRow>(sql: string, params?: readonly unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

// Запрос истории типа зоны: skud-shared.service.ts → getInternalAccessPoints().
const ZONE_PERIODS_RE = /FROM\s+skud_access_point_zone_periods/i;
// Запрос сводки табелем: attendance.service.ts → loadDailySummaries().
const SUMMARY_RE = /SELECT\s+employee_id,\s*date,\s*first_entry,\s*last_exit,\s*total_hours,\s*total_minutes,\s*break_hours,\s*break_minutes\s+FROM\s+skud_daily_summary/i;
const TX_CONTROL_RE = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const READ_RE = /^\s*(SELECT|WITH|SHOW)\b/i;

const EMPTY_RESULT = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as QueryResult;

const roundHours = (value: number): number => Math.round(value * 100) / 100;

/**
 * Значения сводки в том виде, как их пишет recalculate_skud_daily_summary (миграция 168):
 * часы есть только у дня с закрытой парой, иначе total = NULL, перерыв = 0.
 */
const toSummaryColumns = (patch: ISummaryPatch | null): Record<string, unknown> => {
  const minutes = patch?.total_minutes ?? 0;
  if (!patch || minutes <= 0) {
    return {
      first_entry: patch?.first_entry ?? null,
      last_exit: null,
      total_hours: null,
      total_minutes: null,
      break_hours: 0,
      break_minutes: 0,
    };
  }
  const breakMinutes = patch.break_minutes ?? 0;
  return {
    first_entry: patch.first_entry,
    last_exit: patch.last_exit,
    total_hours: roundHours(minutes / 60),
    total_minutes: minutes,
    break_hours: roundHours(breakMinutes / 60),
    break_minutes: breakMinutes,
  };
};

export const openScenarioSnapshot = async (
  pool: Pool,
  point: string,
  /** Для сценария planned: с какого рабочего дня точка внешняя. */
  externalFrom: string,
): Promise<IScenarioSnapshot> => {
  const client = await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

  // Остальные внутренние точки — те же, что перенесёт миграция 305: «внутренние с самого начала».
  const otherInternal = (await client.query<{ name: string }>(
    `SELECT DISTINCT btrim(access_point_name) AS name FROM skud_access_point_settings
      WHERE is_internal = true AND btrim(access_point_name) <> ''`,
  )).rows.map(row => row.name).filter(name => name !== point);

  const simulatedPeriods = (zone: ZoneOverride): Array<Record<string, unknown>> => {
    const rows = otherInternal.map(name => ({ access_point_name: name, is_internal: true, effective_from: '2000-01-01' }));
    if (zone === 'internal' || zone === 'planned') {
      rows.push({ access_point_name: point, is_internal: true, effective_from: '2000-01-01' });
    }
    if (zone === 'planned') rows.push({ access_point_name: point, is_internal: false, effective_from: externalFrom });
    return rows;
  };

  let scenario: IScenario = { zone: 'as-is', summaryPatch: null };
  let hits: IScenarioHits = { internalPoints: 0, summaryRows: 0 };
  // Один клиент — один запрос за раз: расчёт местами шлёт запросы параллельно.
  let chain: Promise<unknown> = Promise.resolve();

  const applyScenario = (text: string, result: QueryResult): QueryResult => {
    const patch = scenario.summaryPatch;
    if (patch && patch.size > 0 && SUMMARY_RE.test(text)) {
      const rows = (result.rows as Array<Record<string, unknown>>).map(row => {
        const key = `${Number(row.employee_id)}_${String(row.date).slice(0, 10)}`;
        if (!patch.has(key)) return row;
        hits.summaryRows += 1;
        return { ...row, ...toSummaryColumns(patch.get(key) ?? null) };
      });
      return { ...result, rows };
    }
    return result;
  };

  const scenarioQuery = (
    textOrConfig: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ): Promise<QueryResult> => {
    const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
    const params = typeof textOrConfig === 'string' ? values : textOrConfig.values;
    // Вложенные BEGIN/COMMIT расчёта не должны закрыть наш снимок.
    if (TX_CONTROL_RE.test(text)) return Promise.resolve(EMPTY_RESULT);
    if (!READ_RE.test(text)) {
      return Promise.reject(new Error(`Только чтение: запрос отклонён — ${text.trim().slice(0, 80)}`));
    }
    // История типа зоны подставляется целиком: до миграции 305 таблицы на проде нет.
    if (scenario.zone !== 'as-is' && ZONE_PERIODS_RE.test(text)) {
      hits.internalPoints += 1;
      const rows = simulatedPeriods(scenario.zone);
      return Promise.resolve({ ...EMPTY_RESULT, rows, rowCount: rows.length } as QueryResult);
    }
    const task = chain.then(async () => applyScenario(text, await client.query(text, params)));
    chain = task.catch(() => undefined);
    return task;
  };

  const exec = new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') return scenarioQuery;
      if (prop === 'release') return () => undefined;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as PoolClient;

  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  (pool as unknown as { query: unknown }).query = scenarioQuery;
  (pool as unknown as { connect: unknown }).connect = async () => exec;

  return {
    exec,
    setScenario: next => {
      scenario = next;
      hits = { internalPoints: 0, summaryRows: 0 };
    },
    hits: () => ({ ...hits }),
    raw: async <T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
      const task = chain.then(async () => (await client.query<T>(sql, params as unknown[] | undefined)).rows);
      chain = task.catch(() => undefined);
      return task;
    },
    close: async () => {
      await chain;
      (pool as unknown as { query: unknown }).query = originalQuery;
      (pool as unknown as { connect: unknown }).connect = originalConnect;
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    },
  };
};
