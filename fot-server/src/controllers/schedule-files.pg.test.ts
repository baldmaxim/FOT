import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Response } from 'express';

// Файлы графиков (миграция 376) на настоящем PostgreSQL: предел файлов и архив держит блокировка строки
// графика, а её видно только на живых транзакциях. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ
// тестовая БД. Таблицы — в своей схеме schedule_files_pg_test (search_path). В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;
const SCHEMA = 'schedule_files_pg_test';

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL
    ? new Pool({
      connectionString: process.env.FOT_TEST_PG_URL,
      options: '-c search_path=schedule_files_pg_test',
      max: 8,
    })
    : null;
  const pool = (): import('pg').Pool => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool;
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows[0] ?? null,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
});

const { r2Mock } = vi.hoisted(() => ({
  r2Mock: {
    isEnabledAsync: vi.fn(async () => true),
    generateWorkScheduleKey: vi.fn(),
    uploadObject: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
    generateDownloadUrl: vi.fn(async () => 'https://signed'),
  },
}));
vi.mock('../services/r2.service.js', () => ({ r2Service: r2Mock }));
const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequestWithClient: auditMock },
  AUDIT_ACTIONS: { WORK_SCHEDULE_FILE_UPLOADED: 'U', WORK_SCHEDULE_FILE_DELETED: 'D' },
}));

import { scheduleFilesController as c } from './schedule-files.controller.js';

const MIGRATIONS = join(process.cwd(), '..', 'docs');
// Миграция и откат пишут public.work_schedule_files — в тестовой схеме имя без схемы.
const readSql = (path: string): string =>
  readFileSync(join(MIGRATIONS, path), 'utf8').replaceAll('public.work_schedule_files', 'work_schedule_files');
const MIGRATION_SQL = readSql('migrations/376_work_schedule_files.sql');
const ROLLBACK_SQL = readSql('rollbacks/376_work_schedule_files_rollback.sql');

const exec = async (sql: string, params?: unknown[]) => {
  if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
  return pg.pool.query(sql, params);
};

type ResMock = Response & { statusCode: number; body: unknown };
const makeRes = (): ResMock => {
  const res = {} as ResMock;
  res.statusCode = 200;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as never;
  res.json = vi.fn((payload: unknown) => { res.body = payload; return res; }) as never;
  return res;
};

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);
const uploadReq = (scheduleId: string): never => ({
  params: { id: scheduleId },
  query: {},
  file: { originalname: 'prikaz.pdf', mimetype: 'application/pdf', size: PDF.length, buffer: PDF },
  user: { id: 'editor' },
  headers: {},
  socket: {},
} as never);

let keySeq = 0;
const newSchedule = async (): Promise<string> =>
  (await exec(`INSERT INTO work_schedules (name) VALUES ('График') RETURNING id`)).rows[0].id as string;
const seedFiles = async (scheduleId: string, count: number): Promise<void> => {
  for (let i = 0; i < count; i += 1) {
    keySeq += 1;
    await exec(
      `INSERT INTO work_schedule_files (schedule_id, r2_key, file_name, file_size, mime_type)
       VALUES ($1, $2, 'f.pdf', 10, 'application/pdf')`,
      [scheduleId, `seed/${keySeq}`],
    );
  }
};
const fileCount = async (scheduleId: string): Promise<number> =>
  Number((await exec('SELECT count(*)::int AS n FROM work_schedule_files WHERE schedule_id = $1', [scheduleId])).rows[0].n);

