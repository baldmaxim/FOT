import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('условие на держателя пропуска отсекает чужие документы, но терпит регистр и ё', async () => {
    // На нём держится автозаполнение паспорта штатного сотрудника из пропуска:
    // профиль пропуска переиспользуется из пула и хранит паспорт прежнего держателя.
    const res = await pool.query<{ same: boolean; other: boolean }>(
      `SELECT public.norm_person_name('Королёв  Пётр') = public.norm_person_name('КОРОЛЕВ ПЕТР') AS same,
              public.norm_person_name('Королёв Пётр')  = public.norm_person_name('Петров Иван')  AS other`,
    );
    expect(res.rows[0].same).toBe(true);
    expect(res.rows[0].other).toBe(false);
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

/**
 * Служебные записки (миграция 274). R2 здесь не участвует: объект хранилища —
 * забота контроллера, а гарантии сохранности строк даёт сама СУБД.
 */
describeIf('служебные записки: гарантии СУБД', () => {
  let pool: Pool;
  const entryIds: string[] = [];
  const authUserIds: string[] = [];

  const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex');

  beforeAll(() => {
    pool = new Pool({ connectionString: CONNECTION });
  });

  afterAll(async () => {
    // RESTRICT: сначала записки, потом записи, потом тестовые учётки.
    if (entryIds.length > 0) {
      await pool.query('DELETE FROM public.person_blacklist_memos WHERE blacklist_id = ANY($1::uuid[])', [entryIds]);
      await pool.query('DELETE FROM public.person_blacklist WHERE id = ANY($1::uuid[])', [entryIds]);
    }
    if (authUserIds.length > 0) {
      await pool.query('DELETE FROM app_auth.users WHERE id = ANY($1::uuid[])', [authUserIds]);
    }
    await pool.end();
  });

  const createEntry = async (): Promise<string> => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO public.person_blacklist (full_name, reason, created_by_name, birth_date)
       VALUES ('Тест Записки Интеграция', 'integration test', 'test', '1990-01-01') RETURNING id`,
    );
    entryIds.push(res.rows[0].id);
    return res.rows[0].id;
  };

  const insertMemo = (entryId: string, fileSha: string, uploadedBy: string | null = null) => pool.query<{ id: string }>(
    `INSERT INTO public.person_blacklist_memos
       (blacklist_id, file_name, file_size, mime_type, sha256, r2_key, uploaded_by, uploaded_by_name)
     VALUES ($1::uuid, 'записка.pdf', 100, 'application/pdf', $2, $3, $4::uuid, 'Тестовый загрузивший')
     RETURNING id`,
    [entryId, fileSha, `blacklist/${entryId}/${fileSha}.pdf`, uploadedBy],
  );

  it('миграция 274 применяется повторно без ошибок', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(path.resolve(here, '../../../docs/migrations/274_person_blacklist_memos.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
  });

  it('вторая активная записка с тем же файлом → 23505; после мягкого удаления — можно снова', async () => {
    const entryId = await createEntry();
    const fileSha = sha('один и тот же файл');
    const first = await insertMemo(entryId, fileSha);

    await expect(insertMemo(entryId, fileSha)).rejects.toMatchObject({ code: '23505' });

    await pool.query(
      `UPDATE public.person_blacklist_memos SET deleted_at = now(), deleted_by_name = 'test' WHERE id = $1::uuid`,
      [first.rows[0].id],
    );
    const again = await insertMemo(entryId, fileSha);
    expect(again.rows[0].id).not.toBe(first.rows[0].id);
  });

  it('формат sha256 и согласованность полей удаления проверяются CHECK', async () => {
    const entryId = await createEntry();
    await expect(insertMemo(entryId, 'не-хэш')).rejects.toMatchObject({ code: '23514' });

    const memo = await insertMemo(entryId, sha('check deleted'));
    await expect(pool.query(
      'UPDATE public.person_blacklist_memos SET deleted_at = now() WHERE id = $1::uuid',
      [memo.rows[0].id],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('удалить запись ЧС вместе с записками нельзя (RESTRICT)', async () => {
    const entryId = await createEntry();
    await insertMemo(entryId, sha('restrict'));
    await expect(pool.query('DELETE FROM public.person_blacklist WHERE id = $1::uuid', [entryId]))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('удаление учётки загрузившего: записка остаётся, автор и файл сохраняются', async () => {
    const role = await pool.query<{ id: string }>('SELECT id FROM public.system_roles LIMIT 1');
    const userId = randomUUID();
    authUserIds.push(userId);
    await pool.query(
      `INSERT INTO app_auth.users (id, email, password_hash) VALUES ($1::uuid, $2, 'x')`,
      [userId, `memo-test-${userId}@example.invalid`],
    );
    await pool.query(
      'INSERT INTO public.user_profiles (id, system_role_id) VALUES ($1::uuid, $2::uuid)',
      [userId, role.rows[0].id],
    );

    const entryId = await createEntry();
    const fileSha = sha('uploader deleted');
    const memo = await insertMemo(entryId, fileSha, userId);

    // Так удаляет учётку портал: app_auth.users → каскадом user_profiles.
    await pool.query('DELETE FROM app_auth.users WHERE id = $1::uuid', [userId]);

    const after = await pool.query<{ uploaded_by: string | null; uploaded_by_name: string; r2_key: string }>(
      'SELECT uploaded_by, uploaded_by_name, r2_key FROM public.person_blacklist_memos WHERE id = $1::uuid',
      [memo.rows[0].id],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].uploaded_by).toBeNull();
    expect(after.rows[0].uploaded_by_name).toBe('Тестовый загрузивший');
    expect(after.rows[0].r2_key).toBe(`blacklist/${entryId}/${fileSha}.pdf`);
  });

  it('полный повтор сценария: та же запись, первый файл без дубля, второй дозагружается', async () => {
    const { addEntryIn } = await import('../services/blacklist.service.js');
    const { attachMemoIn } = await import('../services/blacklist-memos.service.js');
    const passport = `ИНТ${Date.now()}`;

    const inTx = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const addPerson = () => inTx(client => addEntryIn(client, {
      fullName: 'Тест Сценарий Повтор', reason: 'integration', passport,
      source: 'manual', createdBy: null, createdByName: 'test',
    }));
    const attach = (entryId: string, seed: string) => inTx(client => attachMemoIn(client, {
      entryId, fileName: `${seed}.pdf`, fileSize: 10, mimeType: 'application/pdf',
      sha256: sha(seed), r2Key: `blacklist/${entryId}/${sha(seed)}.pdf`,
      uploadedBy: null, uploadedByName: 'test',
    }));

    // Первый проход: запись создана, первый файл приложен, второй «упал» до БД
    // (сбой R2 означает, что attach для него просто не вызывался).
    const firstRun = await addPerson();
    entryIds.push(firstRun.entry.id);
    expect(firstRun.created).toBe(true);
    expect((await attach(firstRun.entry.id, 'файл-1')).created).toBe(true);

    // Повтор всего сценария.
    const secondRun = await addPerson();
    expect(secondRun.created).toBe(false);
    expect(secondRun.entry.id).toBe(firstRun.entry.id);
    expect((await attach(secondRun.entry.id, 'файл-1')).created).toBe(false);
    expect((await attach(secondRun.entry.id, 'файл-2')).created).toBe(true);

    const memos = await pool.query<{ file_name: string }>(
      'SELECT file_name FROM public.person_blacklist_memos WHERE blacklist_id = $1::uuid AND deleted_at IS NULL',
      [firstRun.entry.id],
    );
    expect(memos.rows.map(r => r.file_name).sort()).toEqual(['файл-1.pdf', 'файл-2.pdf']);
  });
});
