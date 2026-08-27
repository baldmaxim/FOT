import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * Полный цикл обмена с 1С: закрыт → ОТКРЫТ → правки → закрыт заново, и так дважды.
 *
 * Зачем отдельный файл, а не пара кейсов в public-timesheets.controller.test.ts: там
 * каждый метод проверяется изолированно на заранее подготовленных ответах БД, и такой
 * тест по построению не увидит регрессию «на втором круге». Здесь вместо заготовок —
 * маленькое хранилище подач и версий, а контроллер ходит в него своими же запросами.
 * Состояние переживает вызовы, поэтому проверяются именно переходы.
 *
 * Главный инвариант: пока табель открыт для правок, 1С продолжает получать последнюю
 * ОФИЦИАЛЬНО закрытую редакцию, ровно одну строку на подачу. Раньше открытый табель
 * исчезал из выдачи целиком (409 TIMESHEET_UNLOCKED), и запрет прямых админских правок
 * растянул бы это окно с секунд до часов.
 *
 * Границы: open/close здесь моделируются мутацией хранилища — ровно теми полями, что
 * пишут openPeriod/closePeriod (unlocked_at и новая строка версии). Права на сами
 * кнопки и атомарность закрытия покрыты в timesheet-approval.controller.lock-toggle.
 */

const APPROVAL_ID = 855;

interface IVersionRow {
  id: number;
  approval_id: number;
  revision: number;
  content_hash: string;
  payload: unknown;
  employees_count: number;
  total_hours: number;
  created_at: string;
}

// ─── Хранилище ────────────────────────────────────────────────────────────────

const store = {
  approval: {
    id: APPROVAL_ID,
    status: 'approved' as string,
    unlocked_at: null as string | null,
    version_dirty_at: null as string | null,
    department_id: 'dept-1',
    department_name: 'Бригада 1',
    manager_employee_id: null as number | null,
    start_date: '',
    end_date: '',
  },
  versions: [] as IVersionRow[],
  exports: new Map<number, { acked_at: string; document_ref: string | null }>(),
  nextVersionId: 9000,
};

function latestVersion(): IVersionRow | null {
  if (store.versions.length === 0) return null;
  return store.versions.reduce((a, b) => (a.revision >= b.revision ? a : b));
}

/** Как materializeVersion: новая редакция только при изменившемся хэше. */
function closePeriod(contentHash: string): void {
  store.approval.unlocked_at = null;
  const last = latestVersion();
  if (last && last.content_hash === contentHash) return;
  store.versions.push({
    id: store.nextVersionId++,
    approval_id: APPROVAL_ID,
    revision: (last ? last.revision : 0) + 1,
    content_hash: contentHash,
    payload: { employees: [] },
    employees_count: 3,
    total_hours: 24,
    created_at: '2026-08-27T10:00:00Z',
  });
}

function openPeriod(): void {
  store.approval.unlocked_at = '2026-08-27T09:00:00Z';
}

// ─── Мок БД: обслуживаем запросы контроллера из хранилища ─────────────────────

const { pgQuery, pgQueryOne, getKeyTables, txCalls } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  getKeyTables: vi.fn(),
  txCalls: [] as Array<{ sql: string; params: unknown[] }>,
}));

