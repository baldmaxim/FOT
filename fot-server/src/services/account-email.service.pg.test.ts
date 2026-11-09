import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

// Смена почты для входа на настоящем PostgreSQL: блокировки FOR UPDATE OF au, up, уникальность
// lower(email), чёрный список, карточка сотрудника, allowlist и журнал — одной транзакцией.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null, failHistory: false }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
});

// История кадров проверяется своими тестами; здесь — что запись идёт в той же транзакции
// (заглушка пишет через client) и что её сбой откатывает всё.
vi.mock('./hr-profile.service.js', () => ({
  recordHistory: async (
    client: import('pg').PoolClient,
    employeeId: number,
    _event: string,
    opts: { oldValues?: Record<string, unknown> | null },
  ) => {
    await client.query('INSERT INTO hr_history_stub (employee_id, old_email) VALUES ($1, $2)', [
      employeeId,
      opts.oldValues?.email ?? null,
    ]);
    if (pg.failHistory) throw new Error('history down');
  },
}));

import { changeAccountEmail } from './account-email.service.js';

const USER = '3ffe0987-39b1-48b0-af45-2dddf8ccd907';
const OTHER = '6c1b6d2e-6a51-4c43-9a0c-6f0f5d9c2b11';
const ACTOR = '9d7b1c8e-2f4a-4a77-8d5e-0b1c2d3e4f50';
const req = { ip: '127.0.0.1', headers: { 'user-agent': 'vitest' }, socket: {} } as unknown as Request;

const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await pg.pool!.query(sql, params)).rows[0] as T;

