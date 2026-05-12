import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock() hoisted — переменные внутри factory должны быть подняты
// через vi.hoisted(), иначе TDZ-ошибка при загрузке теста.
const { bcryptHash, bcryptCompare, pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  bcryptHash: vi.fn(async (p: string) => `$2a$10$mocked_${p}`),
  bcryptCompare: vi.fn(async () => true),
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

vi.mock('bcryptjs', () => ({
  default: { hash: bcryptHash, compare: bcryptCompare },
  hash: bcryptHash,
  compare: bcryptCompare,
}));

import { LocalAuthError, localAuthService } from './local-auth.service.js';

// Удобные алиасы, чтобы не таскать pg* приставку по тестам.
const query = pgQuery;
const queryOne = pgQueryOne;
const execute = pgExecute;

const FAKE_USER_RAW = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'alice@example.com',
  email_confirmed_at: new Date('2026-01-15T10:00:00Z'),
  last_sign_in_at: null,
  raw_app_meta_data: { provider: 'email' },
  raw_user_meta_data: {},
  is_disabled: false,
  banned_until: null,
  created_at: new Date('2026-01-15T09:00:00Z'),
  updated_at: new Date('2026-01-15T10:00:00Z'),
  migrated_from: 'supabase_auth',
  migrated_at: new Date('2026-01-15T09:30:00Z'),
};

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  execute.mockReset();
  bcryptHash.mockClear();
  bcryptCompare.mockClear();
  bcryptCompare.mockResolvedValue(true);
});

