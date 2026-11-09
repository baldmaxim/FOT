import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

/**
 * Смена почты для входа: одна транзакция на логин, карточку сотрудника,
 * allowlist тестирования и журнал. Любой сбой — откат целиком.
 */
const h = vi.hoisted(() => ({
  findActive: vi.fn(),
  recordHistory: vi.fn(),
  logFromRequestWithClient: vi.fn(),
  invalidateCache: vi.fn(),
  txLog: [] as string[],
}));

interface IState {
  target: { email: string; email_confirmed: boolean; employee_id: number | null } | null;
  taken: boolean;
  uniqueViolationOnUpdate: boolean;
  cardEmail: string | null;
  allowlist: string | null | undefined;
}

let state: IState;
const calls: Array<{ sql: string; params: unknown[] }> = [];

const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FOR UPDATE OF au, up')) return { rows: state.target ? [state.target] : [], rowCount: state.target ? 1 : 0 };
    if (sql.startsWith('SELECT 1 FROM app_auth.users')) return { rows: state.taken ? [{}] : [], rowCount: state.taken ? 1 : 0 };
    if (sql.startsWith('UPDATE app_auth.users')) {
      if (state.uniqueViolationOnUpdate) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT email FROM public.employees')) return { rows: [{ email: state.cardEmail }], rowCount: 1 };
    if (sql.startsWith('SELECT value FROM public.system_settings')) {
      return state.allowlist === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ value: state.allowlist }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }),
};

vi.mock('../config/postgres.js', () => ({
  withTransaction: async <T>(fn: (c: typeof client) => Promise<T>): Promise<T> => {
    h.txLog.push('BEGIN');
    try {
      const result = await fn(client);
      h.txLog.push('COMMIT');
      return result;
    } catch (err) {
      h.txLog.push('ROLLBACK');
      throw err;
    }
  },
}));
vi.mock('./blacklist.service.js', () => ({ findActive: h.findActive }));
vi.mock('./hr-profile.service.js', () => ({ recordHistory: h.recordHistory }));
vi.mock('./audit.service.js', () => ({ auditService: { logFromRequestWithClient: h.logFromRequestWithClient } }));
vi.mock('./settings.service.js', () => ({ settingsService: { invalidateCache: h.invalidateCache } }));

import { AccountEmailError, changeAccountEmail, replaceEmailInAllowlist } from './account-email.service.js';

const USER_ID = '3ffe0987-39b1-48b0-af45-2dddf8ccd907';
const req = { ip: '127.0.0.1', headers: {}, socket: {} } as unknown as Request;
const run = (newEmail = 'new@su10.ru') => changeAccountEmail({ req, userId: USER_ID, newEmail, actorId: 'actor-1' });
const sqlIssued = (prefix: string): boolean => calls.some(c => c.sql.startsWith(prefix));

beforeEach(() => {
  calls.length = 0;
  h.txLog.length = 0;
  client.query.mockClear();
  h.findActive.mockReset().mockResolvedValue({ strong: [], weak: [] });
  h.recordHistory.mockReset().mockResolvedValue(undefined);
  h.logFromRequestWithClient.mockReset().mockResolvedValue(undefined);
  h.invalidateCache.mockReset();
  state = {
    target: { email: 'old@su10.ru', email_confirmed: true, employee_id: 42 },
    taken: false,
    uniqueViolationOnUpdate: false,
    cardEmail: null,
    allowlist: '',
  };
});

