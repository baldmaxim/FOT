import { describe, expect, it, vi } from 'vitest';
import { BaseRepository, RepositoryError, type ISqlExecutor } from './base.repository.js';

const USER_COLS = ['id', 'name', 'email', 'created_at'] as const;

class UsersRepo extends BaseRepository {
  constructor(executor: ISqlExecutor) {
    super({ table: 'users', allowedColumns: USER_COLS, executor });
  }
}

interface ICall {
  sql: string;
  params: readonly unknown[];
}

const mockExecutor = (rows: unknown[] = []): { exec: ISqlExecutor; calls: ICall[] } => {
  const calls: ICall[] = [];
  const exec: ISqlExecutor = {
    query: vi.fn(async (sql: string, params: readonly unknown[]) => {
      calls.push({ sql, params });
      return { rows: rows as never[], rowCount: rows.length };
    }),
  };
  return { exec, calls };
};

describe('BaseRepository constructor', () => {
  it('rejects invalid table name', () => {
    const { exec } = mockExecutor();
    expect(() => new (class extends BaseRepository {})({
      table: '1bad',
      allowedColumns: ['id'],
      executor: exec,
    })).toThrow(/invalid table name/);
  });

  it('rejects empty allowlist', () => {
    const { exec } = mockExecutor();
    expect(() => new (class extends BaseRepository {})({
      table: 'users',
      allowedColumns: [],
      executor: exec,
    })).toThrow(/empty allowedColumns/);
  });

  it('rejects invalid column in allowlist', () => {
    const { exec } = mockExecutor();
    expect(() => new (class extends BaseRepository {})({
      table: 'users',
      allowedColumns: ['id', 'bad column'],
      executor: exec,
    })).toThrow(/invalid column/);
  });
});

describe('BaseRepository.findMany', () => {
  it('SELECT * FROM table without filters', async () => {
    const { exec, calls } = mockExecutor([{ id: 1 }]);
    const repo = new UsersRepo(exec);
    const rows = await repo.findMany();
    expect(rows).toEqual([{ id: 1 }]);
    expect(calls[0].sql).toBe('SELECT * FROM "users"');
    expect(calls[0].params).toEqual([]);
  });

  it('renders WHERE with equality and IS NULL', async () => {
    const { exec, calls } = mockExecutor();
    const repo = new UsersRepo(exec);
    await repo.findMany({ where: { id: 1, email: null } });
    expect(calls[0].sql).toBe('SELECT * FROM "users" WHERE "id" = $1 AND "email" IS NULL');
    expect(calls[0].params).toEqual([1]);
  });

  it('renders ORDER BY + LIMIT/OFFSET', async () => {
    const { exec, calls } = mockExecutor();
    const repo = new UsersRepo(exec);
    await repo.findMany({
      orderBy: [{ column: 'created_at', direction: 'desc' }],
      limit: 50,
      offset: 100,
    });
    expect(calls[0].sql).toBe('SELECT * FROM "users" ORDER BY "created_at" DESC LIMIT 50 OFFSET 100');
  });

  it('renders explicit column list', async () => {
    const { exec, calls } = mockExecutor();
    const repo = new UsersRepo(exec);
    await repo.findMany({ columns: ['id', 'name'] });
    expect(calls[0].sql).toBe('SELECT "id", "name" FROM "users"');
  });

  it('rejects column outside allowlist', async () => {
    const { exec } = mockExecutor();
    const repo = new UsersRepo(exec);
    await expect(repo.findMany({ columns: ['password_hash'] })).rejects.toThrow(/not in allowlist/);
  });

  it('rejects WHERE column outside allowlist', async () => {
    const { exec } = mockExecutor();
    const repo = new UsersRepo(exec);
    await expect(repo.findMany({ where: { is_admin: true } })).rejects.toThrow(/not in allowlist/);
  });
});

describe('BaseRepository.findOne', () => {
  it('returns first row', async () => {
    const { exec, calls } = mockExecutor([{ id: 1 }, { id: 2 }]);
    const repo = new UsersRepo(exec);
    const row = await repo.findOne({ where: { id: 1 } });
    expect(row).toEqual({ id: 1 });
    expect(calls[0].sql).toContain('LIMIT 1');
  });

  it('returns null on no rows', async () => {
    const { exec } = mockExecutor([]);
    const repo = new UsersRepo(exec);
    expect(await repo.findOne({ where: { id: 99 } })).toBeNull();
  });
});

describe('BaseRepository.insertOne / insertMany', () => {
  it('insertOne returns the inserted row', async () => {
    const { exec, calls } = mockExecutor([{ id: 7, name: 'Alice' }]);
    const repo = new UsersRepo(exec);
    const row = await repo.insertOne({ name: 'Alice' });
    expect(row).toEqual({ id: 7, name: 'Alice' });
    expect(calls[0].sql).toBe('INSERT INTO "users" ("name") VALUES ($1) RETURNING *');
    expect(calls[0].params).toEqual(['Alice']);
  });

  it('insertOne supports specific returning', async () => {
    const { exec, calls } = mockExecutor([{ id: 7 }]);
    const repo = new UsersRepo(exec);
    await repo.insertOne({ name: 'X' }, ['id']);
    expect(calls[0].sql).toBe('INSERT INTO "users" ("name") VALUES ($1) RETURNING "id"');
  });

  it('insertMany no-ops on empty array', async () => {
    const { exec, calls } = mockExecutor();
    const repo = new UsersRepo(exec);
    const rows = await repo.insertMany([]);
    expect(rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('insertMany sends bulk INSERT', async () => {
    const { exec, calls } = mockExecutor([{ id: 1 }, { id: 2 }]);
    const repo = new UsersRepo(exec);
    await repo.insertMany([{ name: 'a' }, { name: 'b' }]);
    expect(calls[0].sql).toBe('INSERT INTO "users" ("name") VALUES ($1), ($2) RETURNING *');
    expect(calls[0].params).toEqual(['a', 'b']);
  });
});

describe('BaseRepository.updateWhere', () => {
  it('builds UPDATE ... WHERE with allowlisted columns', async () => {
    const { exec, calls } = mockExecutor([{ id: 1, name: 'Z' }]);
    const repo = new UsersRepo(exec);
    await repo.updateWhere({ name: 'Z' }, { id: 1 });
    expect(calls[0].sql).toBe(
      'UPDATE "users" SET "name" = $1 WHERE "id" = $2 RETURNING *',
    );
    expect(calls[0].params).toEqual(['Z', 1]);
  });

  it('refuses empty WHERE', async () => {
    const { exec } = mockExecutor();
    const repo = new UsersRepo(exec);
    await expect(repo.updateWhere({ name: 'X' }, {})).rejects.toThrow(/empty WHERE/);
  });
});

describe('BaseRepository error handling', () => {
  it('wraps pg errors in RepositoryError with code/detail', async () => {
    const exec: ISqlExecutor = {
      query: vi.fn(async () => {
        throw {
          code: '23505',
          message: 'duplicate key',
          detail: 'Key (id)=(1) already exists.',
          constraint: 'users_pkey',
        };
      }),
    };
    const repo = new UsersRepo(exec);
    try {
      await repo.findMany();
      throw new Error('expected RepositoryError');
    } catch (err) {
      expect(err).toBeInstanceOf(RepositoryError);
      const re = err as RepositoryError;
      expect(re.code).toBe('23505');
      expect(re.detail).toContain('already exists');
      expect(re.constraint).toBe('users_pkey');
    }
  });
});
