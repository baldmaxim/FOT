import { describe, expect, it } from 'vitest';
import {
  anyClause,
  buildBulkInsert,
  buildInsert,
  buildLimitOffset,
  buildOrderBy,
  buildSupabaseRange,
  buildUpdate,
  identifier,
  inClause,
  isValidIdentifier,
  jsonbParam,
  normalizePgError,
} from './sql.js';

const COLS = ['id', 'name', 'email', 'created_at'] as const;

describe('identifier / isValidIdentifier', () => {
  it('accepts plain snake_case identifiers', () => {
    expect(isValidIdentifier('users')).toBe(true);
    expect(isValidIdentifier('_private')).toBe(true);
    expect(isValidIdentifier('a1_b2')).toBe(true);
    expect(identifier('users')).toBe('"users"');
  });

  it('rejects empty / non-string / invalid identifiers', () => {
    expect(isValidIdentifier('')).toBe(false);
    expect(isValidIdentifier('1users')).toBe(false);
    expect(isValidIdentifier('users; DROP TABLE x')).toBe(false);
    expect(isValidIdentifier('us"ers')).toBe(false);
    expect(isValidIdentifier('a'.repeat(64))).toBe(false);
    expect(() => identifier('1abc')).toThrow(/Invalid SQL identifier/);
    expect(() => identifier('users; DROP')).toThrow(/Invalid SQL identifier/);
  });

  it('enforces allowlist when provided', () => {
    expect(identifier('name', COLS)).toBe('"name"');
    expect(() => identifier('password_hash', COLS)).toThrow(/not in allowlist/);
  });
});

describe('buildInsert', () => {
  it('builds a single-row insert with placeholders and returning *', () => {
    const r = buildInsert(
      'users',
      { name: 'Alice', email: 'a@x' },
      { allowedColumns: COLS, returning: '*' },
    );
    expect(r.sql).toBe('INSERT INTO "users" ("name", "email") VALUES ($1, $2) RETURNING *');
    expect(r.params).toEqual(['Alice', 'a@x']);
  });

  it('supports specific RETURNING columns', () => {
    const r = buildInsert(
      'users',
      { name: 'Bob' },
      { allowedColumns: COLS, returning: ['id', 'created_at'] },
    );
    expect(r.sql).toBe('INSERT INTO "users" ("name") VALUES ($1) RETURNING "id", "created_at"');
    expect(r.params).toEqual(['Bob']);
  });

  it('rejects columns outside allowlist', () => {
    expect(() =>
      buildInsert('users', { password_hash: 'x' }, { allowedColumns: COLS }),
    ).toThrow(/not in allowlist/);
  });

  it('rejects empty row', () => {
    expect(() => buildInsert('users', {}, { allowedColumns: COLS })).toThrow(/empty row/);
  });

  it('rejects RETURNING columns outside allowlist', () => {
    expect(() =>
      buildInsert('users', { name: 'x' }, { allowedColumns: COLS, returning: ['password_hash'] }),
    ).toThrow(/not in allowlist/);
  });

  it('rejects invalid table name', () => {
    expect(() => buildInsert('users; DROP', { name: 'x' }, { allowedColumns: COLS })).toThrow(
      /Invalid SQL identifier/,
    );
  });
});

