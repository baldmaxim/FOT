/**
 * Смена почты для входа (app_auth.users.email) администратором.
 *
 * Одна транзакция: логин, почта в карточке сотрудника (если там стояла та же
 * старая), email-allowlist адаптивного тестирования и запись журнала. Сбой любого
 * шага — ничего не меняется. Сессии не рвём: middleware и /auth/refresh берут
 * почту из БД, а не из токена.
 */
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { withTransaction } from '../config/postgres.js';
import { auditService } from './audit.service.js';
import { findActive as findActiveBlacklist, type IBlacklistEntry } from './blacklist.service.js';
import { recordHistory } from './hr-profile.service.js';
import { settingsService } from './settings.service.js';

const ALLOWLIST_KEY = 'adaptive_testing_allowed_emails';
const PG_UNIQUE_VIOLATION = '23505';

export type AccountEmailErrorCode = 'NOT_FOUND' | 'DUPLICATE_EMAIL' | 'BLACKLISTED';

export class AccountEmailError extends Error {
  readonly code: AccountEmailErrorCode;
  readonly entry?: IBlacklistEntry;

  constructor(message: string, code: AccountEmailErrorCode, entry?: IBlacklistEntry) {
    super(message);
    this.name = 'AccountEmailError';
    this.code = code;
    this.entry = entry;
  }
}

export interface IChangeAccountEmailInput {
  req: Request;
  userId: string;
  newEmail: string;
  actorId: string;
}

export interface IChangeAccountEmailResult {
  unchanged: boolean;
  email: string;
  emailConfirmed: boolean;
  cardUpdated: boolean;
  allowlistUpdated: boolean;
}

const normalize = (value: string): string => value.trim().toLowerCase();

/**
 * Заменяет старую почту в CSV-allowlist на новую, сохраняя остальные записи и их
 * форму. null — менять нечего (пусто, «*», старой почты в списке нет). Если новая
 * уже есть в списке, старая просто убирается, без дубля.
 */
export const replaceEmailInAllowlist = (
  raw: string | null,
  oldEmail: string,
  newEmail: string,
): string | null => {
  const value = raw ?? '';
  if (!value.trim() || value.trim() === '*') return null;
  const oldNorm = normalize(oldEmail);
  const newNorm = normalize(newEmail);
  const parts = value.split(',');
  if (!parts.some(part => normalize(part) === oldNorm)) return null;

  let inserted = parts.some(part => normalize(part) === newNorm);
  const next: string[] = [];
  for (const part of parts) {
    if (normalize(part) !== oldNorm) {
      next.push(part);
      continue;
    }
    if (inserted) continue;
    const leading = /^\s*/.exec(part)?.[0] ?? '';
    next.push(`${leading}${newNorm}`);
    inserted = true;
  }
  return next.join(',').trim();
};

const isUniqueViolation = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION;

const duplicateError = (): AccountEmailError =>
  new AccountEmailError('Эта почта уже занята другой учётной записью', 'DUPLICATE_EMAIL');

/** Почта в карточке сотрудника: меняем, только если там стояла та же старая почта. */
const syncEmployeeCardEmail = async (
  client: PoolClient,
  employeeId: number,
  oldEmail: string,
  newEmail: string,
  actorId: string,
): Promise<boolean> => {
  const card = await client.query<{ email: string | null }>(
    'SELECT email FROM public.employees WHERE id = $1 FOR UPDATE',
    [employeeId],
  );
  const cardEmail = card.rows[0]?.email ?? null;
  if (cardEmail === null || normalize(cardEmail) !== normalize(oldEmail)) return false;

  await client.query(
    'UPDATE public.employees SET email = $1, updated_at = now() WHERE id = $2',
    [newEmail, employeeId],
  );
  await recordHistory(client, employeeId, 'profile_update', {
    changedFields: ['email'],
    // Фактическое прежнее значение карточки: регистр и пробелы могут отличаться от логина.
    oldValues: { email: cardEmail },
    actor: { userId: actorId },
    source: 'admin',
  });
  return true;
};

