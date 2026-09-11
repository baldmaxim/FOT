import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

/**
 * Integration-набор чёрного списка (миграция 273) на РЕАЛЬНОМ PostgreSQL.
 *
 * Здесь проверяются гарантии, которые даёт сама СУБД и которые на моках
 * непроверяемы: функция norm_person_name и её паритет с TS, частичные
 * unique-индексы, CHECK-ограничения, дедупликация целей.
 *
 * Запуск: DATABASE_URL_TEST=postgres://... npm run test:integration
 * Без переменной набор скипается — на обычном npm test БД не нужна.
 */
const CONNECTION = process.env.DATABASE_URL_TEST;
const describeIf = CONNECTION ? describe : describe.skip;

/** Канон нормализации ФИО в TS (копия normalizeNameForHash). */
const normalizeNameTs = (value: string): string | null => {
  const n = String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/ё/gi, 'е').toLowerCase();
  return n || null;
};

describeIf('чёрный список: гарантии СУБД', () => {
  let pool: Pool;
  const createdIds: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: CONNECTION });
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await pool.query('DELETE FROM public.person_blacklist WHERE id = ANY($1::uuid[])', [createdIds]);
    }
    await pool.end();
  });

  const insert = async (fields: Record<string, unknown>): Promise<string> => {
    const cols = ['full_name', 'reason', 'created_by_name', ...Object.keys(fields)];
    const vals = ['Тест ЧС Интеграция', 'integration test', 'test', ...Object.values(fields)];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const res = await pool.query<{ id: string }>(
      `INSERT INTO public.person_blacklist (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals,
    );
    createdIds.push(res.rows[0].id);
    return res.rows[0].id;
  };

  it('norm_person_name совпадает с TS-каноном на краевых случаях', async () => {
    const samples = [
      'Иванов  Иван   Иванович', '  Королёв Пётр  ', 'КОРОЛЕВ ПЕТР',
      'Иванов, Иван', 'Ёлкин Ёж', "О'Коннор Джон", 'Ким Ир-Сен',
    ];
    const res = await pool.query<{ v: string; norm: string | null }>(
      'SELECT v, public.norm_person_name(v) AS norm FROM unnest($1::text[]) AS t(v)',
      [samples],
    );
    for (const row of res.rows) {
      expect(row.norm).toBe(normalizeNameTs(row.v));
    }
  });

  it('full_name_norm генерируется БД — нарушить канон записью нельзя', async () => {
    const id = await insert({ birth_date: '1990-01-01' });
    const res = await pool.query<{ full_name_norm: string }>(
      'SELECT full_name_norm FROM public.person_blacklist WHERE id = $1::uuid',
      [id],
    );
    expect(res.rows[0].full_name_norm).toBe(normalizeNameTs('Тест ЧС Интеграция'));
  });

  it('без идентификаторов запись не создать (identifier_ck)', async () => {
    await expect(pool.query(
      `INSERT INTO public.person_blacklist (full_name, reason, created_by_name)
       VALUES ('Тест ЧС Без Ключей', 'integration test', 'test')`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('одна активная запись на СНИЛС, после снятия можно внести заново', async () => {
    const snils = '99988877766';
    const first = await insert({ snils });

    await expect(insert({ snils })).rejects.toMatchObject({ code: '23505' });

    await pool.query(
      `UPDATE public.person_blacklist
          SET removed_at = now(), removed_by_name = 'test', removal_reason = 'integration'
        WHERE id = $1::uuid`,
      [first],
    );

    // Снятая запись остаётся историей и не мешает новому внесению.
    const second = await insert({ snils });
    expect(second).not.toBe(first);
  });

  it('email и паспорт нормализуются в generated-колонках', async () => {
    const id = await insert({ email: '  Test.Blacklist@X.RU ', passport_series_number: '45 08 № 999111' });
    const res = await pool.query<{ email_lower: string; passport_norm: string }>(
      'SELECT email_lower, passport_norm FROM public.person_blacklist WHERE id = $1::uuid',
      [id],
    );
    expect(res.rows[0].email_lower).toBe('test.blacklist@x.ru');
    expect(res.rows[0].passport_norm).toBe('4508999111');
  });

  it('одна цель на профиль Sigur — kind в ключе не участвует', async () => {
    const id = await insert({ birth_date: '1991-02-02' });
    await pool.query(
      `INSERT INTO public.person_blacklist_targets
         (blacklist_id, kind, employee_id, sigur_employee_id, match_reason)
       VALUES ($1::uuid, 'employee', 999999, 987654321, 'employee_id')`,
      [id],
    );
    // Тот же профиль как подрядный пропуск — вторая строка не появляется.
    const res = await pool.query(
      `INSERT INTO public.person_blacklist_targets
         (blacklist_id, kind, pass_id, sigur_employee_id, match_reason)
       VALUES ($1::uuid, 'contractor_pass', gen_random_uuid(), 987654321, 'passport')
       ON CONFLICT (blacklist_id, sigur_employee_id) DO NOTHING`,
      [id],
    );
    expect(res.rowCount).toBe(0);
  });

  it('kind обязан соответствовать заполненной ссылке (kind_ck)', async () => {
    const id = await insert({ birth_date: '1992-03-03' });
    await expect(pool.query(
      `INSERT INTO public.person_blacklist_targets
         (blacklist_id, kind, employee_id, sigur_employee_id, match_reason)
       VALUES ($1::uuid, 'contractor_pass', 123, 111222333, 'passport')`,
      [id],
    )).rejects.toMatchObject({ code: '23514' });
  });
});