describe('buildBulkInsert', () => {
  it('numbers parameters across rows sequentially', () => {
    const r = buildBulkInsert(
      'users',
      [
        { name: 'a', email: 'a@x' },
        { name: 'b', email: 'b@x' },
        { name: 'c', email: 'c@x' },
      ],
      { allowedColumns: COLS },
    );
    expect(r.sql).toBe(
      'INSERT INTO "users" ("name", "email") VALUES ($1, $2), ($3, $4), ($5, $6)',
    );
    expect(r.params).toEqual(['a', 'a@x', 'b', 'b@x', 'c', 'c@x']);
  });

  it('supports RETURNING', () => {
    const r = buildBulkInsert(
      'users',
      [{ name: 'a' }],
      { allowedColumns: COLS, returning: ['id'] },
    );
    expect(r.sql).toBe('INSERT INTO "users" ("name") VALUES ($1) RETURNING "id"');
  });

  it('throws on empty rows', () => {
    expect(() => buildBulkInsert('users', [], { allowedColumns: COLS })).toThrow(/empty rows/);
  });

  it('throws on heterogeneous rows (missing column in subsequent row)', () => {
    expect(() =>
      buildBulkInsert(
        'users',
        [{ name: 'a', email: 'x' }, { name: 'b' }],
        { allowedColumns: COLS },
      ),
    ).toThrow(/missing column/);
  });
});

describe('buildUpdate', () => {
  it('builds SET ... WHERE with correctly numbered params', () => {
    const r = buildUpdate(
      'users',
      { name: 'NewName', email: 'new@x' },
      { id: 42 },
      { allowedSetColumns: COLS, allowedWhereColumns: COLS },
    );
    expect(r.sql).toBe('UPDATE "users" SET "name" = $1, "email" = $2 WHERE "id" = $3');
    expect(r.params).toEqual(['NewName', 'new@x', 42]);
  });

  it('renders IS NULL for null where values without binding a parameter', () => {
    const r = buildUpdate(
      'users',
      { name: 'x' },
      { email: null, id: 7 },
      { allowedSetColumns: COLS, allowedWhereColumns: COLS },
    );
    expect(r.sql).toBe('UPDATE "users" SET "name" = $1 WHERE "email" IS NULL AND "id" = $2');
    expect(r.params).toEqual(['x', 7]);
  });

  it('refuses an empty WHERE (would update entire table)', () => {
    expect(() =>
      buildUpdate('users', { name: 'x' }, {}, { allowedSetColumns: COLS, allowedWhereColumns: COLS }),
    ).toThrow(/empty WHERE/);
  });

  it('refuses an empty SET', () => {
    expect(() =>
      buildUpdate('users', {}, { id: 1 }, { allowedSetColumns: COLS, allowedWhereColumns: COLS }),
    ).toThrow(/empty SET/);
  });

  it('rejects SET columns outside allowlist', () => {
    expect(() =>
      buildUpdate(
        'users',
        { password_hash: 'x' },
        { id: 1 },
        { allowedSetColumns: ['name'], allowedWhereColumns: ['id'] },
      ),
    ).toThrow(/not in allowlist/);
  });

  it('rejects WHERE columns outside allowlist', () => {
    expect(() =>
      buildUpdate(
        'users',
        { name: 'x' },
        { is_admin: true },
        { allowedSetColumns: ['name'], allowedWhereColumns: ['id'] },
      ),
    ).toThrow(/not in allowlist/);
  });

  it('supports RETURNING from set or where columns', () => {
    const r = buildUpdate(
      'users',
      { name: 'x' },
      { id: 1 },
      {
        allowedSetColumns: ['name'],
        allowedWhereColumns: ['id'],
        returning: ['id', 'name'],
      },
    );
    expect(r.sql).toContain('RETURNING "id", "name"');
  });
});

describe('buildOrderBy', () => {
  it('returns empty string for empty list', () => {
    expect(buildOrderBy([], COLS)).toBe('');
  });

  it('renders direction and NULLS modifiers', () => {
    expect(
      buildOrderBy(
        [
          { column: 'created_at', direction: 'desc', nulls: 'last' },
          { column: 'name' },
        ],
        COLS,
      ),
    ).toBe('ORDER BY "created_at" DESC NULLS LAST, "name" ASC');
  });

  it('enforces allowlist', () => {
    expect(() => buildOrderBy([{ column: 'password_hash' }], COLS)).toThrow(/not in allowlist/);
  });
});

