import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock() поднимается выше всех import'ов, поэтому factory не может
// ссылаться на обычные `const` — они объявлены ниже в TDZ. Поднимаем mock-
// инстансы через vi.hoisted(), он гарантирует, что они инициализируются
// до vi.mock-факторий.
const { PoolCtor, mockQuery, mockConnect, mockEnd, mockOn } = vi.hoisted(() => {
  const mq = vi.fn();
  const mc = vi.fn();
  const me = vi.fn();
  const mo = vi.fn();
  // ВАЖНО: используем `function () {...}`, не arrow. Стрелочная функция
  // не имеет [[Construct]] и `new Pool()` бросит "not a constructor".
  return {
    PoolCtor: vi.fn(function MockPool() {
      return { query: mq, connect: mc, end: me, on: mo };
    }),
    mockQuery: mq,
    mockConnect: mc,
    mockEnd: me,
    mockOn: mo,
  };
});

vi.mock('pg', () => ({
  Pool: PoolCtor,
  types: { setTypeParser: vi.fn(), getTypeParser: vi.fn(() => (val: string) => val) },
}));

import {
  checkDbConnection,
  closeDb,
  createPgPoolConfig,
  execute,
  getPool,
  pool,
  query,
  queryOne,
  withTransaction,
} from './postgres.js';

beforeEach(async () => {
  await closeDb();
  PoolCtor.mockClear();
  mockQuery.mockReset();
  mockConnect.mockReset();
  mockEnd.mockReset();
  mockOn.mockReset();
});

afterEach(async () => {
  await closeDb();
});

describe('createPgPoolConfig', () => {
  it('собирает базовый конфиг из env (DATABASE_SSL=false в тестах)', () => {
    const cfg = createPgPoolConfig();
    expect(cfg.connectionString).toBeTruthy();
    expect(cfg.max).toBe(10);
    expect(cfg.statement_timeout).toBe(30000);
    expect(cfg.ssl).toBe(false);
  });

  it('применяет overrides (max/statement_timeout/ssl)', () => {
    const cfg = createPgPoolConfig({
      max: 25,
      statement_timeout: 5000,
      ssl: { rejectUnauthorized: true },
    });
    expect(cfg.max).toBe(25);
    expect(cfg.statement_timeout).toBe(5000);
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe('getPool / pool alias', () => {
  it('создаёт Pool лениво (только при первом вызове)', () => {
    expect(PoolCtor).not.toHaveBeenCalled();
    getPool();
    expect(PoolCtor).toHaveBeenCalledTimes(1);
  });

  it('возвращает тот же singleton при повторном вызове', () => {
    const a = getPool();
    const b = getPool();
    expect(a).toBe(b);
    expect(PoolCtor).toHaveBeenCalledTimes(1);
  });

  it('регистрирует error handler на пуле', () => {
    getPool();
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('error handler не выводит DATABASE_URL и не выводит весь err-объект', () => {
    getPool();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = mockOn.mock.calls[0][1] as (err: Error & { code?: string }) => void;
    const fakeErr = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    handler(fakeErr);
    expect(errSpy).toHaveBeenCalledOnce();
    const logged = errSpy.mock.calls[0].join(' ');
    expect(logged).toContain('ECONNRESET');
    expect(logged).toContain('connection reset');
    expect(logged).not.toContain('postgres://');
    expect(logged).not.toContain(process.env.DATABASE_URL ?? 'IMPOSSIBLE_PROBE');
    errSpy.mockRestore();
  });

  it('pool — это alias getPool', () => {
    expect(pool).toBe(getPool);
  });
});

describe('query / queryOne / execute', () => {
  it('query возвращает result.rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
    const rows = await query<{ id: number }>('SELECT id FROM t', [42]);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mockQuery).toHaveBeenCalledWith('SELECT id FROM t', [42]);
  });

  it('queryOne возвращает первую строку', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
    expect(await queryOne<{ id: number }>('SELECT id', [])).toEqual({ id: 1 });
  });

  it('queryOne возвращает null если строк нет', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await queryOne('SELECT 1', [])).toBeNull();
  });

  it('execute возвращает rowCount', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 7 });
    expect(await execute('DELETE FROM t WHERE x = $1', [1])).toBe(7);
  });

  it('execute возвращает 0 если rowCount = null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: null });
    expect(await execute('DO $$ BEGIN END $$', [])).toBe(0);
  });
});

describe('withTransaction', () => {
  it('BEGIN / fn / COMMIT при успехе, всегда release', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    const clientRelease = vi.fn();
    mockConnect.mockResolvedValueOnce({ query: clientQuery, release: clientRelease });

    const result = await withTransaction(async client => {
      await client.query('INSERT INTO t VALUES ($1)', [1]);
      return 'ok';
    });

    expect(result).toBe('ok');
    const calls = clientQuery.mock.calls.map(c => c[0]);
    expect(calls).toEqual(['BEGIN', 'INSERT INTO t VALUES ($1)', 'COMMIT']);
    expect(clientRelease).toHaveBeenCalledOnce();
  });

  it('ROLLBACK + release при исключении внутри fn', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    const clientRelease = vi.fn();
    mockConnect.mockResolvedValueOnce({ query: clientQuery, release: clientRelease });

    await expect(
      withTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const calls = clientQuery.mock.calls.map(c => c[0]);
    expect(calls).toEqual(['BEGIN', 'ROLLBACK']);
    expect(clientRelease).toHaveBeenCalledOnce();
  });

  it('release всё равно срабатывает, если ROLLBACK сам упал', async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error('rollback failed')); // ROLLBACK
    const clientRelease = vi.fn();
    mockConnect.mockResolvedValueOnce({ query: clientQuery, release: clientRelease });

    await expect(
      withTransaction(async () => {
        throw new Error('original');
      }),
    ).rejects.toThrow('original'); // оригинальная ошибка пробрасывается

    expect(clientRelease).toHaveBeenCalledOnce();
  });
});

describe('checkDbConnection', () => {
  it('возвращает true на успешный SELECT 1', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    expect(await checkDbConnection()).toBe(true);
  });

  it('возвращает false и логирует только code+message при ошибке', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockRejectedValueOnce(
      Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    );
    expect(await checkDbConnection()).toBe(false);
    const logged = errSpy.mock.calls[0].join(' ');
    expect(logged).toContain('ECONNREFUSED');
    expect(logged).toContain('connection refused');
    expect(logged).not.toContain('postgres://');
    errSpy.mockRestore();
  });
});

describe('closeDb', () => {
  it('закрывает пул и сбрасывает singleton', async () => {
    getPool(); // создаёт пул
    expect(PoolCtor).toHaveBeenCalledTimes(1);
    mockEnd.mockResolvedValueOnce(undefined);
    await closeDb();
    expect(mockEnd).toHaveBeenCalledOnce();

    // После closeDb следующий getPool создаёт НОВЫЙ пул.
    getPool();
    expect(PoolCtor).toHaveBeenCalledTimes(2);
  });

  it('идемпотентен: повторный вызов не падает и не зовёт end()', async () => {
    await closeDb(); // никакого пула не было
    expect(mockEnd).not.toHaveBeenCalled();
    await closeDb();
    expect(mockEnd).not.toHaveBeenCalled();
  });
});