describe.skipIf(!PG_URL)('файлы графиков на PostgreSQL', () => {
  beforeAll(async () => {
    await exec(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.work_schedules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        is_default boolean NOT NULL DEFAULT false,
        archived_at timestamptz
      );
      CREATE TABLE ${SCHEMA}.schema_migrations (filename text PRIMARY KEY);
    `);
    await exec(MIGRATION_SQL);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    auditMock.mockImplementation(async () => undefined);
    r2Mock.generateWorkScheduleKey.mockImplementation((id: string, ext: string) => {
      keySeq += 1;
      return `work-schedules/${id}/${keySeq}${ext}`;
    });
  });

  afterAll(async () => {
    if (!pg.pool) return;
    await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pg.pool.end();
  });

  it('повторный прогон миграции безопасен', async () => {
    await expect(exec(MIGRATION_SQL)).resolves.toBeDefined();
  });

  it('CHECK и NOT NULL отсекают пустые и чрезмерные значения', async () => {
    const id = await newSchedule();
    const insert = (r2Key: string | null, name: string | null, size: number | null, mime: string | null) => exec(
      `INSERT INTO work_schedule_files (schedule_id, r2_key, file_name, file_size, mime_type) VALUES ($1, $2, $3, $4, $5)`,
      [id, r2Key, name, size, mime],
    );
    await expect(insert(' ', 'a.pdf', 10, 'application/pdf')).rejects.toThrow(/work_schedule_file_r2_key/);
    await expect(insert(null, 'a.pdf', 10, 'application/pdf')).rejects.toThrow(/null value/);
    await expect(insert('k1', ' ', 10, 'application/pdf')).rejects.toThrow(/work_schedule_file_name/);
    await expect(insert('k2', `${'я'.repeat(197)}.pdf`, 10, 'application/pdf')).rejects.toThrow(/work_schedule_file_name/);
    await expect(insert('k3', 'a.pdf', 0, 'application/pdf')).rejects.toThrow(/work_schedule_file_size/);
    await expect(insert('k4', 'a.pdf', 25 * 1024 * 1024 + 1, 'application/pdf')).rejects.toThrow(/work_schedule_file_size/);
    await expect(insert('k5', 'a.pdf', 10, ' ')).rejects.toThrow(/work_schedule_file_mime/);
    await expect(insert('k6', 'a.pdf', 10, 'application/pdf')).resolves.toBeDefined();
    await expect(insert('k6', 'b.pdf', 10, 'application/pdf')).rejects.toThrow(/duplicate key/);
    await expect(exec(
      `INSERT INTO work_schedule_files (schedule_id, r2_key, file_name, file_size, mime_type)
       VALUES (gen_random_uuid(), 'k7', 'a.pdf', 10, 'application/pdf')`,
    )).rejects.toThrow(/foreign key/);
  });

  it('при 19 файлах из трёх параллельных загрузок проходит ровно одна', async () => {
    const id = await newSchedule();
    await seedFiles(id, 19);
    // Аудит идёт после вставки, до коммита: пауза в нём держит транзакцию открытой. Без блокировки
    // графика соседняя загрузка успела бы посчитать 19 файлов и вставить 21-й.
    auditMock.mockImplementation(() => new Promise<undefined>(resolve => { setTimeout(() => resolve(undefined), 50); }));
    const responses = [makeRes(), makeRes(), makeRes()];
    await Promise.all(responses.map(res => c.upload(uploadReq(id), res)));

    const statuses = responses.map(res => res.statusCode).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(await fileCount(id)).toBe(20);
    // Объекты отклонённых загрузок удалены из R2.
    expect(r2Mock.uploadObject).toHaveBeenCalledTimes(3);
    expect(r2Mock.deleteObject).toHaveBeenCalledTimes(2);
  });

  it('загрузка ждёт архивацию, держащую блокировку графика, и получает 409', async () => {
    const id = await newSchedule();
    if (!pg.pool) throw new Error('нет пула');
    const archiver = await pg.pool.connect();
    try {
      // Как archiveScheduleTemplate: FOR UPDATE строки графика, затем archived_at.
      await archiver.query('BEGIN');
      await archiver.query('SELECT archived_at FROM work_schedules WHERE id = $1 FOR UPDATE', [id]);
      await archiver.query('UPDATE work_schedules SET archived_at = now() WHERE id = $1', [id]);

      const res = makeRes();
      const pending = c.upload(uploadReq(id), res);
      // Предпроверка видит график действующим (архив не закоммичен), файл уже в R2, транзакция ждёт блокировку.
      await vi.waitFor(() => expect(r2Mock.uploadObject).toHaveBeenCalledTimes(1));
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(res.json).not.toHaveBeenCalled();

      await archiver.query('COMMIT');
      await pending;
      expect(res.statusCode).toBe(409);
      expect(await fileCount(id)).toBe(0);
      expect(r2Mock.deleteObject).toHaveBeenCalledTimes(1);
    } finally {
      archiver.release();
    }
  });

  it('список: в порядке прикрепления; нет графика — 404', async () => {
    const id = await newSchedule();
    await seedFiles(id, 3);
    const res = makeRes();
    await c.list({ params: { id } } as never, res);
    const ids = (res.body as { data: { id: number }[] }).data.map(file => file.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids).toHaveLength(3);

    const missing = makeRes();
    await c.list({ params: { id: '00000000-0000-4000-8000-000000000000' } } as never, missing);
    expect(missing.statusCode).toBe(404);
  });

  it('удаление строки графика уносит его файлы каскадом', async () => {
    const id = await newSchedule();
    await seedFiles(id, 2);
    await exec('DELETE FROM work_schedules WHERE id = $1', [id]);
    expect(await fileCount(id)).toBe(0);
  });

  it('откат: на непустой таблице падает, на пустой — удаляет таблицу и отметку миграции', async () => {
    const id = await newSchedule();
    await seedFiles(id, 1);
    await exec(`INSERT INTO schema_migrations (filename) VALUES ('376_work_schedule_files.sql') ON CONFLICT DO NOTHING`);

    if (!pg.pool) throw new Error('нет пула');
    // Отдельное соединение: после ошибки внутри BEGIN транзакцию надо закрыть на нём же.
    const rollbackClient = await pg.pool.connect();
    try {
      await expect(rollbackClient.query(ROLLBACK_SQL)).rejects.toThrow(/work_schedule_files: \d+ файл/);
      await rollbackClient.query('ROLLBACK');
    } finally {
      rollbackClient.release();
    }
    expect(Number((await exec('SELECT count(*)::int AS n FROM work_schedule_files')).rows[0].n)).toBeGreaterThan(0);

    await exec('DELETE FROM work_schedule_files');
    await exec(ROLLBACK_SQL);
    expect((await exec(`SELECT to_regclass('${SCHEMA}.work_schedule_files') AS t`)).rows[0].t).toBeNull();
    expect((await exec(`SELECT count(*)::int AS n FROM schema_migrations WHERE filename = '376_work_schedule_files.sql'`)).rows[0].n).toBe(0);

    // Повторное применение после отката.
    await exec(MIGRATION_SQL);
    expect((await exec(`SELECT to_regclass('${SCHEMA}.work_schedule_files') AS t`)).rows[0].t).not.toBeNull();
  });
});
