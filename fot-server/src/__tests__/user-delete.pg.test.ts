import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Политика ON DELETE у FK на пользователя (миграция 284) на РЕАЛЬНОМ PostgreSQL.
 *
 * Проверяется то, что на моках непроверяемо: удаление учётки не падает на FK,
 * деловые строки остаются и перевешиваются на надгробный профиль, строки
 * владения уходят, а колонка вне политики ловится аудитом и даёт 23503, а не
 * тихую потерю данных.
 *
 * Запуск: FOT_TEST_PG_URL=postgres://... npx vitest run src/__tests__/user-delete.pg.test.ts
 * Без переменной набор скипается — обычному npm test БД не нужна.
 */
const PG_URL = process.env.FOT_TEST_PG_URL;
const describeIf = PG_URL ? describe : describe.skip;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration284 = (): string => readFileSync(`${MIGRATIONS_DIR}284_user_delete_tombstone.sql`, 'utf8');
const migration285 = (): string => readFileSync(`${MIGRATIONS_DIR}285_user_delete_tombstone_nullable_fix.sql`, 'utf8');

const TOMB = '00000000-0000-0000-0000-00000000dead';
const USER = '11111111-1111-1111-1111-111111111111';

/** Срез схемы FOT: по одной таблице на каждую политику, включая обе мины. */
const SLICE_SQL = `
DROP TABLE IF EXISTS audit_logs, chat_messages, documents, contractor_submissions, hiring_requests,
                     leave_request_history, leave_requests, adaptive_test_sessions,
                     timesheet_reminder_log, push_subscriptions, user_profiles, system_roles CASCADE;
DROP SCHEMA IF EXISTS app_auth CASCADE;

CREATE SCHEMA app_auth;
CREATE TABLE app_auth.users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  is_disabled boolean NOT NULL DEFAULT false
);
CREATE TABLE system_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false
);
INSERT INTO system_roles (code, name, is_admin) VALUES ('worker', 'Рабочий', false);
CREATE TABLE user_profiles (
  id uuid PRIMARY KEY REFERENCES app_auth.users(id) ON DELETE CASCADE,
  full_name text,
  is_approved boolean DEFAULT false,
  system_role_id uuid NOT NULL REFERENCES system_roles(id),
  supervisor_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  employee_id integer
);
-- владение
CREATE TABLE push_subscriptions (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL
);
CREATE TABLE timesheet_reminder_log (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  stage text
);
-- keep_null
CREATE TABLE adaptive_test_sessions (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL
);
-- авторство, сегодня блокирующее удаление (NO ACTION по умолчанию)
CREATE TABLE leave_requests (
  id bigserial PRIMARY KEY,
  employee_id integer,
  status text,
  reviewer_id uuid REFERENCES user_profiles(id) ON DELETE CASCADE,
  cancelled_by uuid REFERENCES user_profiles(id),
  hr_acknowledged_by uuid REFERENCES user_profiles(id)
);
CREATE TABLE leave_request_history (
  id bigserial PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  action text,
  actor_id uuid REFERENCES user_profiles(id)
);
CREATE TABLE hiring_requests (
  id bigserial PRIMARY KEY,
  title text,
  author_user_id uuid NOT NULL REFERENCES user_profiles(id)
);
-- авторство: SET NULL на NOT NULL — упало бы с 23502
CREATE TABLE contractor_submissions (
  id bigserial PRIMARY KEY,
  submitted_by uuid NOT NULL REFERENCES user_profiles(id) ON DELETE SET NULL
);
-- авторство, сегодня CASCADE на чужих данных
CREATE TABLE documents (
  id bigserial PRIMARY KEY,
  file_name text,
  uploaded_by uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE
);
CREATE TABLE chat_messages (
  id bigserial PRIMARY KEY,
  body text,
  sender_id uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE
);
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  action text,
  user_id uuid REFERENCES app_auth.users(id) ON DELETE CASCADE
);
`;