function runSelect(sql: string, params: unknown[]): unknown[] {
  const a = store.approval;

  // Список: одна строка на подачу, версия — последняя по revision.
  if (/FROM timesheet_approvals a/i.test(sql)) {
    if (a.status !== 'approved') return [];
    if (/a\.unlocked_at IS NULL/i.test(sql) && a.unlocked_at) return [];
    if (a.version_dirty_at) return [];
    const v = latestVersion();
    // Как LATERAL в контроллере: подтверждение берётся у САМОЙ ПОЗДНЕЙ редакции, у
    // которой оно вообще есть, а не обязательно у последней. Иначе появление новой
    // редакции стирало бы факт приёма предыдущей, и stale выглядел бы как not_exported.
    const ackedVersion = store.versions
      .filter(x => store.exports.has(x.id))
      .sort((x, y) => y.revision - x.revision)[0] ?? null;
    const ack = ackedVersion ? store.exports.get(ackedVersion.id) ?? null : null;
    const row = {
      approval_id: a.id,
      department_id: a.department_id,
      department_name: a.department_name,
      manager_employee_id: a.manager_employee_id,
      start_date: a.start_date,
      end_date: a.end_date,
      version_id: v ? v.id : null,
      revision: v ? v.revision : null,
      content_hash: v ? v.content_hash : null,
      employees_count: v ? v.employees_count : null,
      total_hours: v ? v.total_hours : null,
      version_created_at: v ? v.created_at : null,
      acked_version_id: ackedVersion ? ackedVersion.id : null,
      acked_revision: ackedVersion ? ackedVersion.revision : null,
      acked_at: ack ? ack.acked_at : null,
      document_ref: ack ? ack.document_ref : null,
    };
    // Фильтр состояния контроллер оборачивает подзапросом — повторяем его здесь.
    if (/acked_version_id IS DISTINCT FROM/i.test(sql)) {
      return row.version_id == null || row.acked_version_id !== row.version_id ? [row] : [];
    }
    if (/t\.acked_version_id = t\.version_id/i.test(sql)) {
      return row.version_id != null && row.acked_version_id === row.version_id ? [row] : [];
    }
    return [row];
  }

  if (/FROM timesheet_approvals WHERE id/i.test(sql)) {
    return [{ id: a.id, status: a.status, version_dirty_at: a.version_dirty_at }];
  }

  if (/FROM timesheet_versions/i.test(sql) && /approval_id = \$1 AND revision = \$2/i.test(sql)) {
    return store.versions.filter(v => v.revision === Number(params[1]));
  }
  if (/FROM timesheet_versions/i.test(sql)) {
    const v = latestVersion();
    return v ? [v] : [];
  }
  if (/FROM timesheet_1c_exports e/i.test(sql)) {
    const ackedVersion = store.versions
      .filter(x => store.exports.has(x.id))
      .sort((x, y) => y.revision - x.revision)[0] ?? null;
    return ackedVersion ? [{ version_id: ackedVersion.id }] : [];
  }
  if (/FROM timesheet_1c_exports WHERE version_id/i.test(sql)) {
    const ack = store.exports.get(Number(params[0]));
    return ack ? [{ acked_at: ack.acked_at, document_ref: ack.document_ref }] : [];
  }
  return [];
}

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn({
    query: async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      txCalls.push({ sql, params: p });
      if (/INSERT INTO timesheet_1c_exports/i.test(sql)) {
        const versionId = Number(p[0]);
        // ON CONFLICT DO NOTHING: повторный ACK не перезаписывает время приёма.
        if (!store.exports.has(versionId)) {
          store.exports.set(versionId, {
            acked_at: '2026-08-27T12:00:00Z',
            document_ref: (p[2] as string | null) ?? null,
          });
        }
        return { rows: [], rowCount: 1 };
      }
      const rows = runSelect(sql, p);
      return { rows, rowCount: rows.length };
    },
  }),
}));

vi.mock('../services/data-api-key.service.js', () => ({ dataApiKeyService: { getKeyTables } }));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));

import { publicTimesheetsController } from './public-timesheets.controller.js';

// ─── Хелперы запроса/ответа ──────────────────────────────────────────────────

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function makeReq(over: Partial<{ query: Record<string, string>; body: unknown }> = {}): Request {
  return {
    query: over.query ?? {},
    params: { approval_id: String(APPROVAL_ID) },
    body: over.body ?? {},
    dataApiKey: {
      id: 'key-1', name: 'OdintsovV2', rate_limit_per_minute: 300, allow_timesheet_ack: true,
    },
  } as unknown as Request;
}

function makeRes() {
  const response = {
    statusCode: 200,
    payload: null as any,
    headersSent: false,
    locals: {} as Record<string, unknown>,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; this.headersSent = true; return this; },
  };
  return response as unknown as Response & { statusCode: number; payload: any };
}

async function list(query: Record<string, string> = {}) {
  const res = makeRes();
  await publicTimesheetsController.list(makeReq({ query: { month: currentMonth(), ...query } }), res);
  return res;
}

async function detail(query: Record<string, string> = {}) {
  const res = makeRes();
  await publicTimesheetsController.detail(makeReq({ query }), res);
  return res;
}

async function ack(revision: number) {
  const res = makeRes();
  await publicTimesheetsController.ack(makeReq({ body: { revision } }), res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  txCalls.length = 0;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  store.approval = {
    id: APPROVAL_ID,
    status: 'approved',
    unlocked_at: null,
    version_dirty_at: null,
    department_id: 'dept-1',
    department_name: 'Бригада 1',
    manager_employee_id: null,
    start_date: `${y}-${m}-01`,
    end_date: `${y}-${m}-15`,
  };
  store.versions = [];
  store.exports = new Map();
  store.nextVersionId = 9000;
  getKeyTables.mockResolvedValue([{ table_name: 'employees' }]);
  pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => runSelect(sql, params ?? []));
  pgQueryOne.mockImplementation(async (sql: string, params?: unknown[]) => runSelect(sql, params ?? [])[0] ?? null);
  // Исходное состояние: табель согласован и закрыт, редакция 1 опубликована.
  closePeriod('hash-r1');
});