describe.skipIf(!PG_URL)('changeAccountEmail на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP SCHEMA IF EXISTS app_auth CASCADE;
      CREATE SCHEMA app_auth;
      CREATE TABLE app_auth.users (id uuid PRIMARY KEY, email text NOT NULL, email_confirmed_at timestamptz);
      CREATE UNIQUE INDEX app_auth_users_email_lower_idx ON app_auth.users (lower(email));
      DROP TABLE IF EXISTS user_profiles, employees, system_settings, audit_logs, person_blacklist, hr_history_stub CASCADE;
      CREATE TABLE employees (id integer PRIMARY KEY, email text, updated_at timestamptz);
      CREATE TABLE user_profiles (
        id uuid PRIMARY KEY, employee_id integer REFERENCES employees(id), full_name text,
        reset_token text, reset_token_expires timestamptz);
      CREATE TABLE system_settings (
        key text PRIMARY KEY, value text, description text, is_secret boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
      CREATE TABLE audit_logs (
        id bigserial PRIMARY KEY, user_id uuid, action text NOT NULL, entity_type text, entity_id text,
        details jsonb, ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE person_blacklist (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text NOT NULL, birth_date date, snils text,
        email text, passport_series_number text, employee_id bigint, user_profile_id uuid, reason text NOT NULL,
        created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz,
        snils_digits text, email_lower text, passport_norm text, full_name_norm text);
      CREATE TABLE hr_history_stub (employee_id integer, old_email text);
    `);
  });

  beforeEach(async () => {
    pg.failHistory = false;
    await pg.pool!.query(`
      TRUNCATE app_auth.users, user_profiles, employees, system_settings, audit_logs, person_blacklist, hr_history_stub CASCADE;
      INSERT INTO employees (id, email) VALUES (42, ' OLD@su10.ru ');
      INSERT INTO app_auth.users (id, email, email_confirmed_at) VALUES
        ('${USER}', 'old@su10.ru', NULL),
        ('${OTHER}', 'busy@su10.ru', now());
      INSERT INTO user_profiles (id, employee_id, full_name, reset_token, reset_token_expires) VALUES
        ('${USER}', 42, 'Иванов', 'hash', now() + interval '1 hour'),
        ('${OTHER}', NULL, 'Петров', NULL, NULL);
      INSERT INTO system_settings (key, value) VALUES ('adaptive_testing_allowed_emails', 'a@su10.ru,old@su10.ru');
    `);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  const state = async () => ({
    login: await one<{ email: string; confirmed: boolean }>(
      `SELECT email, email_confirmed_at IS NOT NULL AS confirmed FROM app_auth.users WHERE id = $1`, [USER]),
    resetToken: (await one<{ reset_token: string | null }>('SELECT reset_token FROM user_profiles WHERE id = $1', [USER])).reset_token,
    card: (await one<{ email: string | null }>('SELECT email FROM employees WHERE id = 42')).email,
    allowlist: (await one<{ value: string }>(`SELECT value FROM system_settings WHERE key = 'adaptive_testing_allowed_emails'`)).value,
    history: (await pg.pool!.query('SELECT employee_id, old_email FROM hr_history_stub')).rows,
    audit: (await pg.pool!.query(`SELECT user_id, action, entity_id, details FROM audit_logs`)).rows,
  });

  const run = (newEmail: string) => changeAccountEmail({ req, userId: USER, newEmail, actorId: ACTOR });

  it('меняет логин, карточку, allowlist и пишет журнал одной транзакцией', async () => {
    const result = await run('New@SU10.ru');
    expect(result).toEqual({
      unchanged: false, email: 'new@su10.ru', emailConfirmed: true, cardUpdated: true, allowlistUpdated: true,
    });
    const s = await state();
    expect(s.login).toEqual({ email: 'new@su10.ru', confirmed: true });
    expect(s.resetToken).toBeNull();
    expect(s.card).toBe('new@su10.ru');
    expect(s.history).toEqual([{ employee_id: 42, old_email: ' OLD@su10.ru ' }]);
    expect(s.allowlist).toBe('a@su10.ru,new@su10.ru');
    expect(s.audit).toEqual([{
      user_id: ACTOR,
      action: 'EMAIL_CHANGED',
      entity_id: USER,
      details: { old_email: 'old@su10.ru', new_email: 'new@su10.ru', card_updated: true, allowlist_updated: true },
    }]);
  });

  it('повтор с той же почтой ничего не пишет', async () => {
    await run('new@su10.ru');
    const result = await run('new@su10.ru');
    expect(result.unchanged).toBe(true);
    expect((await state()).audit).toHaveLength(1);
  });

  it('почта занята другой учёткой (без учёта регистра) → отказ, ничего не изменено', async () => {
    await expect(run('BUSY@su10.ru')).rejects.toMatchObject({ code: 'DUPLICATE_EMAIL' });
    const s = await state();
    expect(s.login.email).toBe('old@su10.ru');
    expect(s.resetToken).toBe('hash');
    expect(s.audit).toHaveLength(0);
  });

  it('почта в активном чёрном списке → отказ; снятая запись не мешает', async () => {
    await pg.pool!.query(
      `INSERT INTO person_blacklist (full_name, email, email_lower, user_profile_id, reason, created_by_name)
       VALUES ('Сидоров', 'new@su10.ru', 'new@su10.ru', $1, 'нарушение', 'Админ')`,
      [USER],
    );
    await expect(run('new@su10.ru')).rejects.toMatchObject({ code: 'BLACKLISTED' });
    expect((await state()).login.email).toBe('old@su10.ru');

    await pg.pool!.query('UPDATE person_blacklist SET removed_at = now()');
    await expect(run('new@su10.ru')).resolves.toMatchObject({ unchanged: false });
  });

  it('сбой истории кадров → откат логина, карточки, allowlist и журнала', async () => {
    pg.failHistory = true;
    await expect(run('new@su10.ru')).rejects.toThrow('history down');
    const s = await state();
    expect(s.login).toEqual({ email: 'old@su10.ru', confirmed: false });
    expect(s.resetToken).toBe('hash');
    expect(s.card).toBe(' OLD@su10.ru ');
    expect(s.history).toHaveLength(0);
    expect(s.allowlist).toBe('a@su10.ru,old@su10.ru');
    expect(s.audit).toHaveLength(0);
  });

  it('перепривязка сотрудника ждёт конца смены почты (профиль заблокирован)', async () => {
    const locker = await pg.pool!.connect();
    try {
      await locker.query('BEGIN');
      // Держим учётку, как будто идёт смена почты; параллельная перепривязка должна ждать.
      await locker.query(
        `SELECT 1 FROM app_auth.users au JOIN user_profiles up ON up.id = au.id
          WHERE au.id = $1 FOR UPDATE OF au, up`,
        [USER],
      );
      const relink = await pg.pool!.connect();
      try {
        await relink.query(`SET lock_timeout = '200ms'`);
        await expect(relink.query('UPDATE user_profiles SET employee_id = NULL WHERE id = $1', [USER]))
          .rejects.toMatchObject({ code: '55P03' });
      } finally {
        await relink.query('RESET lock_timeout').catch(() => undefined);
        relink.release();
      }
      await locker.query('ROLLBACK');
    } finally {
      locker.release();
    }
  });
});
