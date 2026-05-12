// Минимальный безопасный SQL-toolkit для замены supabase.from / supabase.rpc.
//
// Принципы:
// 1. Значения подставляются ТОЛЬКО через позиционные параметры ($1, $2, ...).
// 2. Имена таблиц/колонок — только из фиксированного allowlist, переданного
//    вызывающим кодом. Это не Supabase-like builder и не принимает имена
//    из request без явной верификации.
// 3. Helpers возвращают сырой SQL и массив params — никакой динамической
//    компиляции, никаких регулярок по пользовательскому вводу.
//
// См. docs/yandex-postgres-migration/02_sql_helpers.md

export interface ISqlFragment {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const isValidIdentifier = (name: string): boolean =>
  typeof name === 'string' && name.length > 0 && name.length <= 63 && IDENT_RE.test(name);

// Quote an identifier (table/column/schema). Optionally enforce allowlist.
// Returns a double-quoted SQL identifier safe for embedding in a query.
export const identifier = (name: string, allowlist?: readonly string[]): string => {
  if (!isValidIdentifier(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  if (allowlist && !allowlist.includes(name)) {
    throw new Error(`Identifier not in allowlist: ${name}`);
  }
  return `"${name}"`;
};

const quoteCols = (cols: readonly string[], allowlist: readonly string[]): string =>
  cols.map(c => identifier(c, allowlist)).join(', ');

interface IBuildInsertOptions {
  readonly allowedColumns: readonly string[];
  readonly returning?: '*' | readonly string[];
}

export const buildInsert = (
  table: string,
  row: Readonly<Record<string, unknown>>,
  options: IBuildInsertOptions,
): ISqlFragment => {
  const columns = Object.keys(row);
  if (columns.length === 0) {
    throw new Error('buildInsert: empty row');
  }
  const quotedTable = identifier(table);
  const quotedCols = quoteCols(columns, options.allowedColumns);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const params = columns.map(c => row[c]);
  let sql = `INSERT INTO ${quotedTable} (${quotedCols}) VALUES (${placeholders})`;
  if (options.returning !== undefined) {
    sql += ` RETURNING ${resolveReturning(options.returning, options.allowedColumns)}`;
  }
  return { sql, params };
};

export const buildBulkInsert = (
  table: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  options: IBuildInsertOptions,
): ISqlFragment => {
  if (rows.length === 0) {
    throw new Error('buildBulkInsert: empty rows');
  }
  const columns = Object.keys(rows[0]);
  if (columns.length === 0) {
    throw new Error('buildBulkInsert: first row has no columns');
  }
  const quotedTable = identifier(table);
  const quotedCols = quoteCols(columns, options.allowedColumns);
  const params: unknown[] = [];
  const valueGroups: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const placeholders: string[] = [];
    for (const col of columns) {
      if (!(col in row)) {
        throw new Error(`buildBulkInsert: row ${r} missing column "${col}" (heterogeneous rows are not supported)`);
      }
      params.push(row[col]);
      placeholders.push(`$${params.length}`);
    }
    valueGroups.push(`(${placeholders.join(', ')})`);
  }
  let sql = `INSERT INTO ${quotedTable} (${quotedCols}) VALUES ${valueGroups.join(', ')}`;
  if (options.returning !== undefined) {
    sql += ` RETURNING ${resolveReturning(options.returning, options.allowedColumns)}`;
  }
  return { sql, params };
};

interface IBuildUpdateOptions {
  readonly allowedSetColumns: readonly string[];
  readonly allowedWhereColumns: readonly string[];
  readonly returning?: '*' | readonly string[];
}

export const buildUpdate = (
  table: string,
  set: Readonly<Record<string, unknown>>,
  where: Readonly<Record<string, unknown>>,
  options: IBuildUpdateOptions,
): ISqlFragment => {
  const setKeys = Object.keys(set);
  const whereKeys = Object.keys(where);
  if (setKeys.length === 0) {
    throw new Error('buildUpdate: empty SET');
  }
  if (whereKeys.length === 0) {
    throw new Error('buildUpdate: empty WHERE refused (would update entire table)');
  }
  const params: unknown[] = [];
  const setClauses = setKeys.map(k => {
    params.push(set[k]);
    return `${identifier(k, options.allowedSetColumns)} = $${params.length}`;
  });
  const whereClauses = whereKeys.map(k => {
    const val = where[k];
    if (val === null) {
      return `${identifier(k, options.allowedWhereColumns)} IS NULL`;
    }
    params.push(val);
    return `${identifier(k, options.allowedWhereColumns)} = $${params.length}`;
  });
  let sql = `UPDATE ${identifier(table)} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;
  if (options.returning !== undefined) {
    const allowed = [...options.allowedSetColumns, ...options.allowedWhereColumns];
    sql += ` RETURNING ${resolveReturning(options.returning, allowed)}`;
  }
  return { sql, params };
};

export type OrderDirection = 'asc' | 'desc';
export type OrderNulls = 'first' | 'last';

export interface IOrderBy {
  readonly column: string;
  readonly direction?: OrderDirection;
  readonly nulls?: OrderNulls;
}

export const buildOrderBy = (
  items: readonly IOrderBy[],
  allowedColumns: readonly string[],
): string => {
  if (items.length === 0) {
    return '';
  }
  const parts = items.map(item => {
    const col = identifier(item.column, allowedColumns);
    const dir = item.direction === 'desc' ? 'DESC' : 'ASC';
    let s = `${col} ${dir}`;
    if (item.nulls === 'first') s += ' NULLS FIRST';
    else if (item.nulls === 'last') s += ' NULLS LAST';
    return s;
  });
  return `ORDER BY ${parts.join(', ')}`;
};

const MAX_LIMIT = 100_000;

export const buildLimitOffset = (limit?: number, offset?: number): string => {
  const parts: string[] = [];
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
      throw new Error(`Invalid limit: ${limit}`);
    }
    parts.push(`LIMIT ${limit}`);
  }
  if (offset !== undefined) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`Invalid offset: ${offset}`);
    }
    parts.push(`OFFSET ${offset}`);
  }
  return parts.join(' ');
};

// Supabase .range(from, to) is INCLUSIVE on both ends — translate to LIMIT/OFFSET.
//   .range(0, 24) → 25 rows starting at offset 0
//   .range(50, 99) → 50 rows starting at offset 50
export const buildSupabaseRange = (from: number, to: number): { limit: number; offset: number } => {
  if (!Number.isInteger(from) || from < 0) {
    throw new Error(`buildSupabaseRange: invalid from=${from}`);
  }
  if (!Number.isInteger(to) || to < from) {
    throw new Error(`buildSupabaseRange: invalid to=${to} (must be integer >= from)`);
  }
  return { limit: to - from + 1, offset: from };
};

// Build `IN ($N, $N+1, ...)` clause with caller-controlled parameter numbering.
// Throws on empty values (empty IN () is invalid SQL).
export const inClause = (values: readonly unknown[], paramStart: number): ISqlFragment => {
  if (!Number.isInteger(paramStart) || paramStart < 1) {
    throw new Error(`inClause: invalid paramStart=${paramStart}`);
  }
  if (values.length === 0) {
    throw new Error('inClause: empty values list — use anyClause for safe empty handling');
  }
  const placeholders = values.map((_, i) => `$${paramStart + i}`);
  return { sql: `IN (${placeholders.join(', ')})`, params: [...values] };
};

// Build `= ANY($N)` clause — single array parameter, safe on empty arrays
// (matches no rows, doesn't blow up like `IN ()`).
export const anyClause = (values: readonly unknown[], paramStart: number): ISqlFragment => {
  if (!Number.isInteger(paramStart) || paramStart < 1) {
    throw new Error(`anyClause: invalid paramStart=${paramStart}`);
  }
  return { sql: `= ANY($${paramStart})`, params: [[...values]] };
};

// Serialize a value to a JSON string suitable for binding to a `$N::jsonb` parameter.
// The cast must be written explicitly in SQL by the caller.
export const jsonbParam = (value: unknown): string => JSON.stringify(value);

export interface IPgErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly constraint?: string;
  readonly schema?: string;
}

export const normalizePgError = (err: unknown): IPgErrorInfo => {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const pick = (k: string): string | undefined =>
      typeof e[k] === 'string' && (e[k] as string).length > 0 ? (e[k] as string) : undefined;
    return {
      code: pick('code') ?? 'UNKNOWN',
      message: pick('message') ?? 'Unknown database error',
      detail: pick('detail'),
      hint: pick('hint'),
      table: pick('table'),
      column: pick('column'),
      constraint: pick('constraint'),
      schema: pick('schema'),
    };
  }
  return {
    code: 'UNKNOWN',
    message: typeof err === 'string' ? err : 'Unknown database error',
  };
};

const resolveReturning = (
  returning: '*' | readonly string[],
  allowed: readonly string[],
): string => {
  if (returning === '*') return '*';
  if (returning.length === 0) {
    throw new Error('RETURNING list must be either "*" or non-empty column array');
  }
  return quoteCols(returning, allowed);
};