describe('createUser', () => {
  it('хеширует пароль через bcrypt и нормализует email', async () => {
    queryOne.mockResolvedValueOnce(FAKE_USER_RAW);
    const u = await localAuthService.createUser({
      email: '  Alice@Example.COM ',
      password: 'secret123',
    });
    expect(bcryptHash).toHaveBeenCalledWith('secret123', 10);
    expect(queryOne).toHaveBeenCalledOnce();
    const [, params] = queryOne.mock.calls[0];
    expect(params[1]).toBe('alice@example.com'); // trim + lowercase
    expect(params[2]).toMatch(/^\$2a\$10\$/);
    expect(u.email).toBe('alice@example.com');
    expect(u.created_at).toBe('2026-01-15T09:00:00.000Z'); // Date → ISO
  });

  it('бросает DUPLICATE_EMAIL при PG error 23505', async () => {
    queryOne.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(
      localAuthService.createUser({ email: 'a@b', password: 'pw' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_EMAIL' });
  });

  it('бросает INVALID_INPUT на пустой email', async () => {
    await expect(
      localAuthService.createUser({ email: '   ', password: 'pw' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('бросает INVALID_INPUT на пустой password', async () => {
    await expect(
      localAuthService.createUser({ email: 'a@b', password: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('verifyPassword', () => {
  const WITH_HASH = { ...FAKE_USER_RAW, password_hash: '$2a$10$realhash_for_alice' };

  it('возвращает user (без password_hash) при правильном пароле', async () => {
    queryOne.mockResolvedValueOnce(WITH_HASH);
    execute.mockResolvedValueOnce(1); // best-effort last_sign_in_at
    bcryptCompare.mockResolvedValueOnce(true);

    const u = await localAuthService.verifyPassword('ALICE@Example.com', 'secret123');
    expect(u).not.toBeNull();
    expect(u!.email).toBe('alice@example.com');
    expect((u as unknown as { password_hash?: string }).password_hash).toBeUndefined();
    expect(bcryptCompare).toHaveBeenCalledWith('secret123', '$2a$10$realhash_for_alice');
  });

  it('возвращает null при неправильном пароле', async () => {
    queryOne.mockResolvedValueOnce(WITH_HASH);
    bcryptCompare.mockResolvedValueOnce(false);
    expect(await localAuthService.verifyPassword('a@b', 'wrong')).toBeNull();
  });

  it('возвращает null если user отсутствует', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await localAuthService.verifyPassword('nope@b', 'pw')).toBeNull();
    expect(bcryptCompare).not.toHaveBeenCalled();
  });

  it('возвращает null при is_disabled=true (compare не вызывается)', async () => {
    queryOne.mockResolvedValueOnce({ ...WITH_HASH, is_disabled: true });
    expect(await localAuthService.verifyPassword('a@b', 'pw')).toBeNull();
    expect(bcryptCompare).not.toHaveBeenCalled();
  });

  it('возвращает null при banned_until в будущем', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    queryOne.mockResolvedValueOnce({ ...WITH_HASH, banned_until: future });
    expect(await localAuthService.verifyPassword('a@b', 'pw')).toBeNull();
    expect(bcryptCompare).not.toHaveBeenCalled();
  });

  it.each(['$2a$10$x', '$2b$12$x', '$2y$10$x'])(
    'принимает bcrypt-формат %s',
    async hash => {
      queryOne.mockResolvedValueOnce({ ...WITH_HASH, password_hash: hash });
      bcryptCompare.mockResolvedValueOnce(true);
      const u = await localAuthService.verifyPassword('a@b', 'pw');
      expect(u).not.toBeNull();
    },
  );

  it('бросает INVALID_HASH на неподдерживаемый формат', async () => {
    queryOne.mockResolvedValueOnce({ ...WITH_HASH, password_hash: '$argon2id$v=19$...' });
    await expect(localAuthService.verifyPassword('a@b', 'pw')).rejects.toMatchObject({
      code: 'INVALID_HASH',
    });
  });

  it('возвращает null на пустой пароль/email (короткий путь без БД)', async () => {
    expect(await localAuthService.verifyPassword('', 'pw')).toBeNull();
    expect(await localAuthService.verifyPassword('a@b', '')).toBeNull();
    expect(queryOne).not.toHaveBeenCalled();
  });
});

describe('listUsers', () => {
  it('пагинирует через LIMIT/OFFSET, возвращает total из count', async () => {
    queryOne.mockResolvedValueOnce({ total: 42 });
    query.mockResolvedValueOnce([FAKE_USER_RAW]);
    const r = await localAuthService.listUsers({ page: 2, perPage: 25 });
    expect(r).toEqual({ users: expect.any(Array), total: 42, page: 2, perPage: 25 });
    expect(r.users).toHaveLength(1);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([25, 25]); // OFFSET = (2-1)*25
  });

  it('кламит perPage в [1, 1000]', async () => {
    queryOne.mockResolvedValue({ total: 0 });
    query.mockResolvedValue([]);
    expect((await localAuthService.listUsers({ perPage: 5000 })).perPage).toBe(1000);
    expect((await localAuthService.listUsers({ perPage: 0 })).perPage).toBe(1);
  });
});

describe('getUserById / getUsersByIds / getEmail*', () => {
  it('getUserById возвращает null на пустой id без запроса в БД', async () => {
    expect(await localAuthService.getUserById('')).toBeNull();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('getUserById маппит pg-Date в ISO-строку', async () => {
    queryOne.mockResolvedValueOnce(FAKE_USER_RAW);
    const u = await localAuthService.getUserById(FAKE_USER_RAW.id);
    expect(u?.email_confirmed_at).toBe('2026-01-15T10:00:00.000Z');
    expect(u?.created_at).toBe('2026-01-15T09:00:00.000Z');
  });

  it('getUsersByIds на пустом массиве не идёт в БД', async () => {
    const m = await localAuthService.getUsersByIds([]);
    expect(m.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('getUsersByIds дедупит входящие id перед запросом', async () => {
    query.mockResolvedValueOnce([FAKE_USER_RAW]);
    await localAuthService.getUsersByIds([FAKE_USER_RAW.id, FAKE_USER_RAW.id]);
    const [, params] = query.mock.calls[0];
    expect(params[0]).toHaveLength(1);
  });

  it('getEmailsByUserIds возвращает Map<id, email>', async () => {
    query.mockResolvedValueOnce([FAKE_USER_RAW]);
    const m = await localAuthService.getEmailsByUserIds([FAKE_USER_RAW.id]);
    expect(m.get(FAKE_USER_RAW.id)).toBe('alice@example.com');
  });
});

describe('updateUserById', () => {
  it('пустой patch возвращает existing без UPDATE', async () => {
    queryOne.mockResolvedValueOnce(FAKE_USER_RAW); // через getUserById
    await localAuthService.updateUserById(FAKE_USER_RAW.id, {});
    // Только один SELECT, никаких UPDATE
    expect(queryOne).toHaveBeenCalledOnce();
    const [sql] = queryOne.mock.calls[0];
    expect(sql).toMatch(/^SELECT /);
  });

  it('хеширует новый password через bcrypt', async () => {
    queryOne.mockResolvedValueOnce(FAKE_USER_RAW);
    await localAuthService.updateUserById(FAKE_USER_RAW.id, { password: 'newpw' });
    expect(bcryptHash).toHaveBeenCalledWith('newpw', 10);
    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain('password_hash =');
    // password_hash попадает первым параметром (только этот SET), id последним
    expect(params[0]).toMatch(/^\$2a\$10\$/);
    expect(params[params.length - 1]).toBe(FAKE_USER_RAW.id);
  });

  it('emailConfirm=true ставит email_confirmed_at = now(), false → NULL', async () => {
    queryOne.mockResolvedValueOnce(FAKE_USER_RAW);
    await localAuthService.updateUserById(FAKE_USER_RAW.id, { emailConfirm: false });
    const [sql] = queryOne.mock.calls[0];
    expect(sql).toMatch(/email_confirmed_at\s*=\s*NULL/);
  });

  it('DUPLICATE_EMAIL на 23505', async () => {
    queryOne.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(
      localAuthService.updateUserById(FAKE_USER_RAW.id, { email: 'x@y' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_EMAIL' });
  });

  it('NOT_FOUND если UPDATE вернул 0 строк', async () => {
    queryOne.mockResolvedValueOnce(null);
    await expect(
      localAuthService.updateUserById(FAKE_USER_RAW.id, { email: 'x@y' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('deleteUser', () => {
  it('DELETE FROM app_auth.users WHERE id = $1', async () => {
    execute.mockResolvedValueOnce(1);
    await localAuthService.deleteUser(FAKE_USER_RAW.id);
    expect(execute).toHaveBeenCalledOnce();
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toMatch(/^DELETE FROM app_auth\.users WHERE id = \$1/);
    expect(params).toEqual([FAKE_USER_RAW.id]);
  });

  it('бросает INVALID_INPUT на пустой id', async () => {
    await expect(localAuthService.deleteUser('')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('LocalAuthError безопасность логирования', () => {
  it('сообщение НЕ содержит password_hash при DUPLICATE_EMAIL', async () => {
    queryOne.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value: $2a$10$secrethash'), { code: '23505' }),
    );
    let caught: LocalAuthError | null = null;
    try {
      await localAuthService.createUser({ email: 'a@b', password: 'pw' });
    } catch (e) {
      caught = e as LocalAuthError;
    }
    expect(caught).toBeInstanceOf(LocalAuthError);
    expect(caught!.code).toBe('DUPLICATE_EMAIL');
    expect(caught!.message).not.toContain('$2a$10$secrethash');
    expect(caught!.message).not.toContain('pw');
  });
});