describe('цикл «Открыть → правка → Закрыть» глазами 1С', () => {
  it('круг 1: открытие не прячет табель и не плодит дублей, закрытие даёт ровно одну новую редакцию', async () => {
    // 1. Закрыт: доступна редакция 1, одна строка на подачу.
    const before = await list();
    expect(before.payload.data).toHaveLength(1);
    expect(before.payload.data[0].revision).toBe(1);

    // 2. Открываем для правок.
    openPeriod();

    // 3. Табель ОСТАЁТСЯ в выдаче с прежней редакцией. Это и есть суть правки Этапа 1.
    const whileOpen = await list();
    expect(whileOpen.payload.data).toHaveLength(1);
    expect(whileOpen.payload.data[0].approval_id).toBe(APPROVAL_ID);
    expect(whileOpen.payload.data[0].revision).toBe(1);

    const detailOpen = await detail();
    expect(detailOpen.statusCode).toBe(200);
    expect(detailOpen.payload.revision).toBe(1);

    // 4. ACK во время открытого периода принимается.
    const ackOpen = await ack(1);
    expect(ackOpen.statusCode).toBe(200);

    // 5. Правки идут в ФОТ, но версию не трогают: незакрытые часы в 1С не попадают.
    expect(store.approval.version_dirty_at).toBeNull();
    expect(latestVersion()?.revision).toBe(1);

    // 6. Закрываем с изменившимся содержимым → ровно одна новая редакция.
    closePeriod('hash-r2');
    expect(store.versions).toHaveLength(2);
    expect(latestVersion()?.revision).toBe(2);

    // 7. Прежняя запись не всплыла отдельным табелем.
    const after = await list();
    expect(after.payload.data).toHaveLength(1);
    expect(after.payload.data[0].approval_id).toBe(APPROVAL_ID);
    expect(after.payload.data[0].revision).toBe(2);

    // 8. Состояние — stale, подача снова в очереди на выгрузку.
    expect(after.payload.data[0].state).toBe('stale');
    const needs = await list({ needs_export: 'true' });
    expect(needs.payload.data).toHaveLength(1);
  });

  it('круг 2 на той же подаче: редакция растёт до 3, дублей по-прежнему нет', async () => {
    await ack(1);
    openPeriod();
    closePeriod('hash-r2');
    await ack(2);

    // Второй круг — именно он ловит регрессии, невидимые на одном проходе.
    openPeriod();
    const whileOpen = await list();
    expect(whileOpen.payload.data).toHaveLength(1);
    expect(whileOpen.payload.data[0].revision).toBe(2);
    expect((await detail()).payload.revision).toBe(2);

    closePeriod('hash-r3');
    const after = await list();
    expect(after.payload.data).toHaveLength(1);
    expect(after.payload.data[0].revision).toBe(3);
    expect(after.payload.data[0].state).toBe('stale');

    // За оба круга — ровно три редакции одной подачи, ни одной лишней строки.
    expect(store.versions.map(v => v.revision)).toEqual([1, 2, 3]);
    expect(new Set(store.versions.map(v => v.approval_id)).size).toBe(1);
  });

  it('закрытие без фактических правок новой редакции не создаёт — 1С не перепроводит документ', async () => {
    await ack(1);
    openPeriod();
    closePeriod('hash-r1'); // хэш не изменился

    expect(store.versions).toHaveLength(1);
    const after = await list();
    expect(after.payload.data[0].revision).toBe(1);
    expect(after.payload.data[0].state).toBe('exported');
    expect((await list({ needs_export: 'true' })).payload.data).toHaveLength(0);
  });

  it('подача не исчезает из выдачи ни в один момент цикла', async () => {
    const seen: number[] = [];
    const probe = async () => { seen.push((await list()).payload.data.length); };

    await probe();            // закрыт
    openPeriod();
    await probe();            // открыт
    await probe();            // идут правки
    closePeriod('hash-r2');
    await probe();            // закрыт заново
    openPeriod();
    await probe();            // открыт второй раз
    closePeriod('hash-r3');
    await probe();

    expect(seen).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('ACK идемпотентен: повторное подтверждение той же редакции не создаёт вторую запись', async () => {
    const first = await ack(1);
    const firstAckedAt = first.payload.acked_at;
    const second = await ack(1);

    expect(second.statusCode).toBe(200);
    expect(second.payload.acked_at).toBe(firstAckedAt);
    expect(store.exports.size).toBe(1);
  });

  it('аварийная пересборка по-прежнему скрывает подачу — фильтр version_dirty_at не сломан', async () => {
    // Единственный оставшийся случай, когда табель временно не отдаётся: содержимое
    // версии меняется, и отдать старые часы нельзя. Достигается только операторской
    // процедурой (timesheet-version-maintenance), в штатном процессе не возникает.
    store.approval.version_dirty_at = '2026-08-27T11:00:00Z';

    expect((await list()).payload.data).toHaveLength(0);
    const d = await detail();
    expect(d.statusCode).toBe(409);
    expect(d.payload.code).toBe('TIMESHEET_REBUILD_PENDING');
    const a = await ack(1);
    expect(a.statusCode).toBe(409);
    expect(a.payload.code).toBe('TIMESHEET_REBUILD_PENDING');
  });

  it('отозванная подача уходит из выдачи: фильтр по статусу на месте', async () => {
    store.approval.status = 'draft';
    expect((await list()).payload.data).toHaveLength(0);
    expect((await detail()).payload.code).toBe('TIMESHEET_NOT_APPROVED');
  });
});
