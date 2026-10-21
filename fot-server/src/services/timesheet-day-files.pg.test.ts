import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// «Файлы дня» на настоящем PostgreSQL: создание, список, удаление в транзакции, отказ при
// чужой ссылке, скрытие soft-deleted. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая
// БД (таблицы пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const pool = () => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool;
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) =>
      (await pool().query(sql, params as unknown[])).rows[0] ?? null,
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

import {
  createDayFile, deleteDayFile, employeeExists, listDayFiles, loadDayFileLink,
} from './timesheet-day-files.service.js';

const run = (sql: string, params?: unknown[]) => pg.pool!.query(sql, params);

const HR = '00000000-0000-0000-0000-0000000000a1';

const create = (workDate = '2026-10-18', fileName = 'служебка.pdf') => createDayFile({
  employeeId: 10, workDate, fileName, fileSize: 100, mimeType: 'application/pdf', r2Key: `documents/10/${fileName}`, uploadedBy: HR,
});

describe.skipIf(!PG_URL)('файлы дня табеля на PostgreSQL', () => {
  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS document_links, documents, employees, user_profiles CASCADE;
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text);
      CREATE TABLE documents (
        id BIGSERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id),
        leave_request_id BIGINT,
        category TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        uploaded_by UUID NOT NULL REFERENCES user_profiles(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      );
      -- Как в миграции 020.
      CREATE TABLE document_links (
        id BIGSERIAL PRIMARY KEY,
        document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        purpose TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (document_id, entity_type, entity_id, purpose)
      );
      INSERT INTO user_profiles VALUES ('${HR}', 'Андрусевич Алина Романовна');
      INSERT INTO employees VALUES (10, 'Асроров А. А.');
    `);
  });

  beforeEach(async () => {
    await run('TRUNCATE document_links, documents RESTART IDENTITY');
  });

  afterAll(async () => {
    await run('DROP TABLE IF EXISTS document_links, documents, employees, user_profiles CASCADE');
    await pg.pool?.end();
  });

  it('создаёт документ без сотрудника и ссылку на день; список — только этого дня', async () => {
    const created = await create();
    await create('2026-10-19', 'другой день.pdf');

    const doc = await run('SELECT employee_id, category FROM documents WHERE id = $1', [created.id]);
    expect(doc.rows[0]).toEqual({ employee_id: null, category: 'timesheet_correction' });

    const files = await listDayFiles(10, '2026-10-18');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ id: created.id, original_name: 'служебка.pdf', uploader_name: 'Андрусевич Алина Романовна' });
    expect(files[0].uploaded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await loadDayFileLink(created.id)).toEqual({ employeeId: 10, workDate: '2026-10-18' });
  });

  it('удаляет документ и ссылку, возвращает ключ R2 и имя', async () => {
    const created = await create();
    expect(await deleteDayFile(created.id)).toEqual({ deleted: true, r2Key: 'documents/10/служебка.pdf', fileName: 'служебка.pdf' });
    expect((await run('SELECT COUNT(*)::int AS n FROM documents')).rows[0].n).toBe(0);
    expect((await run('SELECT COUNT(*)::int AS n FROM document_links')).rows[0].n).toBe(0);
    expect(await listDayFiles(10, '2026-10-18')).toEqual([]);
  });

  it('при чужой ссылке ничего не удаляет', async () => {
    const created = await create();
    await run(`INSERT INTO document_links (document_id, entity_type, entity_id, purpose) VALUES ($1, 'leave_request', '77', 'scan')`, [created.id]);
    expect(await deleteDayFile(created.id)).toEqual({ deleted: false, r2Key: null, fileName: null });
    expect((await run('SELECT COUNT(*)::int AS n FROM document_links')).rows[0].n).toBe(2);
    expect((await run('SELECT COUNT(*)::int AS n FROM documents')).rows[0].n).toBe(1);
  });

  it('документ сотрудника (employee_id задан) не удаляет', async () => {
    const created = await create();
    await run('UPDATE documents SET employee_id = 10 WHERE id = $1', [created.id]);
    expect((await deleteDayFile(created.id)).deleted).toBe(false);
    expect((await run('SELECT COUNT(*)::int AS n FROM documents')).rows[0].n).toBe(1);
  });

  it('soft-deleted не показывается и не находится по ссылке', async () => {
    const created = await create();
    await run('UPDATE documents SET deleted_at = NOW() WHERE id = $1', [created.id]);
    expect(await listDayFiles(10, '2026-10-18')).toEqual([]);
    expect(await loadDayFileLink(created.id)).toBeNull();
  });

  it('employeeExists различает сотрудников', async () => {
    expect(await employeeExists(10)).toBe(true);
    expect(await employeeExists(999999)).toBe(false);
  });
});
