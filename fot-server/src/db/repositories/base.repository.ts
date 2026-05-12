// BaseRepository — тонкий слой поверх sql.ts.
//
// Сознательно НЕ предоставляет универсального query-builder'а. Только:
// 1. Хранит executor (любой PostgreSQL-клиент с методом query(sql, params)).
// 2. Запоминает имя таблицы и allowlist разрешённых колонок.
// 3. Даёт безопасные методы для простых случаев (findMany / findOne /
//    insertOne / insertMany / updateWhere).
// 4. Нормализует ошибки PostgreSQL в RepositoryError с code/detail.
//
// Сложные запросы (JOIN, оконные функции, partial-update с CASE и т. п.)
// сабклассы пишут вручную, используя helpers из ../sql.ts. Это намеренно —
// мы НЕ воспроизводим Supabase-like fluent API.

import {
  buildBulkInsert,
  buildInsert,
  buildLimitOffset,
  buildOrderBy,
  buildUpdate,
  identifier,
  isValidIdentifier,
  normalizePgError,
  type IOrderBy,
  type IPgErrorInfo,
  type ISqlFragment,
} from '../sql.js';

export interface ISqlExecutor {
  query<TRow = unknown>(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ rows: TRow[]; rowCount?: number | null }>;
}

export interface IRepositoryConfig {
  readonly table: string;
  readonly allowedColumns: readonly string[];
  readonly executor: ISqlExecutor;
}

export class RepositoryError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly constraint?: string;

  constructor(info: IPgErrorInfo) {
    super(info.message);
    this.name = 'RepositoryError';
    this.code = info.code;
    this.detail = info.detail;
    this.hint = info.hint;
    this.table = info.table;
    this.column = info.column;
    this.constraint = info.constraint;
  }
}

export interface IFindManyOptions {
  readonly where?: Readonly<Record<string, unknown>>;
  readonly columns?: '*' | readonly string[];
  readonly orderBy?: readonly IOrderBy[];
  readonly limit?: number;
  readonly offset?: number;
}

export abstract class BaseRepository {
  protected readonly table: string;
  protected readonly allowedColumns: readonly string[];
  protected readonly executor: ISqlExecutor;

  constructor(cfg: IRepositoryConfig) {
    if (!isValidIdentifier(cfg.table)) {
      throw new Error(`BaseRepository: invalid table name "${cfg.table}"`);
    }
    if (cfg.allowedColumns.length === 0) {
      throw new Error(`BaseRepository: empty allowedColumns for "${cfg.table}"`);
    }
    for (const col of cfg.allowedColumns) {
      if (!isValidIdentifier(col)) {
        throw new Error(`BaseRepository: invalid column "${col}" in allowedColumns for "${cfg.table}"`);
      }
    }
    this.table = cfg.table;
    this.allowedColumns = cfg.allowedColumns;
    this.executor = cfg.executor;
  }

  protected async run<T = unknown>(fragment: ISqlFragment): Promise<T[]> {
    try {
      const result = await this.executor.query<T>(fragment.sql, fragment.params);
      return result.rows;
    } catch (err) {
      throw new RepositoryError(normalizePgError(err));
    }
  }

  async findMany<TRow = unknown>(options: IFindManyOptions = {}): Promise<TRow[]> {
    const columnsSql = this.renderColumns(options.columns);
    const whereSql = this.renderEqualityWhere(options.where, 1);
    const orderSql = options.orderBy && options.orderBy.length > 0
      ? ' ' + buildOrderBy(options.orderBy, this.allowedColumns)
      : '';
    const limitSql = (options.limit !== undefined || options.offset !== undefined)
      ? ' ' + buildLimitOffset(options.limit, options.offset)
      : '';
    const sql =
      `SELECT ${columnsSql} FROM ${identifier(this.table)}` +
      (whereSql.sql ? ` ${whereSql.sql}` : '') +
      orderSql +
      limitSql;
    return this.run<TRow>({ sql, params: whereSql.params });
  }

  async findOne<TRow = unknown>(options: IFindManyOptions = {}): Promise<TRow | null> {
    const rows = await this.findMany<TRow>({ ...options, limit: 1 });
    return rows[0] ?? null;
  }

  async insertOne<TRow = unknown>(
    row: Readonly<Record<string, unknown>>,
    returning: '*' | readonly string[] = '*',
  ): Promise<TRow | null> {
    const fragment = buildInsert(this.table, row, {
      allowedColumns: this.allowedColumns,
      returning,
    });
    const rows = await this.run<TRow>(fragment);
    return rows[0] ?? null;
  }

  async insertMany<TRow = unknown>(
    rows: readonly Readonly<Record<string, unknown>>[],
    returning: '*' | readonly string[] = '*',
  ): Promise<TRow[]> {
    if (rows.length === 0) return [];
    const fragment = buildBulkInsert(this.table, rows, {
      allowedColumns: this.allowedColumns,
      returning,
    });
    return this.run<TRow>(fragment);
  }

  async updateWhere<TRow = unknown>(
    set: Readonly<Record<string, unknown>>,
    where: Readonly<Record<string, unknown>>,
    returning: '*' | readonly string[] = '*',
  ): Promise<TRow[]> {
    const fragment = buildUpdate(this.table, set, where, {
      allowedSetColumns: this.allowedColumns,
      allowedWhereColumns: this.allowedColumns,
      returning,
    });
    return this.run<TRow>(fragment);
  }

  private renderColumns(columns: '*' | readonly string[] | undefined): string {
    if (columns === undefined || columns === '*') return '*';
    if (columns.length === 0) {
      throw new Error('Columns list must be either "*" or non-empty array');
    }
    return columns.map(c => identifier(c, this.allowedColumns)).join(', ');
  }

  private renderEqualityWhere(
    where: Readonly<Record<string, unknown>> | undefined,
    paramStart: number,
  ): { sql: string; params: unknown[] } {
    if (!where) return { sql: '', params: [] };
    const keys = Object.keys(where);
    if (keys.length === 0) return { sql: '', params: [] };
    const params: unknown[] = [];
    const parts: string[] = [];
    for (const k of keys) {
      const col = identifier(k, this.allowedColumns);
      const val = where[k];
      if (val === null) {
        parts.push(`${col} IS NULL`);
      } else {
        params.push(val);
        parts.push(`${col} = $${paramStart + params.length - 1}`);
      }
    }
    return { sql: `WHERE ${parts.join(' AND ')}`, params };
  }
}
