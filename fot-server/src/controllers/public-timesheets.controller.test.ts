import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * Контракт обмена закрытыми табелями с 1С. Проверяем именно то, на что опирается
 * внешняя система: коды отказов, идемпотентность подтверждения и то, что версия
 * отдаётся целиком, без скрытой фильтрации состава.
 */

const { pgQuery, pgQueryOne, getKeyTables, txClient, txCalls } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  getKeyTables: vi.fn(),
  txClient: { handler: null as null | ((sql: string, params: unknown[]) => unknown) },
  txCalls: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => fn({
    query: async (sql: string, params?: unknown[]) => {
      txCalls.push({ sql, params: params ?? [] });
      const rows = txClient.handler?.(sql, params ?? []) ?? [];
      const list = Array.isArray(rows) ? rows : [rows];
      return { rows: list, rowCount: list.length };
    },
  }),
}));

vi.mock('../services/data-api-key.service.js', () => ({
  dataApiKeyService: { getKeyTables },
}));

vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));

import { publicTimesheetsController } from './public-timesheets.controller.js';

const APPROVAL_ID = 855;

function makeReq(over: Partial<{
  query: Record<string, string>;
  params: Record<string, string>;
  body: unknown;
  allowAck: boolean;
}> = {}): Request {
  return {
    query: over.query ?? {},
    params: over.params ?? { approval_id: String(APPROVAL_ID) },
    body: over.body ?? {},
    dataApiKey: {
      id: 'key-1',
      name: 'OdintsovV2',
      rate_limit_per_minute: 300,
      allow_timesheet_ack: over.allowAck ?? true,
    },
  } as unknown as Request;
}

function makeRes() {
  const response = {
    statusCode: 200,
    payload: null as unknown,
    headersSent: false,
    locals: {} as Record<string, unknown>,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; this.headersSent = true; return this; },
  };
  return response as unknown as Response & { statusCode: number; payload: any };
}

const approvalRow = (over: Record<string, unknown> = {}) => ({
  id: APPROVAL_ID,
  status: 'approved',
  version_dirty_at: null,
  ...over,
});

const versionRow = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  revision: 2,
  content_hash: 'hash-v2',
  employees_count: 3,
  total_hours: '312.5',
  created_at: '2026-08-16T09:12:44.000Z',
  payload: {
    approval: { id: APPROVAL_ID, scope: { kind: 'department' } },
    employees: [
      { identity: { employee_id: 501 }, zero_activity: false, total_hours: 120, days: {} },
      { identity: { employee_id: 502 }, zero_activity: true, total_hours: 0, days: {} },
    ],
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  txCalls.length = 0;
  txClient.handler = null;
  getKeyTables.mockResolvedValue([{ table_name: 'employees', allowed_fields: [] }]);
  pgQuery.mockResolvedValue([]);
  pgQueryOne.mockResolvedValue(null);
});