const syncAllowlist = async (
  client: PoolClient,
  oldEmail: string,
  newEmail: string,
  actorId: string,
): Promise<boolean> => {
  const setting = await client.query<{ value: string | null }>(
    'SELECT value FROM public.system_settings WHERE key = $1 FOR UPDATE',
    [ALLOWLIST_KEY],
  );
  if (setting.rows.length === 0) return false;
  const next = replaceEmailInAllowlist(setting.rows[0].value, oldEmail, newEmail);
  if (next === null) return false;
  await client.query(
    'UPDATE public.system_settings SET value = $1, updated_at = now(), updated_by = $2::uuid WHERE key = $3',
    [next, actorId, ALLOWLIST_KEY],
  );
  return true;
};

export const changeAccountEmail = async (
  input: IChangeAccountEmailInput,
): Promise<IChangeAccountEmailResult> => {
  const { req, userId, actorId } = input;
  const newEmail = normalize(input.newEmail);

  const result = await withTransaction(async (client): Promise<IChangeAccountEmailResult> => {
    // Блокируем и профиль: параллельная перепривязка сотрудника не уведёт правку на чужую карточку.
    const target = await client.query<{ email: string; email_confirmed: boolean; employee_id: number | null }>(
      `SELECT au.email, au.email_confirmed_at IS NOT NULL AS email_confirmed, up.employee_id
         FROM app_auth.users au
         JOIN public.user_profiles up ON up.id = au.id
        WHERE au.id = $1::uuid
        FOR UPDATE OF au, up`,
      [userId],
    );
    const row = target.rows[0];
    if (!row) throw new AccountEmailError('Пользователь не найден', 'NOT_FOUND');

    const oldEmail = row.email;
    if (oldEmail === newEmail) {
      return {
        unchanged: true,
        email: oldEmail,
        emailConfirmed: row.email_confirmed,
        cardUpdated: false,
        allowlistUpdated: false,
      };
    }

    const blacklisted = await findActiveBlacklist({ email: newEmail }, client);
    const blocking = blacklisted.strong[0];
    if (blocking) {
      throw new AccountEmailError(
        `Почта в чёрном списке (внёс ${blocking.created_by_name}): ${blocking.reason}`,
        'BLACKLISTED',
        blocking,
      );
    }

    const taken = await client.query(
      'SELECT 1 FROM app_auth.users WHERE lower(email) = $1 AND id <> $2::uuid LIMIT 1',
      [newEmail, userId],
    );
    if ((taken.rowCount ?? 0) > 0) throw duplicateError();

    try {
      await client.query(
        'UPDATE app_auth.users SET email = $1, email_confirmed_at = now() WHERE id = $2::uuid',
        [newEmail, userId],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicateError();
      throw err;
    }

    // Ссылка сброса пароля могла уйти на старую почту — после смены логина она не действует.
    await client.query(
      'UPDATE public.user_profiles SET reset_token = NULL, reset_token_expires = NULL WHERE id = $1::uuid',
      [userId],
    );

    const cardUpdated = row.employee_id !== null
      ? await syncEmployeeCardEmail(client, row.employee_id, oldEmail, newEmail, actorId)
      : false;
    const allowlistUpdated = await syncAllowlist(client, oldEmail, newEmail, actorId);

    await auditService.logFromRequestWithClient(client, req, actorId, 'EMAIL_CHANGED', {
      entityType: 'user',
      entityId: userId,
      details: {
        old_email: oldEmail,
        new_email: newEmail,
        card_updated: cardUpdated,
        allowlist_updated: allowlistUpdated,
      },
    });

    return { unchanged: false, email: newEmail, emailConfirmed: true, cardUpdated, allowlistUpdated };
  });

  if (result.allowlistUpdated) settingsService.invalidateCache();
  return result;
};