/** Каждый INSERT — отдельным запросом: pg не принимает multi-statement с параметрами. */
const SEED_STATEMENTS: string[] = [
  `INSERT INTO app_auth.users (id, email, password_hash) VALUES ($1, 'user@example.com', 'hash')`,
  `INSERT INTO user_profiles (id, full_name, is_approved, system_role_id, employee_id)
   SELECT $1, 'Царев Юрий Анатольевич', true, id, 2051 FROM system_roles WHERE code = 'worker'`,
  `INSERT INTO push_subscriptions (user_id, endpoint) VALUES ($1, 'https://push/ep1')`,
  `INSERT INTO timesheet_reminder_log (user_id, stage) VALUES ($1, 'h1')`,
  `INSERT INTO adaptive_test_sessions (user_id) VALUES ($1)`,
  `INSERT INTO leave_requests (id, employee_id, status, reviewer_id, cancelled_by)
   VALUES (6803, 2051, 'cancelled', $1, $1)`,
  `INSERT INTO leave_request_history (id, request_id, action, actor_id) VALUES (590, 6803, 'cancelled', $1)`,
  `INSERT INTO hiring_requests (title, author_user_id) VALUES ('Нужен сварщик', $1)`,
  `INSERT INTO contractor_submissions (submitted_by) VALUES ($1)`,
  `INSERT INTO documents (file_name, uploaded_by) VALUES ('скан паспорта.pdf', $1)`,
  `INSERT INTO chat_messages (body, sender_id) VALUES ('Табель закрыт', $1)`,
  `INSERT INTO audit_logs (action, user_id) VALUES ('USER_LOGIN', $1)`,
];

const CLEANUP_STATEMENTS: string[] = [
  'DELETE FROM audit_logs',
  'DELETE FROM chat_messages',
  'DELETE FROM documents',
  'DELETE FROM contractor_submissions',
  'DELETE FROM hiring_requests',
  'DELETE FROM leave_request_history',
  'DELETE FROM leave_requests',
  'DELETE FROM adaptive_test_sessions',
  'DELETE FROM timesheet_reminder_log',
  'DELETE FROM push_subscriptions',
  'DELETE FROM user_profiles WHERE id <> $1::uuid',
  'DELETE FROM app_auth.users WHERE id <> $1::uuid',
];

