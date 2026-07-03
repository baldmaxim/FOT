import crypto from 'crypto';
import { execute, query, queryOne } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { assertMtsBusinessBaseUrlAllowed, DEFAULT_MTS_BUSINESS_BASE_URL } from './settings.service.js';

// Аккаунты МТС «Бизнес» — несколько API/лицевых счетов, у каждого свои
// логин/пароль (+ опц. base URL). Пароль шифруется (AES-256-GCM), в открытом
// виде не отдаётся. id генерируется на бэке.

export interface IMtsBusinessAccountPublic {
  id: string;
  label: string;
  accountNumber: string | null;
  login: string;
  baseUrl: string;
  isActive: boolean;
  hasPassword: boolean;
  rateLimitPerMin: number;
  createdAt: string;
  updatedAt: string;
}

export interface IMtsBusinessResolvedAccount {
  id: string;
  label: string;
  baseUrl: string;
  login: string;
  password: string;
  rateLimitPerMin: number;
}

interface AccountRow {
  id: string;
  label: string;
  account_number: string | null;
  login: string;
  password_enc: string;
  base_url: string | null;
  is_active: boolean;
  rate_limit_per_min: number;
  created_at: string;
  updated_at: string;
}

const toPublic = (r: AccountRow): IMtsBusinessAccountPublic => ({
  id: r.id,
  label: r.label,
  accountNumber: r.account_number,
  login: r.login,
  baseUrl: (r.base_url || '').trim() || DEFAULT_MTS_BUSINESS_BASE_URL,
  isActive: r.is_active,
  hasPassword: Boolean(r.password_enc),
  rateLimitPerMin: r.rate_limit_per_min,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

class MtsBusinessAccountsService {
  async list(): Promise<IMtsBusinessAccountPublic[]> {
    const rows = await query<AccountRow>(
      `SELECT id, label, account_number, login, password_enc, base_url, is_active, rate_limit_per_min, created_at, updated_at
         FROM mts_business_accounts
        ORDER BY created_at ASC`,
    );
    return rows.map(toPublic);
  }

  /** Резолв кредов аккаунта (пароль расшифрован). null — если нет/неактивен/битый пароль. */
  async getResolvedAccount(id: string): Promise<IMtsBusinessResolvedAccount | null> {
    const r = await queryOne<AccountRow>(
      `SELECT id, label, account_number, login, password_enc, base_url, is_active, rate_limit_per_min, created_at, updated_at
         FROM mts_business_accounts WHERE id = $1`,
      [id],
    );
    if (!r || !r.is_active) return null;
    const password = encryptionService.decryptField(r.password_enc);
    if (!password) return null;
    const baseUrl = (r.base_url || '').trim() || DEFAULT_MTS_BUSINESS_BASE_URL;
    assertMtsBusinessBaseUrlAllowed(baseUrl);
    return { id: r.id, label: r.label, baseUrl, login: r.login, password, rateLimitPerMin: r.rate_limit_per_min };
  }

  async create(
    input: {
      label: string; accountNumber?: string | null; login: string; password: string;
      baseUrl?: string | null; isActive?: boolean; rateLimitPerMin?: number;
    },
    userId: string,
  ): Promise<IMtsBusinessAccountPublic[]> {
    const label = input.label?.trim();
    const login = input.login?.trim();
    const password = input.password?.trim();
    if (!label || !login || !password) {
      throw new Error('МТС Бизнес: укажите название, логин и пароль аккаунта');
    }
    const baseUrl = input.baseUrl?.trim() || null;
    if (baseUrl) assertMtsBusinessBaseUrlAllowed(baseUrl);
    const rateLimitPerMin = input.rateLimitPerMin && input.rateLimitPerMin > 0 ? Math.floor(input.rateLimitPerMin) : 60;
    const id = crypto.randomUUID();
    await execute(
      `INSERT INTO mts_business_accounts
         (id, label, account_number, login, password_enc, base_url, is_active, rate_limit_per_min, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
      [id, label, input.accountNumber?.trim() || null, login, encryptionService.encrypt(password), baseUrl, input.isActive ?? true, rateLimitPerMin, userId],
    );
    return this.list();
  }

  async update(
    id: string,
    input: {
      label?: string; accountNumber?: string | null; login?: string; password?: string | null;
      baseUrl?: string | null; isActive?: boolean; rateLimitPerMin?: number;
    },
    _userId: string,
  ): Promise<IMtsBusinessAccountPublic[]> {
    const existing = await queryOne<{ id: string }>('SELECT id FROM mts_business_accounts WHERE id = $1', [id]);
    if (!existing) throw new Error('Аккаунт не найден');

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (input.label !== undefined) {
      const v = input.label.trim();
      if (!v) throw new Error('Название не может быть пустым');
      push('label', v);
    }
    if (input.accountNumber !== undefined) push('account_number', input.accountNumber?.trim() || null);
    if (input.login !== undefined) {
      const v = input.login.trim();
      if (!v) throw new Error('Логин не может быть пустым');
      push('login', v);
    }
    if (input.baseUrl !== undefined) {
      const v = input.baseUrl?.trim() || null;
      if (v) assertMtsBusinessBaseUrlAllowed(v);
      push('base_url', v);
    }
    if (input.isActive !== undefined) push('is_active', input.isActive);
    if (input.rateLimitPerMin !== undefined) {
      if (!Number.isFinite(input.rateLimitPerMin) || input.rateLimitPerMin <= 0) {
        throw new Error('Лимит запросов/мин должен быть положительным числом');
      }
      push('rate_limit_per_min', Math.floor(input.rateLimitPerMin));
    }
    // Пароль меняем только если передана непустая строка (пустая = не трогаем).
    if (input.password !== undefined && input.password !== null && input.password.trim() !== '') {
      push('password_enc', encryptionService.encrypt(input.password.trim()));
    }

    if (sets.length > 0) {
      params.push(id);
      await execute(
        `UPDATE mts_business_accounts SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
        params,
      );
    }
    return this.list();
  }

  async remove(id: string): Promise<IMtsBusinessAccountPublic[]> {
    await execute('DELETE FROM mts_business_accounts WHERE id = $1', [id]);
    return this.list();
  }
}

export const mtsBusinessAccountsService = new MtsBusinessAccountsService();