describe('gates', () => {
  it('без токена — 401', async () => {
    const req = { query: {}, params: {}, body: {} } as unknown as Request;
    const res = makeRes();
    await publicTimesheetsController.list(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('ключу не открыта employees — 403 и на списке, и на подтверждении', async () => {
    getKeyTables.mockResolvedValue([{ table_name: 'skud_events', allowed_fields: [] }]);
    const listRes = makeRes();
    await publicTimesheetsController.list(makeReq(), listRes);
    expect(listRes.statusCode).toBe(403);

    const ackRes = makeRes();
    await publicTimesheetsController.ack(makeReq({ body: { revision: 2 } }), ackRes);
    expect(ackRes.statusCode).toBe(403);
  });

  it('ACK без флага allow_timesheet_ack — 403, в БД не пишем', async () => {
    const res = makeRes();
    await publicTimesheetsController.ack(makeReq({ allowAck: false, body: { revision: 2 } }), res);
    expect(res.statusCode).toBe(403);
    expect(txCalls).toHaveLength(0);
  });
});

describe('list', () => {
  it('month вместе с from/to — 400: параметры взаимоисключающие', async () => {
    const res = makeRes();
    await publicTimesheetsController.list(
      makeReq({ query: { month: '2026-08', from: '2026-08-01', to: '2026-08-15' } }), res,
    );
    expect(res.statusCode).toBe(400);
    expect(String(res.payload.error)).toContain('взаимоисключающие');
  });

  it('запрос глубже трёх месяцев — 400', async () => {
    const res = makeRes();
    await publicTimesheetsController.list(makeReq({ query: { month: '2000-01' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('подача без версии приходит с version_available=false и пустыми полями версии', async () => {
    pgQuery.mockResolvedValue([{
      approval_id: APPROVAL_ID,
      department_id: 'dept-1',
      department_name: 'бр. Иванова',
      manager_employee_id: null,
      start_date: '2026-08-01',
      end_date: '2026-08-15',
      version_id: null,
      revision: null,
      content_hash: null,
      employees_count: null,
      total_hours: null,
      version_created_at: null,
      acked_version_id: null,
      acked_revision: null,
      acked_at: null,
      document_ref: null,
    }]);

    const res = makeRes();
    await publicTimesheetsController.list(makeReq({ query: { month: currentMonth() } }), res);

    expect(res.statusCode).toBe(200);
    const row = res.payload.data[0];
    expect(row.version_available).toBe(false);
    expect(row.revision).toBeNull();
    expect(row.content_hash).toBeNull();
    expect(row.state).toBe('not_exported');
    expect(res.payload.meta.without_version).toBe(1);
  });

  it('принятая версия — exported, более ранний ACK — stale', async () => {
    pgQuery.mockResolvedValue([
      baseRow({ version_id: 10, revision: 3, acked_version_id: 10, acked_revision: 3 }),
      baseRow({ approval_id: 900, version_id: 20, revision: 4, acked_version_id: 19, acked_revision: 3 }),
    ]);

    const res = makeRes();
    await publicTimesheetsController.list(makeReq({ query: { month: currentMonth() } }), res);

    expect(res.payload.data[0].state).toBe('exported');
    expect(res.payload.data[1].state).toBe('stale');
  });

  it('next_cursor выдаётся только когда есть следующая страница', async () => {
    pgQuery.mockResolvedValue([baseRow(), baseRow({ approval_id: 900 })]);
    const res = makeRes();
    await publicTimesheetsController.list(
      makeReq({ query: { month: currentMonth(), limit: '1' } }), res,
    );
    expect(res.payload.data).toHaveLength(1);
    expect(res.payload.next_cursor).toBeTruthy();

    pgQuery.mockResolvedValue([baseRow()]);
    const last = makeRes();
    await publicTimesheetsController.list(
      makeReq({ query: { month: currentMonth(), limit: '1' } }), last,
    );
    expect(last.payload.next_cursor).toBeNull();
  });

  it('dirty-подачи исключены из выборки даже без needs_export', async () => {
    pgQuery.mockResolvedValue([]);
    const res = makeRes();
    await publicTimesheetsController.list(makeReq({ query: { month: currentMonth() } }), res);

    // Фильтр стоит в самом SQL: иначе список без needs_export отдал бы старую revision.
    const sql = String(pgQuery.mock.calls[0]![0]);
    expect(sql).toContain('a.version_dirty_at IS NULL');
    // А вот открытый период из выдачи НЕ исключается: см. detail-тесты.
    expect(sql).not.toContain('a.unlocked_at IS NULL');
    expect(res.statusCode).toBe(200);
  });

  it('битый cursor — 400, а не молчаливый сброс на первую страницу', async () => {
    const res = makeRes();
    await publicTimesheetsController.list(
      makeReq({ query: { month: currentMonth(), cursor: 'не-курсор' } }), res,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('detail', () => {
  it('открытый для правок табель ОТДАЁТСЯ: 1С получает последнюю закрытую редакцию', async () => {
    // Ключевой инвариант обмена: пока админ правит табель, подача не должна пропадать
    // из 1С. Версия — замороженный снимок, незавершённые правки в неё не попадают,
    // поэтому отдавать её безопасно. Раньше здесь был 409 TIMESHEET_UNLOCKED, и табель
    // исчезал из обмена на всё время правки.
    pgQueryOne
      .mockResolvedValueOnce(approvalRow())
      .mockResolvedValueOnce(versionRow())
      .mockResolvedValueOnce({ id: 9001 })
      .mockResolvedValueOnce({ version_id: 9001 });

    const res = makeRes();
    await publicTimesheetsController.detail(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.revision).toBe(2);
  });

  it('unlocked_at контроллером не читается — открытость на выдачу не влияет', async () => {
    // Регрессия на возврат фильтра: если условие по unlocked_at вернут, этот SELECT
    // снова начнёт его запрашивать.
    pgQueryOne
      .mockResolvedValueOnce(approvalRow())
      .mockResolvedValueOnce(versionRow())
      .mockResolvedValueOnce({ id: 9001 })
      .mockResolvedValueOnce({ version_id: 9001 });

    await publicTimesheetsController.detail(makeReq(), makeRes());

    expect(String(pgQueryOne.mock.calls[0]![0])).not.toContain('unlocked_at');
  });

  it('не утверждённый табель — 409 TIMESHEET_NOT_APPROVED', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow({ status: 'submitted' }));
    const res = makeRes();
    await publicTimesheetsController.detail(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('TIMESHEET_NOT_APPROVED');
  });

  it('версии ещё нет — 409 VERSION_NOT_AVAILABLE', async () => {
    pgQueryOne
      .mockResolvedValueOnce(approvalRow())
      .mockResolvedValueOnce(null);
    const res = makeRes();
    await publicTimesheetsController.detail(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('VERSION_NOT_AVAILABLE');
  });

  it('идёт пересборка — 409 TIMESHEET_REBUILD_PENDING', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow({ version_dirty_at: '2026-08-26T10:00:00Z' }));
    const res = makeRes();
    await publicTimesheetsController.detail(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('TIMESHEET_REBUILD_PENDING');
  });

  it('во время пересборки отказ и на ЯВНУЮ старую revision', async () => {
    // Иначе 1С запросит ?revision=1, получит прежние часы и перезапишет ими документ —
    // отклонённый позже ACK этого уже не исправит.
    pgQueryOne.mockResolvedValueOnce(approvalRow({ version_dirty_at: '2026-08-26T10:00:00Z' }));
    const res = makeRes();
    await publicTimesheetsController.detail(makeReq({ query: { revision: '1' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('TIMESHEET_REBUILD_PENDING');
  });

  it('отдаёт весь согласованный состав, включая zero_activity — фильтра на API нет', async () => {
    pgQueryOne
      .mockResolvedValueOnce(approvalRow())
      .mockResolvedValueOnce(versionRow())
      .mockResolvedValueOnce({ id: 9001 })
      .mockResolvedValueOnce({ version_id: 9001 });

    const res = makeRes();
    await publicTimesheetsController.detail(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.employees).toHaveLength(2);
    expect(res.payload.employees.map((e: any) => e.zero_activity)).toEqual([false, true]);
    // Счётчик и хэш соответствуют именно отданному телу.
    expect(res.payload.employees_count).toBe(3);
    expect(res.payload.content_hash).toBe('hash-v2');
    expect(res.payload.state).toBe('exported');
  });

  it('запрошена старая редакция — state считается по последней', async () => {
    pgQueryOne
      .mockResolvedValueOnce(approvalRow())
      .mockResolvedValueOnce(versionRow({ id: 8000, revision: 1, content_hash: 'hash-v1' }))
      .mockResolvedValueOnce({ id: 9001 })
      .mockResolvedValueOnce({ version_id: 8000 });

    const res = makeRes();
    await publicTimesheetsController.detail(makeReq({ query: { revision: '1' } }), res);

    expect(res.payload.revision).toBe(1);
    expect(res.payload.state).toBe('stale');
  });
});

describe('ack', () => {
  it('без revision — 400', async () => {
    const res = makeRes();
    await publicTimesheetsController.ack(makeReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it('устаревшая редакция — 409 REVISION_MISMATCH с актуальными значениями', async () => {
    txClient.handler = (sql) => {
      if (/FOR UPDATE/i.test(sql)) return [approvalRow()];
      if (/FROM timesheet_versions/i.test(sql)) return [{ id: 9001, revision: 3, content_hash: 'hash-v3' }];
      return [];
    };
    const res = makeRes();
    await publicTimesheetsController.ack(makeReq({ body: { revision: 2 } }), res);

    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('REVISION_MISMATCH');
    expect(res.payload.current_revision).toBe(3);
    expect(res.payload.current_content_hash).toBe('hash-v3');
  });

  it('ACK проходит и при открытом для правок табеле', async () => {
    // 1С подтверждает ровно ту редакцию, которую ей отдали. Появление следующей
    // переведёт подачу в stale по штатному протоколу, так что терять ACK незачем.
    txClient.handler = (sql) => {
      if (/FOR UPDATE/i.test(sql)) return [approvalRow()];
      if (/FROM timesheet_versions/i.test(sql)) return [{ id: 9001, revision: 2, content_hash: 'hash-v2' }];
      if (/FROM timesheet_1c_exports/i.test(sql)) return [{ acked_at: '2026-08-27T10:00:00Z', document_ref: null }];
      return [];
    };
    const res = makeRes();
    await publicTimesheetsController.ack(makeReq({ body: { revision: 2 } }), res);

    expect(res.statusCode).toBe(200);
    expect(txCalls.some(c => /INSERT INTO timesheet_1c_exports/i.test(c.sql))).toBe(true);
  });

  it('идёт пересборка — ACK отклоняется, запись не идёт', async () => {
    txClient.handler = (sql) => {
      if (/FOR UPDATE/i.test(sql)) return [approvalRow({ version_dirty_at: '2026-08-26T10:00:00Z' })];
      return [];
    };
    const res = makeRes();
    await publicTimesheetsController.ack(makeReq({ body: { revision: 2 } }), res);

    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('TIMESHEET_REBUILD_PENDING');
    expect(txCalls.some(c => /INSERT INTO timesheet_1c_exports/i.test(c.sql))).toBe(false);
  });

  it('подтверждение пишется идемпотентно и возвращает исходный acked_at', async () => {
    txClient.handler = (sql) => {
      if (/FOR UPDATE/i.test(sql)) return [approvalRow()];
      if (/SELECT id, revision, content_hash FROM timesheet_versions/i.test(sql)) {
        return [{ id: 9001, revision: 2, content_hash: 'hash-v2' }];
      }
      if (/INSERT INTO timesheet_1c_exports/i.test(sql)) return [];
      if (/SELECT acked_at/i.test(sql)) {
        return [{ acked_at: '2026-08-16T06:03:11.000Z', document_ref: 'ТАБ-000123' }];
      }
      return [];
    };

    const res = makeRes();
    await publicTimesheetsController.ack(
      makeReq({ body: { revision: 2, document_ref: 'ТАБ-000123' } }), res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload.state).toBe('exported');
    expect(res.payload.acked_at).toBe('2026-08-16T06:03:11.000Z');
    // Конкурентный повтор не должен плодить строки.
    const insert = txCalls.find(c => /INSERT INTO timesheet_1c_exports/i.test(c.sql));
    expect(insert?.sql).toContain('ON CONFLICT (version_id) DO NOTHING');
  });
});

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function baseRow(over: Record<string, unknown> = {}) {
  return {
    approval_id: APPROVAL_ID,
    department_id: 'dept-1',
    department_name: 'бр. Иванова',
    manager_employee_id: null,
    start_date: '2026-08-01',
    end_date: '2026-08-15',
    version_id: 10,
    revision: 3,
    content_hash: 'hash',
    employees_count: 5,
    total_hours: '400',
    version_created_at: '2026-08-16T09:12:44.000Z',
    acked_version_id: null,
    acked_revision: null,
    acked_at: null,
    document_ref: null,
    ...over,
  };
}


/**
 * Объектная разбивка: отдельный метод, читающий замороженный снимок редакции.
 * Проверяем то, на что опирается 1С: без снимка и при битой настройке режима метод
 * обязан отказать, а не отдать часы, которые нельзя проводить.
 */
describe('objects', () => {
  const objectsVersionRow = (over: Record<string, unknown> = {}) => ({
    id: 9001,
    revision: 2,
    content_hash: 'hash-v2',
    created_at: '2026-08-16T09:12:44.000Z',
    start_date: '2026-08-01',
    end_date: '2026-08-15',
    scope: { kind: 'personal', department_id: null, manager_employee_id: 2617 },
    objects_payload: {
      employees: [{
        employee_id: 2617,
        full_name: 'Иванов И. И.',
        mode: 'skud',
        total_hours: 8,
        objects: [{
          object_id: 'obj-a',
          object_key: 'obj-a',
          object_name: 'ЖК Примавера К14',
          object_address: 'Примавера, адрес',
          total_hours: 8,
          days: { '2026-08-03': 8 },
        }],
      }],
    },
    objects_content_hash: 'objhash-v2',
    objects_employees_count: 1,
    config_errors: [],
    ...over,
  });

  it('403, если ключу не открыта таблица employees', async () => {
    getKeyTables.mockResolvedValue([]);
    const res = makeRes();
    await publicTimesheetsController.objects(makeReq(), res);
    expect(res.statusCode).toBe(403);
  });

  it('404 на несуществующую подачу', async () => {
    pgQueryOne.mockResolvedValueOnce(null);
    const res = makeRes();
    await publicTimesheetsController.objects(makeReq(), res);
    expect(res.statusCode).toBe(404);
  });

  it('409 TIMESHEET_NOT_APPROVED, если подача больше не утверждена', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow({ status: 'submitted' }));
    const res = makeRes();
    await publicTimesheetsController.objects(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('TIMESHEET_NOT_APPROVED');
  });

  it('409 TIMESHEET_REBUILD_PENDING во время аварийной пересборки', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow({ version_dirty_at: '2026-08-16T09:00:00.000Z' }));
    const res = makeRes();
    await publicTimesheetsController.objects(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('TIMESHEET_REBUILD_PENDING');
  });

  it('409 VERSION_NOT_AVAILABLE, если редакции нет', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow()).mockResolvedValueOnce(null);
    const res = makeRes();
    await publicTimesheetsController.objects(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('VERSION_NOT_AVAILABLE');
  });

  it('409 OBJECT_BREAKDOWN_NOT_AVAILABLE у редакции старше внедрения', async () => {
    // Снимок не сформирован. ACK по такой редакции слать нельзя — подача уйдёт из
    // очереди, а объектные строки в документ так и не попадут.
    pgQueryOne
      .mockResolvedValueOnce(approvalRow())
      .mockResolvedValueOnce(objectsVersionRow({ objects_content_hash: null, objects_payload: null }));
    const res = makeRes();
    await publicTimesheetsController.objects(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('OBJECT_BREAKDOWN_NOT_AVAILABLE');
  });

  it('409 INVALID_EXPORT_MODE_CONFIG со списком сотрудников при битой настройке', async () => {
    pgQueryOne
      .mockResolvedValueOnce(approvalRow())
      .mockResolvedValueOnce(objectsVersionRow({
        config_errors: [{ employee_id: 501, code: 'PINNED_OBJECT_MISSING', message: 'нет объекта' }],
      }));
    const res = makeRes();
    await publicTimesheetsController.objects(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('INVALID_EXPORT_MODE_CONFIG');
    expect(res.payload.employees).toHaveLength(1);
  });

  it('отдаёт снимок с обоими хэшами и часами по объектам', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow()).mockResolvedValueOnce(objectsVersionRow());
    const res = makeRes();
    await publicTimesheetsController.objects(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.revision).toBe(2);
    expect(res.payload.timesheet_content_hash).toBe('hash-v2');
    expect(res.payload.objects_content_hash).toBe('objhash-v2');
    expect(res.payload.employees[0].objects[0].days).toEqual({ '2026-08-03': 8 });
    expect(res.payload.meta.employees_count).toBe(1);
  });

  it('?revision=N адресует конкретную редакцию', async () => {
    pgQueryOne.mockResolvedValueOnce(approvalRow()).mockResolvedValueOnce(objectsVersionRow({ revision: 1 }));
    const res = makeRes();
    await publicTimesheetsController.objects(
      makeReq({ query: { revision: '1' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload.revision).toBe(1);
    const versionCall = pgQueryOne.mock.calls[1]!;
    expect(String(versionCall[0])).toContain('AND v.revision = $2');
    expect(versionCall[1]).toEqual([APPROVAL_ID, 1]);
  });

  it('нечисловой revision — 400', async () => {
    const res = makeRes();
    await publicTimesheetsController.objects(makeReq({ query: { revision: 'abc' } }), res);
    expect(res.statusCode).toBe(400);
  });
});