describeIf('удаление пользователя: политика FK (миграция 284)', () => {
  let pool: Pool;

  const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> =>
    (await pool.query<T>(sql, params)).rows;

  const seed = async (): Promise<void> => {
    for (const sql of CLEANUP_STATEMENTS) await q(sql, sql.includes('$1') ? [TOMB] : undefined);
    for (const sql of SEED_STATEMENTS) await q(sql, [USER]);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    await q(SLICE_SQL);
    await q(migration284());
    await q(migration285());
    // Один сценарий на всю группу: заполнили спутниками и удалили учётку.
    await seed();
    await q('DELETE FROM app_auth.users WHERE id = $1::uuid', [USER]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('повторное применение ничего не меняет (идемпотентность)', async () => {
    const policies = async (): Promise<string> => {
      const [row] = await q<{ n: string }>(
        `SELECT string_agg(c.conrelid::regclass::text || '.' || a.attname || ':' || c.confdeltype::text, ',' ORDER BY 1) AS n
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype='f'
            AND c.confrelid IN ('public.user_profiles'::regclass,'app_auth.users'::regclass)`,
      );
      return row.n;
    };
    const before = await policies();
    await q(migration284());
    await q(migration285());
    expect(await policies()).toBe(before);
    const [tomb] = await q<{ full_name: string }>('SELECT full_name FROM user_profiles WHERE id = $1::uuid', [TOMB]);
    expect(tomb.full_name).toBe('Удалённый пользователь');
  });

  /**
   * Регресс, пойманный на проде после 284: заявка 8671 приехала с тремя
   * «призрачными» авторами, потому что INSERT эти колонки не перечисляет, а
   * DEFAULT перестал быть NULL. Проверяем именно путь вставки, а не удаления.
   */
  it('вставка без автора оставляет NULL, а не надгробие', async () => {
    await q(`INSERT INTO leave_requests (id, employee_id, status) VALUES (8671, 2053, 'pending')`);
    try {
      const [row] = await q<{ reviewer_id: string | null; cancelled_by: string | null; hr_acknowledged_by: string | null }>(
        'SELECT reviewer_id, cancelled_by, hr_acknowledged_by FROM leave_requests WHERE id = 8671',
      );
      expect(row).toEqual({ reviewer_id: null, cancelled_by: null, hr_acknowledged_by: null });
    } finally {
      await q('DELETE FROM leave_requests WHERE id = 8671');
    }
  });

  /**
   * Сохранность данных: 285 только снимает DEFAULT, меняет политику ссылки и
   * возвращает NULL там, где надгробие приехало из DEFAULT. Ни одна строка не
   * должна исчезнуть — проверяем счётчики по всем таблицам среза.
   */
  it('повторное применение 285 не удаляет ни одной строки', async () => {
    const counts = async (): Promise<Record<string, string>> => {
      const [row] = await q<Record<string, string>>(
        `SELECT (SELECT count(*)::text FROM leave_requests) AS lr,
                (SELECT count(*)::text FROM leave_request_history) AS history,
                (SELECT count(*)::text FROM hiring_requests) AS hiring,
                (SELECT count(*)::text FROM contractor_submissions) AS submissions,
                (SELECT count(*)::text FROM documents) AS docs,
                (SELECT count(*)::text FROM chat_messages) AS messages,
                (SELECT count(*)::text FROM audit_logs) AS audit,
                (SELECT count(*)::text FROM adaptive_test_sessions) AS sessions,
                (SELECT count(*)::text FROM user_profiles) AS profiles`,
      );
      return row;
    };
    const before = await counts();
    await q(migration285());
    expect(await counts()).toEqual(before);
  });

  it('ни одна колонка с NULL не несёт DEFAULT-надгробие', async () => {
    const rows = await q<{ tbl: string; col: string }>(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype='f'
          AND c.confrelid IN ('public.user_profiles'::regclass,'app_auth.users'::regclass)
          AND NOT a.attnotnull
          AND COALESCE((SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
                         WHERE d.adrelid = c.conrelid AND d.adnum = a.attnum), '')
              = '''00000000-0000-0000-0000-00000000dead''::uuid'`,
    );
    expect(rows).toEqual([]);
  });

  it('учётка удаляется, а деловые строки остаются на месте', async () => {
    const [gone] = await q<{ n: string }>(
      'SELECT count(*)::text AS n FROM app_auth.users WHERE id = $1::uuid', [USER],
    );
    expect(gone.n).toBe('0');

    const [row] = await q<Record<string, string>>(
      `SELECT (SELECT count(*)::text FROM leave_requests WHERE id = 6803) AS lr,
              (SELECT count(*)::text FROM leave_request_history WHERE id = 590) AS history,
              (SELECT count(*)::text FROM hiring_requests) AS hiring,
              (SELECT count(*)::text FROM documents) AS docs,
              (SELECT count(*)::text FROM chat_messages) AS messages,
              (SELECT count(*)::text FROM audit_logs) AS audit,
              (SELECT count(*)::text FROM contractor_submissions) AS submissions`,
    );
    expect(row).toEqual({
      lr: '1', history: '1', hiring: '1', docs: '1', messages: '1', audit: '1', submissions: '1',
    });
  });

  it('обязательные поля автора переходят на надгробие, необязательные обнуляются', async () => {
    const [row] = await q<Record<string, string | null>>(
      `SELECT (SELECT uploaded_by::text FROM documents LIMIT 1) AS docs_not_null,
              (SELECT sender_id::text FROM chat_messages LIMIT 1) AS chat_not_null,
              (SELECT author_user_id::text FROM hiring_requests LIMIT 1) AS hiring_not_null,
              (SELECT submitted_by::text FROM contractor_submissions LIMIT 1) AS submission_not_null,
              (SELECT cancelled_by::text FROM leave_requests WHERE id = 6803) AS lr_cancelled_nullable,
              (SELECT reviewer_id::text FROM leave_requests WHERE id = 6803) AS lr_reviewer_nullable,
              (SELECT actor_id::text FROM leave_request_history WHERE id = 590) AS history_nullable,
              (SELECT user_id::text FROM audit_logs LIMIT 1) AS audit_nullable`,
    );
    expect(row).toEqual({
      docs_not_null: TOMB,
      chat_not_null: TOMB,
      hiring_not_null: TOMB,
      submission_not_null: TOMB,
      lr_cancelled_nullable: null,
      lr_reviewer_nullable: null,
      history_nullable: null,
      audit_nullable: null,
    });
  });

  it('NOT NULL-колонка автора не роняет удаление (была мина 23502)', async () => {
    const [row] = await q<{ total: string; on_tomb: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE submitted_by = $1::uuid)::text AS on_tomb
         FROM contractor_submissions`,
      [TOMB],
    );
    expect(row).toEqual({ total: '1', on_tomb: '1' });
  });

  it('строки владения уходят вместе с учёткой, keep_null обнуляется', async () => {
    const [row] = await q<{ push: string; reminders: string; sessions_null: string; profiles: string }>(
      `SELECT (SELECT count(*)::text FROM push_subscriptions) AS push,
              (SELECT count(*)::text FROM timesheet_reminder_log) AS reminders,
              (SELECT count(*)::text FROM adaptive_test_sessions WHERE user_id IS NULL) AS sessions_null,
              (SELECT count(*)::text FROM user_profiles) AS profiles`,
    );
    // В user_profiles остаётся только само надгробие.
    expect(row).toEqual({ push: '0', reminders: '0', sessions_null: '1', profiles: '1' });
  });

  it('в интерфейсе: у обязательных полей — «Удалённый пользователь», у необязательных — пусто', async () => {
    const [row] = await q<{ cancelled_by_name: string | null; uploaded_by_name: string | null }>(
      `SELECT (SELECT full_name FROM user_profiles WHERE id = lr.cancelled_by) AS cancelled_by_name,
              (SELECT full_name FROM user_profiles WHERE id = d.uploaded_by) AS uploaded_by_name
         FROM leave_requests lr, documents d
        WHERE lr.id = 6803`,
    );
    expect(row.uploaded_by_name).toBe('Удалённый пользователь');
    expect(row.cancelled_by_name).toBeNull();
  });

  it('надгробие удалить нельзя: авторские ссылки держат его как родителя', async () => {
    await expect(pool.query('DELETE FROM app_auth.users WHERE id = $1::uuid', [TOMB]))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('колонка вне политики снова блокирует удаление — и её ловит аудит', async () => {
    await q(`CREATE TABLE IF NOT EXISTS new_feature_notes (
               id bigserial PRIMARY KEY, note text,
               created_by uuid NOT NULL REFERENCES user_profiles(id))`);
    try {
      await q(`INSERT INTO app_auth.users (id, email, password_hash) VALUES ($1, 'x@example.com', 'h')`, [USER]);
      await q(`INSERT INTO user_profiles (id, full_name, is_approved, system_role_id)
               SELECT $1, 'Новый', true, id FROM system_roles WHERE code = 'worker'`, [USER]);
      await q('INSERT INTO new_feature_notes (note, created_by) VALUES ($1, $2)', ['заметка', USER]);

      // Ровно тот сценарий, который сейчас видит Андрусевич: 23503 из БД.
      await expect(pool.query('DELETE FROM app_auth.users WHERE id = $1::uuid', [USER]))
        .rejects.toMatchObject({ code: '23503' });

      const { auditRows } = await import('../../scripts/audit-user-fk.js');
      const rows = await q<never>(
        `SELECT n.nspname AS schema, t.relname AS table, a.attname AS column,
                fn.nspname || '.' || ft.relname AS target, c.conname AS constraint_name,
                c.confdeltype::text AS del, a.attnotnull AS not_null,
                pg_get_expr(d.adbin, d.adrelid) AS column_default
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_class ft ON ft.oid = c.confrelid
           JOIN pg_namespace fn ON fn.oid = ft.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
           LEFT JOIN pg_attrdef d ON d.adrelid = c.conrelid AND d.adnum = a.attnum
          WHERE c.contype = 'f'
            AND c.confrelid IN ('public.user_profiles'::regclass, 'app_auth.users'::regclass)
            AND array_length(c.conkey, 1) = 1`,
      );
      const violations = auditRows(rows);
      expect(violations.map(v => v.key)).toEqual(['public.new_feature_notes.created_by']);
    } finally {
      await q('DROP TABLE IF EXISTS new_feature_notes');
      await q('DELETE FROM app_auth.users WHERE id = $1::uuid', [USER]);
    }
  });

  it('после миграции нарушений политики нет', async () => {
    const { auditRows } = await import('../../scripts/audit-user-fk.js');
    const rows = await q<never>(
      `SELECT n.nspname AS schema, t.relname AS table, a.attname AS column,
              fn.nspname || '.' || ft.relname AS target, c.conname AS constraint_name,
              c.confdeltype::text AS del, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS column_default
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_class ft ON ft.oid = c.confrelid
         JOIN pg_namespace fn ON fn.oid = ft.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         LEFT JOIN pg_attrdef d ON d.adrelid = c.conrelid AND d.adnum = a.attnum
        WHERE c.contype = 'f'
          AND c.confrelid IN ('public.user_profiles'::regclass, 'app_auth.users'::regclass)
          AND array_length(c.conkey, 1) = 1`,
    );
    expect(auditRows(rows)).toEqual([]);
  });
});