describe('changeAccountEmail: без изменений', () => {
  it('та же неподтверждённая почта — флаг возвращается как есть, записей нет', async () => {
    state.target = { email: 'old@su10.ru', email_confirmed: false, employee_id: 42 };
    const result = await run(' Old@SU10.ru ');
    expect(result).toEqual({
      unchanged: true, email: 'old@su10.ru', emailConfirmed: false, cardUpdated: false, allowlistUpdated: false,
    });
    expect(calls.filter(c => c.sql.startsWith('UPDATE'))).toHaveLength(0);
    expect(h.logFromRequestWithClient).not.toHaveBeenCalled();
  });

  it('учётки нет → NOT_FOUND', async () => {
    state.target = null;
    await expect(run()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('changeAccountEmail: отказы с откатом', () => {
  it('почта занята другой учёткой → DUPLICATE_EMAIL, логин не тронут', async () => {
    state.taken = true;
    await expect(run()).rejects.toMatchObject({ code: 'DUPLICATE_EMAIL' });
    expect(sqlIssued('UPDATE app_auth.users')).toBe(false);
    expect(h.txLog).toContain('ROLLBACK');
  });

  it('гонка: 23505 на UPDATE → DUPLICATE_EMAIL', async () => {
    state.uniqueViolationOnUpdate = true;
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountEmailError);
    expect((err as AccountEmailError).code).toBe('DUPLICATE_EMAIL');
    expect(h.txLog).toContain('ROLLBACK');
    expect(h.logFromRequestWithClient).not.toHaveBeenCalled();
  });

  it('почта в чёрном списке, даже на этой же учётке → BLACKLISTED', async () => {
    h.findActive.mockResolvedValue({
      strong: [{ id: 'b1', user_profile_id: USER_ID, created_by_name: 'Иванов', reason: 'нарушение', match_reason: 'email' }],
      weak: [],
    });
    await expect(run()).rejects.toMatchObject({ code: 'BLACKLISTED' });
    expect(h.findActive).toHaveBeenCalledWith({ email: 'new@su10.ru' }, client);
    expect(sqlIssued('UPDATE app_auth.users')).toBe(false);
  });

  it('сбой записи истории кадров → откат, кеш настроек не сброшен', async () => {
    state.cardEmail = 'old@su10.ru';
    state.allowlist = 'old@su10.ru';
    h.recordHistory.mockRejectedValue(new Error('history down'));
    await expect(run()).rejects.toThrow('history down');
    expect(h.txLog).toEqual(['BEGIN', 'ROLLBACK']);
    expect(h.invalidateCache).not.toHaveBeenCalled();
  });

  it('сбой журнала → откат', async () => {
    h.logFromRequestWithClient.mockRejectedValue(new Error('audit down'));
    await expect(run()).rejects.toThrow('audit down');
    expect(h.txLog).toEqual(['BEGIN', 'ROLLBACK']);
  });
});

describe('changeAccountEmail: смена', () => {
  it('логин нормализован и подтверждён, ссылка сброса пароля погашена, журнал в транзакции', async () => {
    const result = await run('  New@SU10.ru ');
    expect(result).toEqual({
      unchanged: false, email: 'new@su10.ru', emailConfirmed: true, cardUpdated: false, allowlistUpdated: false,
    });
    const update = calls.find(c => c.sql.startsWith('UPDATE app_auth.users'));
    expect(update?.sql).toContain('email_confirmed_at = now()');
    expect(update?.params).toEqual(['new@su10.ru', USER_ID]);
    expect(sqlIssued('UPDATE public.user_profiles SET reset_token = NULL')).toBe(true);
    expect(h.logFromRequestWithClient).toHaveBeenCalledWith(client, req, 'actor-1', 'EMAIL_CHANGED', {
      entityType: 'user',
      entityId: USER_ID,
      details: { old_email: 'old@su10.ru', new_email: 'new@su10.ru', card_updated: false, allowlist_updated: false },
    });
    expect(h.txLog).toEqual(['BEGIN', 'COMMIT']);
  });

  it('в карточке та же старая почта (другой регистр, пробелы) → меняется, в историю — фактическое значение', async () => {
    state.cardEmail = ' Old@SU10.ru ';
    const result = await run();
    expect(result.cardUpdated).toBe(true);
    const update = calls.find(c => c.sql.startsWith('UPDATE public.employees'));
    expect(update?.params).toEqual(['new@su10.ru', 42]);
    expect(h.recordHistory).toHaveBeenCalledWith(client, 42, 'profile_update', {
      changedFields: ['email'],
      oldValues: { email: ' Old@SU10.ru ' },
      actor: { userId: 'actor-1' },
      source: 'admin',
    });
  });

  it.each([
    ['пустая', null],
    ['другая', 'personal@mail.ru'],
  ])('в карточке %s почта → не трогаем', async (_label, cardEmail) => {
    state.cardEmail = cardEmail;
    const result = await run();
    expect(result.cardUpdated).toBe(false);
    expect(sqlIssued('UPDATE public.employees')).toBe(false);
    expect(h.recordHistory).not.toHaveBeenCalled();
  });

  it('учётка без сотрудника → карточку не читаем', async () => {
    state.target = { email: 'old@su10.ru', email_confirmed: true, employee_id: null };
    await run();
    expect(sqlIssued('SELECT email FROM public.employees')).toBe(false);
  });

  it('старая почта в allowlist тестирования → заменена в транзакции, кеш настроек сброшен после COMMIT', async () => {
    state.allowlist = 'a@su10.ru, OLD@su10.ru';
    const result = await run();
    expect(result.allowlistUpdated).toBe(true);
    const update = calls.find(c => c.sql.startsWith('UPDATE public.system_settings'));
    expect(update?.params).toEqual(['a@su10.ru, new@su10.ru', 'actor-1', 'adaptive_testing_allowed_emails']);
    expect(h.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it.each([['*'], [''], ['a@su10.ru']])('allowlist «%s» → не трогаем', async (allowlist) => {
    state.allowlist = allowlist;
    const result = await run();
    expect(result.allowlistUpdated).toBe(false);
    expect(sqlIssued('UPDATE public.system_settings')).toBe(false);
    expect(h.invalidateCache).not.toHaveBeenCalled();
  });

  it('настройки allowlist нет вовсе → не трогаем', async () => {
    state.allowlist = undefined;
    expect((await run()).allowlistUpdated).toBe(false);
  });
});

describe('replaceEmailInAllowlist', () => {
  it('заменяет без учёта регистра, остальные записи и их форма — как были', () => {
    expect(replaceEmailInAllowlist('a@x.ru,  Old@X.ru ,b@x.ru', 'old@x.ru', 'new@x.ru')).toBe('a@x.ru,  new@x.ru,b@x.ru');
  });

  it('новая уже в списке → старая просто убирается', () => {
    expect(replaceEmailInAllowlist('old@x.ru, new@x.ru', 'old@x.ru', 'new@x.ru')).toBe('new@x.ru');
  });

  it('старой нет, «*» и пусто → null', () => {
    expect(replaceEmailInAllowlist('a@x.ru', 'old@x.ru', 'new@x.ru')).toBeNull();
    expect(replaceEmailInAllowlist('*', 'old@x.ru', 'new@x.ru')).toBeNull();
    expect(replaceEmailInAllowlist(null, 'old@x.ru', 'new@x.ru')).toBeNull();
  });
});
