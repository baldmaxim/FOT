import { describe, expect, it, vi } from 'vitest';

import { syncProfileNameFromEmployee } from './user-profile-name.service.js';

/** Мок PoolClient: отдаёт заданный rowCount и запоминает вызовы. */
const makeClient = (rowCount = 1) => {
  const query = vi.fn(async () => ({ rows: [], rowCount }));
  return { client: { query } as never, query };
};

describe('syncProfileNameFromEmployee', () => {
  it('обновляет профили из карточки и возвращает число строк', async () => {
    const { client, query } = makeClient(2);

    const updated = await syncProfileNameFromEmployee(client, 396);

    expect(updated).toBe(2);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('UPDATE user_profiles');
    expect(sql).toContain('FROM employees e');
    expect(params).toEqual([396]);
  });

  it('имя берёт из employees, а не из аргументов: параметр только employee_id', async () => {
    const { client, query } = makeClient();

    await syncProfileNameFromEmployee(client, 42);

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    // Каноническое имя читается тем же клиентом — рассинхрон «передали одно, в карточке другое» невозможен.
    expect(sql).toContain('SET full_name = btrim(e.full_name)');
    expect(params).toHaveLength(1);
  });

  it('пустое ФИО карточки профиль не затирает (условие в SQL)', async () => {
    const { client, query } = makeClient(0);

    const updated = await syncProfileNameFromEmployee(client, 7);

    expect(updated).toBe(0);
    const [sql] = query.mock.calls[0] as unknown as [string];
    expect(sql).toContain("btrim(coalesce(e.full_name, '')) <> ''");
  });

  it('ошибку БД пробрасывает наверх — вызывающий откатывает транзакцию', async () => {
    const client = { query: vi.fn(async () => { throw new Error('deadlock detected'); }) } as never;

    await expect(syncProfileNameFromEmployee(client, 396)).rejects.toThrow('deadlock detected');
  });
});
