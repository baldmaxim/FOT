// Локальная auth-сервисная прослойка для схемы app_auth.users.
//
// С этой версии транспорт — прямой PostgreSQL через pg-Pool из
// src/config/postgres.ts. Никакого supabase-js здесь больше нет.
// Сигнатуры экспортируемых методов не изменились — controllers
// (auth.controller.ts, admin-users.controller.ts и др.) работают без правок.
//
// Безопасность:
// - таблица `app_auth.users` зашита в SQL (не приходит снаружи) — никаких
//   динамических идентификаторов;
// - email всегда нормализуется (trim + lowercase) перед БД-операциями;
// - функциональный UNIQUE INDEX `lower(email)` даёт case-insensitive
//   уникальность и быстрый поиск;
// - password / password_hash НЕ логируются ни в одной ветке;
// - дубликаты возвращаются как LocalAuthError('DUPLICATE_EMAIL'), а не как
//   сырая PG-ошибка с детализацией constraint'а.

import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

import { execute, query, queryOne, withTransaction } from '../config/postgres.js';

const BCRYPT_ROUNDS = 10;
const SUPPORTED_HASH_RE = /^\$2[aby]\$/;
const PG_UNIQUE_VIOLATION = '23505';

const PUBLIC_COLUMNS_SQL =
  'id, email, email_confirmed_at, last_sign_in_at, raw_app_meta_data, ' +
  'raw_user_meta_data, is_disabled, banned_until, created_at, updated_at, ' +
  'migrated_from, migrated_at';

export type LocalAuthErrorCode =
  | 'DUPLICATE_EMAIL'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_HASH'
  | 'DB_ERROR';

export class LocalAuthError extends Error {
  readonly code: LocalAuthErrorCode;
  readonly cause?: unknown;

  constructor(message: string, code: LocalAuthErrorCode, cause?: unknown) {
    super(message);
    this.name = 'LocalAuthError';
    this.code = code;
    this.cause = cause;
  }
}

export interface IAppAuthUser {
  id: string;
  email: string;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  raw_app_meta_data: Record<string, unknown>;
  raw_user_meta_data: Record<string, unknown>;
  is_disabled: boolean;
  banned_until: string | null;
  created_at: string;
  updated_at: string;
  migrated_from: string | null;
  migrated_at: string | null;
}

interface IUserRowWithHash extends IAppAuthUser {
  password_hash: string;
}

export interface ICreateUserInput {
  id?: string;
  email: string;
  password: string;
  emailConfirm?: boolean;
}

export interface IUpdateUserPatch {
  email?: string;
  password?: string;
  emailConfirm?: boolean;
  isDisabled?: boolean;
  bannedUntil?: string | null;
  rawAppMetaData?: Record<string, unknown>;
  rawUserMetaData?: Record<string, unknown>;
}

export interface IListUsersParams {
  page?: number;
  perPage?: number;
}

export interface IListUsersResult {
  users: IAppAuthUser[];
  total: number;
  page: number;
  perPage: number;
}

// ─── Утилиты ────────────────────────────────────────────────────────────────

const normalizeEmail = (email: string): string => {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
};

const isPgUniqueViolation = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION;
};

const toIsoString = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return new Date().toISOString();
};

const toIsoOrNull = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return null;
};

const asJsonObject = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
};

// pg возвращает timestamptz как Date, jsonb как object, bigint как string.
// mapPublicRow приводит к контракту IAppAuthUser (даты — ISO-строки).
function mapPublicRow(raw: Record<string, unknown>): IAppAuthUser {
  return {
    id: String(raw.id),
    email: String(raw.email ?? ''),
    email_confirmed_at: toIsoOrNull(raw.email_confirmed_at),
    last_sign_in_at: toIsoOrNull(raw.last_sign_in_at),
    raw_app_meta_data: asJsonObject(raw.raw_app_meta_data),
    raw_user_meta_data: asJsonObject(raw.raw_user_meta_data),
    is_disabled: Boolean(raw.is_disabled),
    banned_until: toIsoOrNull(raw.banned_until),
    created_at: toIsoString(raw.created_at),
    updated_at: toIsoString(raw.updated_at),
    migrated_from: raw.migrated_from == null ? null : String(raw.migrated_from),
    migrated_at: toIsoOrNull(raw.migrated_at),
  };
}

function mapInternalRow(raw: Record<string, unknown>): IUserRowWithHash {
  return {
    ...mapPublicRow(raw),
    password_hash: String(raw.password_hash ?? ''),
  };
}