describe('buildLimitOffset', () => {
  it('renders both / either / none', () => {
    expect(buildLimitOffset(10, 20)).toBe('LIMIT 10 OFFSET 20');
    expect(buildLimitOffset(10)).toBe('LIMIT 10');
    expect(buildLimitOffset(undefined, 5)).toBe('OFFSET 5');
    expect(buildLimitOffset()).toBe('');
  });

  it('rejects non-integer / negative / oversize values', () => {
    expect(() => buildLimitOffset(1.5)).toThrow(/Invalid limit/);
    expect(() => buildLimitOffset(-1)).toThrow(/Invalid limit/);
    expect(() => buildLimitOffset(200_000)).toThrow(/Invalid limit/);
    expect(() => buildLimitOffset(10, -1)).toThrow(/Invalid offset/);
    expect(() => buildLimitOffset(10, 1.1)).toThrow(/Invalid offset/);
  });
});

describe('buildSupabaseRange', () => {
  it('translates inclusive range to LIMIT/OFFSET', () => {
    expect(buildSupabaseRange(0, 24)).toEqual({ limit: 25, offset: 0 });
    expect(buildSupabaseRange(50, 99)).toEqual({ limit: 50, offset: 50 });
    expect(buildSupabaseRange(7, 7)).toEqual({ limit: 1, offset: 7 });
  });

  it('rejects invalid input', () => {
    expect(() => buildSupabaseRange(-1, 10)).toThrow(/invalid from/);
    expect(() => buildSupabaseRange(10, 5)).toThrow(/invalid to/);
    expect(() => buildSupabaseRange(1.5, 5)).toThrow(/invalid from/);
  });
});

describe('inClause / anyClause', () => {
  it('inClause numbers placeholders starting from paramStart', () => {
    const r = inClause([10, 20, 30], 5);
    expect(r.sql).toBe('IN ($5, $6, $7)');
    expect(r.params).toEqual([10, 20, 30]);
  });

  it('inClause throws on empty values', () => {
    expect(() => inClause([], 1)).toThrow(/empty values/);
  });

  it('inClause throws on invalid paramStart', () => {
    expect(() => inClause([1], 0)).toThrow(/invalid paramStart/);
    expect(() => inClause([1], -1)).toThrow(/invalid paramStart/);
    expect(() => inClause([1], 1.5)).toThrow(/invalid paramStart/);
  });

  it('anyClause uses a single array parameter', () => {
    const r = anyClause([1, 2, 3], 4);
    expect(r.sql).toBe('= ANY($4)');
    expect(r.params).toEqual([[1, 2, 3]]);
  });

  it('anyClause is safe on empty array', () => {
    const r = anyClause([], 1);
    expect(r.sql).toBe('= ANY($1)');
    expect(r.params).toEqual([[]]);
  });
});

describe('jsonbParam', () => {
  it('serializes value to JSON string', () => {
    expect(jsonbParam({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}');
    expect(jsonbParam(null)).toBe('null');
    expect(jsonbParam('text')).toBe('"text"');
  });
});

describe('normalizePgError', () => {
  it('extracts pg-style fields from a typical error', () => {
    const err = {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      detail: 'Key (id)=(1) already exists.',
      table: 'users',
      column: 'id',
      constraint: 'users_pkey',
      schema: 'public',
    };
    expect(normalizePgError(err)).toEqual({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      detail: 'Key (id)=(1) already exists.',
      table: 'users',
      column: 'id',
      constraint: 'users_pkey',
      schema: 'public',
    });
  });

  it('falls back to UNKNOWN for non-error inputs', () => {
    expect(normalizePgError(undefined).code).toBe('UNKNOWN');
    expect(normalizePgError('boom').message).toBe('boom');
    expect(normalizePgError(123).code).toBe('UNKNOWN');
  });

  it('omits optional fields when missing', () => {
    const info = normalizePgError({ message: 'oops' });
    expect(info.code).toBe('UNKNOWN');
    expect(info.message).toBe('oops');
    expect(info.detail).toBeUndefined();
    expect(info.table).toBeUndefined();
  });
});