const stripPasswordHash = (row: IUserRowWithHash): IAppAuthUser => {
  const { password_hash: _hash, ...rest } = row;
  return rest;
};

// ─── Методы ─────────────────────────────────────────────────────────────────

async function createUser(input: ICreateUserInput): Promise<IAppAuthUser> {
  const email = normalizeEmail(input.email);
  if (!email) {
    throw new LocalAuthError('Email обязателен', 'INVALID_INPUT');
  }
  if (typeof input.password !== 'string' || input.password.length === 0) {
    throw new LocalAuthError('Пароль обязателен', 'INVALID_INPUT');
  }

  const id = input.id ?? randomUUID();
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const emailConfirmedAt = input.emailConfirm ? new Date() : null;

  try {
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO app_auth.users (id, email, password_hash, email_confirmed_at)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_COLUMNS_SQL}`,
      [id, email, passwordHash, emailConfirmedAt],
    );
    if (!row) {
      throw new LocalAuthError('Не удалось создать пользователя', 'DB_ERROR');
    }
    return mapPublicRow(row);
  } catch (err) {
    if (err instanceof LocalAuthError) throw err;
    if (isPgUniqueViolation(err)) {
      throw new LocalAuthError('Пользователь с таким email уже существует', 'DUPLICATE_EMAIL');
    }
    const code = (err as { code?: string }).code;
    throw new LocalAuthError('Не удалось создать пользователя', 'DB_ERROR', { code });
  }
}

async function verifyPassword(email: string, password: string): Promise<IAppAuthUser | null> {
  const normalized = normalizeEmail(email);
  if (!normalized || typeof password !== 'string' || password.length === 0) {
    return null;
  }

  let raw: Record<string, unknown> | null;
  try {
    // Functional UNIQUE INDEX on lower(email) даёт ≤ 1 строку — LIMIT 1
    // защитный (на случай legacy-данных с разным регистром).
    raw = await queryOne<Record<string, unknown>>(
      `SELECT ${PUBLIC_COLUMNS_SQL}, password_hash
         FROM app_auth.users
        WHERE lower(email) = $1
        LIMIT 1`,
      [normalized],
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new LocalAuthError('Ошибка БД при проверке пароля', 'DB_ERROR', { code });
  }

  if (!raw) return null;
  const row = mapInternalRow(raw);

  if (row.is_disabled) return null;
  if (row.banned_until && new Date(row.banned_until).getTime() > Date.now()) return null;

  const hash = row.password_hash;
  if (!hash || !SUPPORTED_HASH_RE.test(hash)) {
    throw new LocalAuthError('Неподдерживаемый формат хеша пароля', 'INVALID_HASH');
  }

  const ok = await bcrypt.compare(password, hash);
  if (!ok) return null;

  // Best-effort обновление last_sign_in_at — ошибка не должна сорвать вход.
  try {
    await execute(
      `UPDATE app_auth.users SET last_sign_in_at = now() WHERE id = $1`,
      [row.id],
    );
  } catch {
    // ignore
  }

  return stripPasswordHash(row);
}

async function listUsers(params: IListUsersParams = {}): Promise<IListUsersResult> {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.min(1000, Math.max(1, Math.floor(params.perPage ?? 50)));
  const offset = (page - 1) * perPage;

  try {
    const [countRow, rawRows] = await Promise.all([
      queryOne<{ total: number }>(
        `SELECT count(*)::int AS total FROM app_auth.users`,
      ),
      query<Record<string, unknown>>(
        `SELECT ${PUBLIC_COLUMNS_SQL}
           FROM app_auth.users
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2`,
        [perPage, offset],
      ),
    ]);
    return {
      users: rawRows.map(mapPublicRow),
      total: countRow?.total ?? 0,
      page,
      perPage,
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new LocalAuthError('Не удалось получить список пользователей', 'DB_ERROR', { code });
  }
}

async function getUserById(id: string): Promise<IAppAuthUser | null> {
  if (!id || typeof id !== 'string') return null;
  try {
    const raw = await queryOne<Record<string, unknown>>(
      `SELECT ${PUBLIC_COLUMNS_SQL} FROM app_auth.users WHERE id = $1`,
      [id],
    );
    return raw ? mapPublicRow(raw) : null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new LocalAuthError('Ошибка БД при поиске пользователя', 'DB_ERROR', { code });
  }
}

async function getUsersByIds(ids: readonly string[]): Promise<Map<string, IAppAuthUser>> {
  const map = new Map<string, IAppAuthUser>();
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return map;

  try {
    const rawRows = await query<Record<string, unknown>>(
      `SELECT ${PUBLIC_COLUMNS_SQL}
         FROM app_auth.users
        WHERE id = ANY($1::uuid[])`,
      [uniqueIds],
    );
    for (const raw of rawRows) {
      const row = mapPublicRow(raw);
      map.set(row.id, row);
    }
    return map;
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new LocalAuthError('Ошибка БД при пакетном поиске пользователей', 'DB_ERROR', { code });
  }
}

async function getEmailByUserId(id: string): Promise<string | null> {
  const user = await getUserById(id);
  return user?.email ?? null;
}

async function getEmailsByUserIds(ids: readonly string[]): Promise<Map<string, string>> {
  const users = await getUsersByIds(ids);
  const emails = new Map<string, string>();
  for (const [userId, user] of users.entries()) {
    if (user.email) emails.set(userId, user.email);
  }
  return emails;
}

async function updateUserById(id: string, patch: IUpdateUserPatch): Promise<IAppAuthUser> {
  if (!id || typeof id !== 'string') {
    throw new LocalAuthError('User id обязателен', 'INVALID_INPUT');
  }

  // Аккумулируем SET-фразы и параметры. Каждое поле зашито в SQL — никаких
  // динамических имён колонок.
  const setClauses: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (patch.email !== undefined) {
    const normalized = normalizeEmail(patch.email);
    if (!normalized) {
      throw new LocalAuthError('Email не может быть пустым', 'INVALID_INPUT');
    }
    setClauses.push(`email = ${addParam(normalized)}`);
  }
  if (patch.password !== undefined) {
    if (typeof patch.password !== 'string' || patch.password.length === 0) {
      throw new LocalAuthError('Пароль не может быть пустым', 'INVALID_INPUT');
    }
    const newHash = await bcrypt.hash(patch.password, BCRYPT_ROUNDS);
    setClauses.push(`password_hash = ${addParam(newHash)}`);
  }
  if (patch.emailConfirm === true) {
    setClauses.push(`email_confirmed_at = ${addParam(new Date())}`);
  } else if (patch.emailConfirm === false) {
    setClauses.push(`email_confirmed_at = NULL`);
  }
  if (patch.isDisabled !== undefined) {
    setClauses.push(`is_disabled = ${addParam(patch.isDisabled)}`);
  }
  if (patch.bannedUntil !== undefined) {
    setClauses.push(`banned_until = ${addParam(patch.bannedUntil)}`);
  }
  if (patch.rawAppMetaData !== undefined) {
    setClauses.push(`raw_app_meta_data = ${addParam(JSON.stringify(patch.rawAppMetaData))}::jsonb`);
  }
  if (patch.rawUserMetaData !== undefined) {
    setClauses.push(`raw_user_meta_data = ${addParam(JSON.stringify(patch.rawUserMetaData))}::jsonb`);
  }

  if (setClauses.length === 0) {
    const existing = await getUserById(id);
    if (!existing) throw new LocalAuthError('Пользователь не найден', 'NOT_FOUND');
    return existing;
  }

  const idPlaceholder = addParam(id);
  const sql = `UPDATE app_auth.users SET ${setClauses.join(', ')}
                 WHERE id = ${idPlaceholder}
                 RETURNING ${PUBLIC_COLUMNS_SQL}`;

  try {
    const raw = await queryOne<Record<string, unknown>>(sql, params);
    if (!raw) throw new LocalAuthError('Пользователь не найден', 'NOT_FOUND');
    return mapPublicRow(raw);
  } catch (err) {
    if (err instanceof LocalAuthError) throw err;
    if (isPgUniqueViolation(err)) {
      throw new LocalAuthError('Email уже занят другим пользователем', 'DUPLICATE_EMAIL');
    }
    const code = (err as { code?: string }).code;
    throw new LocalAuthError('Не удалось обновить пользователя', 'DB_ERROR', { code });
  }
}

async function deleteUser(id: string): Promise<void> {
  if (!id || typeof id !== 'string') {
    throw new LocalAuthError('User id обязателен', 'INVALID_INPUT');
  }
  try {
    await execute('DELETE FROM app_auth.users WHERE id = $1', [id]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new LocalAuthError('Не удалось удалить пользователя', 'DB_ERROR', { code });
  }
}

// withTransaction re-exported — позволит сабклассам/контроллерам обернуть
// многошаговый flow (например, deleteUser + cascade) в общую транзакцию.
export { withTransaction };

export const localAuthService = {
  createUser,
  verifyPassword,
  listUsers,
  getUserById,
  getUsersByIds,
  getEmailByUserId,
  getEmailsByUserIds,
  updateUserById,
  deleteUser,
};
