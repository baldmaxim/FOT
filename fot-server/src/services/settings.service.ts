import { execute, query } from '../config/postgres.js';

// Лениво: encryption.service инициализирует ключ на module-load (бросает без
// валидного ENCRYPTION_KEY). Грузим только при вызове МТС-методов, чтобы не
// тащить его в модули/тесты, которые мокают env без ENCRYPTION_KEY.
const getEncryption = async () => (await import('./encryption.service.js')).encryptionService;

interface ISetting {
  key: string;
  value: string | null;
  description: string | null;
  is_secret: boolean;
  updated_at: string;
}

export interface ISigurMonitorSettings {
  enabled: boolean;
  failureThreshold: number;
  recoveryThreshold: number;
  silenceWindowMinutes: number;
  baselineLookbackDays: number;
  baselineMinEvents: number;
  alertCooldownMinutes: number;
  timezone: string;
}

export interface ISkudTravelSettings {
  limitMinutes: number | null;
}

export interface ITimesheetReminderSettings {
  enabled: boolean;
  timezone: string;
  openingReminderHour: number;
  deadlineMorningHour: number;
  deadlineAfternoonHour: number;
  escalationHour: number;
  overdueHour: number;
}

export interface IEmployeeTransferSettings {
  freezeHistory: boolean;
}

export interface IDashboardSettings {
  /** Коды system_roles, считающихся «руководителями» в Карте руководителей дашборда HR. */
  managerRoleCodes: string[];
}

export interface IOpenRouterModelInfo {
  id: string;
  label: string;
  costPer1kReceiptsRub: number;
  supportsVision: boolean;
  /** Разрешена для распознавания чеков (OCR). */
  allowedForReceiptOcr: boolean;
  /** Разрешена для адаптивного тестирования. */
  allowedForAdaptiveTesting: boolean;
}

export interface IOpenRouterPublicSettings {
  enabled: boolean;
  hasApiKey: boolean;
  model: string;
  baseUrl: string;
  source: 'system_settings' | 'env' | 'unset';
  allowedModels: IOpenRouterModelInfo[];
}

export interface IOpenRouterResolvedConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  source: 'system_settings' | 'env';
}

export const ALLOWED_OPENROUTER_MODELS: IOpenRouterModelInfo[] = [
  { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B (бесплатно)', costPer1kReceiptsRub: 0, supportsVision: true, allowedForReceiptOcr: true, allowedForAdaptiveTesting: false },
  { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (бесплатно)', costPer1kReceiptsRub: 0, supportsVision: true, allowedForReceiptOcr: true, allowedForAdaptiveTesting: false },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (платно)', costPer1kReceiptsRub: 70, supportsVision: true, allowedForReceiptOcr: true, allowedForAdaptiveTesting: false },
  { id: 'google/gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite (платно)', costPer1kReceiptsRub: 45, supportsVision: true, allowedForReceiptOcr: true, allowedForAdaptiveTesting: false },
  { id: 'qwen/qwen3.7-plus', label: 'Qwen3.7 Plus (платно)', costPer1kReceiptsRub: 90, supportsVision: true, allowedForReceiptOcr: true, allowedForAdaptiveTesting: false },
  { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna (тестирование)', costPer1kReceiptsRub: 0, supportsVision: true, allowedForReceiptOcr: false, allowedForAdaptiveTesting: true },
];

export const DEFAULT_OPENROUTER_SETTINGS = {
  enabled: false,
  model: 'google/gemma-4-26b-a4b-it:free',
  baseUrl: 'https://openrouter.ai/api/v1',
};

/** Модель есть в каталоге (для override в openrouter.service). */
export const isKnownOpenRouterModel = (modelId: string): boolean =>
  ALLOWED_OPENROUTER_MODELS.some(x => x.id === modelId);

/** Модель разрешена для распознавания чеков (OCR-конфиг и повторный прогон). */
export const isAllowedOcrModel = (modelId: string): boolean => {
  const m = ALLOWED_OPENROUTER_MODELS.find(x => x.id === modelId);
  return Boolean(m && m.allowedForReceiptOcr);
};

/** Модель разрешена для адаптивного тестирования. */
export const isAllowedTextModel = (modelId: string): boolean => {
  const m = ALLOWED_OPENROUTER_MODELS.find(x => x.id === modelId);
  return Boolean(m && m.allowedForAdaptiveTesting);
};

// ─── Адаптивное тестирование: конфигурация LLM ───────────────────────────────

/**
 * Anti-SSRF: LLM-вызовы уходят только на точные адреса из этого списка.
 * Прямой openrouter.ai с сервера недоступен — трафик идёт через прокси.
 * Расширение списка — только правкой кода (не через UI).
 */
export const TRUSTED_LLM_BASE_URLS = [
  'https://proxyllm.fvds.ru/api/v1',
];

export const isTrustedLlmBaseUrl = (url: string): boolean => {
  const normalized = url.trim().replace(/\/+$/, '');
  return TRUSTED_LLM_BASE_URLS.some(t => t.replace(/\/+$/, '') === normalized);
};

export const DEFAULT_ADAPTIVE_TESTING_MODEL = 'openai/gpt-5.6-luna';

export type AdaptiveConnectionMode = 'shared_proxy' | 'dedicated_proxy';

export interface IAdaptiveTestingPublicSettings {
  enabled: boolean;
  model: string;
  /** Сырое значение allowlist (CSV или '*'). */
  allowedEmails: string;
  dailySessionsLimit: number;
  connectionMode: AdaptiveConnectionMode;
  zdrRequired: boolean;
  hasDedicatedApiKey: boolean;
  dedicatedBaseUrl: string | null;
  /** Итоговый base URL (для отображения), null если конфиг не собирается. */
  effectiveBaseUrl: string | null;
  trustedBaseUrls: string[];
  allowedModels: IOpenRouterModelInfo[];
}

export type AdaptiveLlmConfigResult =
  | { ok: true; apiKey: string; baseUrl: string; model: string; zdrRequired: boolean; connectionMode: AdaptiveConnectionMode }
  | { ok: false; reason: 'disabled' | 'no_api_key' | 'invalid_base_url' | 'invalid_model' };

export type SigurConnectionSettingsSource = 'system_settings' | 'env' | 'unset';

export interface ISigurConnectionPublicConfig {
  url: string;
  username: string;
  hasPassword: boolean;
  source: SigurConnectionSettingsSource;
}

export interface ISigurConnectionResolvedConfig {
  url: string;
  username: string;
  password: string;
  source: Exclude<SigurConnectionSettingsSource, 'unset'>;
}

export interface ISigurConnectionSettings {
  internal: ISigurConnectionPublicConfig;
  external: ISigurConnectionPublicConfig;
  archiveDepartmentId: number | null;
  archiveDepartmentName: string | null;
}

export interface IMtsConnectionPublicSettings {
  baseUrl: string;
  hasToken: boolean;
  source: 'system_settings' | 'env' | 'unset';
}

export interface IMtsResolvedConfig {
  baseUrl: string;
  token: string;
  source: 'system_settings' | 'env';
}

/** Расписание ежедневного автопрогона «Обновить всё» модуля МТС Бизнес. */
export interface IMtsBusinessRefreshAllScheduleSettings {
  enabled: boolean;
  hourMsk: number;
}

// enabled=false по умолчанию: после деплоя автопрогон не стартует сам,
// его явно включают в админке МТС Бизнес.
export const DEFAULT_MTS_BUSINESS_REFRESH_ALL_SCHEDULE: IMtsBusinessRefreshAllScheduleSettings = {
  enabled: false,
  hourMsk: 23,
};

/**
 * Непрерывный конвейер свежести выписки (mts-business-statement-rolling).
 * budgetSharePercent — доля rate-limit аккаунта, которую можно тратить фоново
 * (остальное остаётся живым вызовам UI: карточка абонента, «Загрузить доступные»).
 */
export interface IMtsBusinessRollingSettings {
  enabled: boolean;
  budgetSharePercent: number; // 10..90
  hotMinutes: number;         // как часто обновлять «горячие» номера
  coldHours: number;          // как часто обновлять «молчунов»
}

// enabled=false по умолчанию: после деплоя конвейер не стартует сам —
// включают в админке МТС Бизнес, убедившись, что миграция 220 применена.
export const DEFAULT_MTS_BUSINESS_ROLLING: IMtsBusinessRollingSettings = {
  enabled: false,
  budgetSharePercent: 70,
  hotMinutes: 15,
  coldHours: 6,
};

export const DEFAULT_MTS_BASE_URL = 'https://api.mpoisk.ru/v6/api';

/** МТС «Бизнес» (Business API) — база v1. Детализация звонков.
 *  Креды (несколько аккаунтов) — в таблице mts_business_accounts,
 *  см. mts-business-accounts.service.ts. */
export const DEFAULT_MTS_BUSINESS_BASE_URL = 'https://api.mts.ru/b2b/v1';

/**
 * Allow-list хостов МТС API. Защита от SSRF / увода токена через подмену
 * base URL: даже админ с edit-доступом не может направить интеграцию на
 * чужой хост. Расширять список только при подтверждённой смене вендором.
 */
export const MTS_ALLOWED_HOSTS = ['api.mpoisk.ru'] as const;

/** Проверяет URL: https + хост из allow-list. Бросает с человекочитаемой ошибкой. */
export const assertMtsBaseUrlAllowed = (raw: string): void => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MTS base URL: невалидный URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('MTS base URL: разрешён только https://');
  }
  if (!(MTS_ALLOWED_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new Error(
      `MTS base URL: хост "${url.hostname}" не в allow-list (разрешены: ${MTS_ALLOWED_HOSTS.join(', ')})`,
    );
  }
};

/**
 * Allow-list хостов МТС «Бизнес» API. Та же защита от SSRF/увода кредов, что и
 * у M-Poisk: даже админ с edit-доступом не может направить интеграцию на чужой
 * хост. Расширять только при подтверждённой смене вендором.
 */
export const MTS_BUSINESS_ALLOWED_HOSTS = ['api.mts.ru'] as const;

/** Проверяет URL МТС Бизнес: https + хост из allow-list. */
export const assertMtsBusinessBaseUrlAllowed = (raw: string): void => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MTS Business base URL: невалидный URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('MTS Business base URL: разрешён только https://');
  }
  if (!(MTS_BUSINESS_ALLOWED_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new Error(
      `MTS Business base URL: хост "${url.hostname}" не в allow-list (разрешены: ${MTS_BUSINESS_ALLOWED_HOSTS.join(', ')})`,
    );
  }
};

/** newdb.net — проверка физлиц по РКЛ и патентам. Единый POST-эндпоинт v2. */
export const DEFAULT_NEWDB_BASE_URL = 'https://api.newdb.net/v2';

/**
 * Allow-list хостов newdb.net. Та же защита от SSRF/увода токена, что у МТС:
 * даже админ с edit-доступом не может направить интеграцию на чужой хост.
 */
export const NEWDB_ALLOWED_HOSTS = ['api.newdb.net'] as const;

/** Проверяет URL newdb: https + хост из allow-list + без userinfo. */
export const assertNewdbBaseUrlAllowed = (raw: string): void => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('newdb base URL: невалидный URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('newdb base URL: разрешён только https://');
  }
  if (url.username || url.password) {
    throw new Error('newdb base URL: userinfo в URL запрещён');
  }
  if (!(NEWDB_ALLOWED_HOSTS as readonly string[]).includes(url.hostname)) {
    throw new Error(
      `newdb base URL: хост "${url.hostname}" не в allow-list (разрешены: ${NEWDB_ALLOWED_HOSTS.join(', ')})`,
    );
  }
};

export interface INewdbConnectionPublicSettings {
  baseUrl: string;
  hasToken: boolean;
  source: 'system_settings' | 'env' | 'unset';
}

export interface INewdbResolvedConfig {
  baseUrl: string;
  token: string;
  source: 'system_settings' | 'env';
}

export const DEFAULT_SIGUR_MONITOR_SETTINGS: ISigurMonitorSettings = {
  enabled: true,
  failureThreshold: 2,
  recoveryThreshold: 2,
  silenceWindowMinutes: 15,
  baselineLookbackDays: 28,
  baselineMinEvents: 5,
  alertCooldownMinutes: 60,
  timezone: 'Europe/Moscow',
};

export const DEFAULT_TIMESHEET_REMINDER_SETTINGS: ITimesheetReminderSettings = {
  enabled: true,
  timezone: 'Europe/Moscow',
  openingReminderHour: 9,
  deadlineMorningHour: 10,
  deadlineAfternoonHour: 16,
  escalationHour: 17,
  overdueHour: 9,
};

export const DEFAULT_EMPLOYEE_TRANSFER_SETTINGS: IEmployeeTransferSettings = {
  freezeHistory: false,
};

export const DEFAULT_DASHBOARD_MANAGER_ROLE_CODES = ['manager', 'manager_obj', 'site_supervisor'];

let cache: Map<string, string | null> = new Map();
let cacheLoadedAt = 0;
const CACHE_TTL = 60_000; // 60 сек

const isSecretKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return normalized.includes('secret')
    || normalized.includes('key')
    || normalized.includes('password')
    || normalized.includes('token');
};

const parseBoolean = (value: string | null | undefined, fallback: boolean): boolean => {
  if (value == null) return fallback;
  return value === 'true' || value === '1';
};

const parsePositiveInt = (value: string | null | undefined, fallback: number): number => {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseNullablePositiveInt = (value: string | null | undefined): number | null => {
  if (value == null || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseHour = (value: string | null | undefined, fallback: number): number => {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
};

const parseCsvCodes = (value: string | null | undefined, fallback: string[]): string[] => {
  if (value == null) return fallback;
  const codes = value.split(',').map(c => c.trim()).filter(Boolean);
  return codes.length > 0 ? codes : fallback;
};
const loadCache = async () => {
  if (Date.now() - cacheLoadedAt < CACHE_TTL && cache.size > 0) return;
  const rows = await query<{ key: string; value: string | null }>(
    'SELECT key, value FROM system_settings',
  );
  cache = new Map(rows.map(s => [s.key, s.value]));
  cacheLoadedAt = Date.now();
};

export const settingsService = {
  async get(key: string): Promise<string | null> {
    await loadCache();
    return cache.get(key) ?? null;
  },

  async getMultiple(keys: string[]): Promise<Record<string, string | null>> {
    await loadCache();
    const result: Record<string, string | null> = {};
    for (const key of keys) {
      result[key] = cache.get(key) ?? null;
    }
    return result;
  },

  async set(key: string, value: string | null, userId: string, description?: string): Promise<void> {
    await execute(
      `INSERT INTO system_settings (key, value, description, is_secret, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         description = EXCLUDED.description,
         is_secret = EXCLUDED.is_secret,
         updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by`,
      [key, value, description || null, isSecretKey(key), new Date().toISOString(), userId],
    );
    cache.set(key, value);
  },

  async setMultiple(entries: { key: string; value: string | null; description?: string }[], userId: string | null): Promise<void> {
    if (entries.length === 0) return;
    const updatedAt = new Date().toISOString();
    const params: unknown[] = [];
    const valueGroups: string[] = [];
    for (const e of entries) {
      params.push(e.key, e.value, e.description || null, isSecretKey(e.key), updatedAt, userId);
      const base = params.length;
      valueGroups.push(`($${base - 5}, $${base - 4}, $${base - 3}, $${base - 2}, $${base - 1}, $${base})`);
    }
    await execute(
      `INSERT INTO system_settings (key, value, description, is_secret, updated_at, updated_by)
       VALUES ${valueGroups.join(', ')}
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         description = EXCLUDED.description,
         is_secret = EXCLUDED.is_secret,
         updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by`,
      params,
    );
    for (const e of entries) cache.set(e.key, e.value);
  },

  /** Все настройки (для admin UI). Секретные значения маскируются. */
  async getAll(): Promise<ISetting[]> {
    const rows = await query<ISetting>(
      'SELECT key, value, description, is_secret, updated_at FROM system_settings ORDER BY key',
    );
    return rows.map(s => ({
      ...s,
      value: s.is_secret && s.value ? '••••••••' : s.value,
    }));
  },

  /** Получить R2 / S3-совместимый конфиг (из БД, фоллбэк на .env) */
  async getR2Config(): Promise<{
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    endpoint: string;
    region: string;
    forcePathStyle: boolean;
    kmsKeyId: string;
    enabled: boolean;
  }> {
    await loadCache();
    const accountId = (cache.get('r2_account_id') || process.env.R2_ACCOUNT_ID || '').trim();
    const accessKeyId = (cache.get('r2_access_key_id') || process.env.R2_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = cache.get('r2_secret_access_key') || process.env.R2_SECRET_ACCESS_KEY || '';
    const bucketName = cache.get('r2_bucket_name') || process.env.R2_BUCKET_NAME || 'fot-documents';
    const endpoint = (cache.get('r2_endpoint') || process.env.R2_ENDPOINT || '').trim();
    const region = (cache.get('r2_region') || process.env.R2_REGION || 'auto').trim();
    const forcePathStyle = (cache.get('r2_force_path_style') || process.env.R2_FORCE_PATH_STYLE || '') === 'true';
    const kmsKeyId = (cache.get('r2_kms_key_id') || process.env.R2_KMS_KEY_ID || '').trim();
    return {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucketName,
      endpoint,
      region,
      forcePathStyle,
      kmsKeyId,
      enabled: !!(accessKeyId && secretAccessKey && (accountId || endpoint)),
    };
  },

  async getSigurConnectionSettings(): Promise<ISigurConnectionSettings> {
    await loadCache();

    const buildConfig = (
      scope: 'internal' | 'external',
      envUrl?: string,
      envUsername?: string,
      envPassword?: string,
    ): ISigurConnectionPublicConfig => {
      const settingsUrl = cache.get(`sigur_${scope}_url`) || '';
      const settingsUsername = cache.get(`sigur_${scope}_username`) || '';
      const settingsPassword = cache.get(`sigur_${scope}_password`) || '';

      if (settingsUrl && settingsUsername && settingsPassword) {
        return {
          url: settingsUrl,
          username: settingsUsername,
          hasPassword: true,
          source: 'system_settings',
        };
      }

      if (envUrl && envUsername && envPassword) {
        return {
          url: envUrl,
          username: envUsername,
          hasPassword: true,
          source: 'env',
        };
      }

      return {
        url: settingsUrl || envUrl || '',
        username: settingsUsername || envUsername || '',
        hasPassword: Boolean(settingsPassword || envPassword),
        source: 'unset',
      };
    };

    const archiveDepartmentIdRaw = cache.get('sigur_archive_department_id');
    const archiveDepartmentName = cache.get('sigur_archive_department_name') || null;
    const archiveDepartmentId = archiveDepartmentIdRaw && /^\d+$/.test(archiveDepartmentIdRaw)
      ? Number(archiveDepartmentIdRaw)
      : null;

    return {
      internal: buildConfig(
        'internal',
        process.env.SIGUR_INTERNAL_URL,
        process.env.SIGUR_INTERNAL_USERNAME,
        process.env.SIGUR_INTERNAL_PASSWORD,
      ),
      external: buildConfig(
        'external',
        process.env.SIGUR_EXTERNAL_URL,
        process.env.SIGUR_EXTERNAL_USERNAME,
        process.env.SIGUR_EXTERNAL_PASSWORD,
      ),
      archiveDepartmentId,
      archiveDepartmentName,
    };
  },

  async getResolvedSigurConnectionConfig(
    scope: 'internal' | 'external',
  ): Promise<ISigurConnectionResolvedConfig | null> {
    await loadCache();

    const settingsUrl = cache.get(`sigur_${scope}_url`) || '';
    const settingsUsername = cache.get(`sigur_${scope}_username`) || '';
    const settingsPassword = cache.get(`sigur_${scope}_password`) || '';

    if (settingsUrl && settingsUsername && settingsPassword) {
      return {
        url: settingsUrl,
        username: settingsUsername,
        password: settingsPassword,
        source: 'system_settings',
      };
    }

    const envUrl = scope === 'internal' ? process.env.SIGUR_INTERNAL_URL : process.env.SIGUR_EXTERNAL_URL;
    const envUsername = scope === 'internal' ? process.env.SIGUR_INTERNAL_USERNAME : process.env.SIGUR_EXTERNAL_USERNAME;
    const envPassword = scope === 'internal' ? process.env.SIGUR_INTERNAL_PASSWORD : process.env.SIGUR_EXTERNAL_PASSWORD;

    if (envUrl && envUsername && envPassword) {
      return {
        url: envUrl,
        username: envUsername,
        password: envPassword,
        source: 'env',
      };
    }

    return null;
  },

  async setSigurConnectionSettings(
    config: {
      internal?: { url?: string | null; username?: string | null; password?: string | null };
      external?: { url?: string | null; username?: string | null; password?: string | null };
      archiveDepartmentId?: number | null;
      archiveDepartmentName?: string | null;
    },
    userId: string | null,
  ): Promise<ISigurConnectionSettings> {
    const entries: { key: string; value: string | null; description?: string }[] = [];

    const upsertConnectionEntries = (
      scope: 'internal' | 'external',
      values?: { url?: string | null; username?: string | null; password?: string | null },
    ) => {
      if (!values) return;

      if (values.url !== undefined) {
        entries.push({
          key: `sigur_${scope}_url`,
          value: values.url?.trim() || null,
          description: `Sigur ${scope} URL override`,
        });
      }

      if (values.username !== undefined) {
        entries.push({
          key: `sigur_${scope}_username`,
          value: values.username?.trim() || null,
          description: `Sigur ${scope} username override`,
        });
      }

      if (values.password !== undefined) {
        entries.push({
          key: `sigur_${scope}_password`,
          value: values.password || null,
          description: `Sigur ${scope} password override`,
        });
      }
    };

    upsertConnectionEntries('internal', config.internal);
    upsertConnectionEntries('external', config.external);

    if (config.archiveDepartmentId !== undefined) {
      entries.push({
        key: 'sigur_archive_department_id',
        value: config.archiveDepartmentId == null ? null : String(config.archiveDepartmentId),
        description: 'Sigur archive department ID for fired employees',
      });
    }

    if (config.archiveDepartmentName !== undefined) {
      entries.push({
        key: 'sigur_archive_department_name',
        value: config.archiveDepartmentName?.trim() || null,
        description: 'Sigur archive department name for fired employees',
      });
    }

    if (entries.length > 0) {
      await this.setMultiple(entries, userId);
      this.invalidateCache();
    }

    return this.getSigurConnectionSettings();
  },

  async getSigurMonitorConfig(): Promise<ISigurMonitorSettings> {
    const values = await this.getMultiple([
      'sigur_monitor_enabled',
      'sigur_monitor_failure_threshold',
      'sigur_monitor_recovery_threshold',
      'sigur_monitor_silence_window_minutes',
      'sigur_monitor_baseline_lookback_days',
      'sigur_monitor_baseline_min_events',
      'sigur_monitor_alert_cooldown_minutes',
      'sigur_monitor_timezone',
    ]);

    return {
      enabled: parseBoolean(values.sigur_monitor_enabled, DEFAULT_SIGUR_MONITOR_SETTINGS.enabled),
      failureThreshold: parsePositiveInt(values.sigur_monitor_failure_threshold, DEFAULT_SIGUR_MONITOR_SETTINGS.failureThreshold),
      recoveryThreshold: parsePositiveInt(values.sigur_monitor_recovery_threshold, DEFAULT_SIGUR_MONITOR_SETTINGS.recoveryThreshold),
      silenceWindowMinutes: parsePositiveInt(values.sigur_monitor_silence_window_minutes, DEFAULT_SIGUR_MONITOR_SETTINGS.silenceWindowMinutes),
      baselineLookbackDays: parsePositiveInt(values.sigur_monitor_baseline_lookback_days, DEFAULT_SIGUR_MONITOR_SETTINGS.baselineLookbackDays),
      baselineMinEvents: parsePositiveInt(values.sigur_monitor_baseline_min_events, DEFAULT_SIGUR_MONITOR_SETTINGS.baselineMinEvents),
      alertCooldownMinutes: parsePositiveInt(values.sigur_monitor_alert_cooldown_minutes, DEFAULT_SIGUR_MONITOR_SETTINGS.alertCooldownMinutes),
      timezone: values.sigur_monitor_timezone || DEFAULT_SIGUR_MONITOR_SETTINGS.timezone,
    };
  },

  async setSigurMonitorConfig(config: Partial<ISigurMonitorSettings>, userId: string): Promise<ISigurMonitorSettings> {
    const current = await this.getSigurMonitorConfig();
    const next: ISigurMonitorSettings = {
      enabled: config.enabled ?? current.enabled,
      failureThreshold: config.failureThreshold ?? current.failureThreshold,
      recoveryThreshold: config.recoveryThreshold ?? current.recoveryThreshold,
      silenceWindowMinutes: config.silenceWindowMinutes ?? current.silenceWindowMinutes,
      baselineLookbackDays: config.baselineLookbackDays ?? current.baselineLookbackDays,
      baselineMinEvents: config.baselineMinEvents ?? current.baselineMinEvents,
      alertCooldownMinutes: config.alertCooldownMinutes ?? current.alertCooldownMinutes,
      timezone: config.timezone ?? current.timezone,
    };

    await this.setMultiple([
      {
        key: 'sigur_monitor_enabled',
        value: String(next.enabled),
        description: 'Включить мониторинг инцидентов Sigur',
      },
      {
        key: 'sigur_monitor_failure_threshold',
        value: String(next.failureThreshold),
        description: 'Количество подряд неуспешных проверок для открытия инцидента',
      },
      {
        key: 'sigur_monitor_recovery_threshold',
        value: String(next.recoveryThreshold),
        description: 'Количество подряд успешных проверок для закрытия инцидента',
      },
      {
        key: 'sigur_monitor_silence_window_minutes',
        value: String(next.silenceWindowMinutes),
        description: 'Окно в минутах без событий для проверки тишины',
      },
      {
        key: 'sigur_monitor_baseline_lookback_days',
        value: String(next.baselineLookbackDays),
        description: 'Глубина lookback в днях для baseline трафика событий',
      },
      {
        key: 'sigur_monitor_baseline_min_events',
        value: String(next.baselineMinEvents),
        description: 'Минимальный baseline событий в слоте для детекции тишины',
      },
      {
        key: 'sigur_monitor_alert_cooldown_minutes',
        value: String(next.alertCooldownMinutes),
        description: 'Cooldown между уведомлениями о повторных инцидентах Sigur',
      },
      {
        key: 'sigur_monitor_timezone',
        value: next.timezone,
        description: 'IANA timezone для мониторинга Sigur',
      },
    ], userId);

    this.invalidateCache();
    return this.getSigurMonitorConfig();
  },

  async getTimesheetReminderConfig(): Promise<ITimesheetReminderSettings> {
    const values = await this.getMultiple([
      'timesheet_reminders_enabled',
      'timesheet_reminders_timezone',
      'timesheet_reminders_opening_hour',
      'timesheet_reminders_deadline_morning_hour',
      'timesheet_reminders_deadline_afternoon_hour',
      'timesheet_reminders_escalation_hour',
      'timesheet_reminders_overdue_hour',
    ]);

    return {
      enabled: parseBoolean(values.timesheet_reminders_enabled, DEFAULT_TIMESHEET_REMINDER_SETTINGS.enabled),
      timezone: values.timesheet_reminders_timezone || DEFAULT_TIMESHEET_REMINDER_SETTINGS.timezone,
      openingReminderHour: parseHour(values.timesheet_reminders_opening_hour, DEFAULT_TIMESHEET_REMINDER_SETTINGS.openingReminderHour),
      deadlineMorningHour: parseHour(values.timesheet_reminders_deadline_morning_hour, DEFAULT_TIMESHEET_REMINDER_SETTINGS.deadlineMorningHour),
      deadlineAfternoonHour: parseHour(values.timesheet_reminders_deadline_afternoon_hour, DEFAULT_TIMESHEET_REMINDER_SETTINGS.deadlineAfternoonHour),
      escalationHour: parseHour(values.timesheet_reminders_escalation_hour, DEFAULT_TIMESHEET_REMINDER_SETTINGS.escalationHour),
      overdueHour: parseHour(values.timesheet_reminders_overdue_hour, DEFAULT_TIMESHEET_REMINDER_SETTINGS.overdueHour),
    };
  },

  async setTimesheetReminderConfig(config: Partial<ITimesheetReminderSettings>, userId: string): Promise<ITimesheetReminderSettings> {
    const current = await this.getTimesheetReminderConfig();
    const next: ITimesheetReminderSettings = {
      enabled: config.enabled ?? current.enabled,
      timezone: config.timezone ?? current.timezone,
      openingReminderHour: config.openingReminderHour ?? current.openingReminderHour,
      deadlineMorningHour: config.deadlineMorningHour ?? current.deadlineMorningHour,
      deadlineAfternoonHour: config.deadlineAfternoonHour ?? current.deadlineAfternoonHour,
      escalationHour: config.escalationHour ?? current.escalationHour,
      overdueHour: config.overdueHour ?? current.overdueHour,
    };

    await this.setMultiple([
      {
        key: 'timesheet_reminders_enabled',
        value: String(next.enabled),
        description: 'Включить напоминания о подаче табеля',
      },
      {
        key: 'timesheet_reminders_timezone',
        value: next.timezone,
        description: 'IANA timezone для табельных напоминаний',
      },
      {
        key: 'timesheet_reminders_opening_hour',
        value: String(next.openingReminderHour),
        description: 'Час напоминания в день открытия периода табеля',
      },
      {
        key: 'timesheet_reminders_deadline_morning_hour',
        value: String(next.deadlineMorningHour),
        description: 'Час утреннего напоминания в день дедлайна табеля',
      },
      {
        key: 'timesheet_reminders_deadline_afternoon_hour',
        value: String(next.deadlineAfternoonHour),
        description: 'Час дневного напоминания в день дедлайна табеля',
      },
      {
        key: 'timesheet_reminders_escalation_hour',
        value: String(next.escalationHour),
        description: 'Час эскалации резервному ответственному по табелю',
      },
      {
        key: 'timesheet_reminders_overdue_hour',
        value: String(next.overdueHour),
        description: 'Час просроченного напоминания руководителю подразделения о подаче табеля',
      },
    ], userId);

    this.invalidateCache();
    return this.getTimesheetReminderConfig();
  },

  async getSkudTravelConfig(): Promise<ISkudTravelSettings> {
    const values = await this.getMultiple([
      'skud_travel_limit_minutes',
    ]);

    return {
      limitMinutes: parseNullablePositiveInt(values.skud_travel_limit_minutes),
    };
  },

  async setSkudTravelConfig(config: { limitMinutes: number }, userId: string): Promise<ISkudTravelSettings> {
    const limitMinutes = Math.max(1, Math.min(1440, Math.trunc(config.limitMinutes)));

    await this.setMultiple([
      {
        key: 'skud_travel_limit_minutes',
        value: String(limitMinutes),
        description: 'Единый лимит передвижения между объектами в минутах',
      },
    ], userId);

    this.invalidateCache();
    return this.getSkudTravelConfig();
  },

  async getEmployeeTransferConfig(): Promise<IEmployeeTransferSettings> {
    const values = await this.getMultiple(['employee_transfer_freeze_history']);
    return {
      freezeHistory: parseBoolean(
        values.employee_transfer_freeze_history,
        DEFAULT_EMPLOYEE_TRANSFER_SETTINGS.freezeHistory,
      ),
    };
  },

  async setEmployeeTransferConfig(
    config: Partial<IEmployeeTransferSettings>,
    userId: string,
  ): Promise<IEmployeeTransferSettings> {
    const current = await this.getEmployeeTransferConfig();
    const next: IEmployeeTransferSettings = {
      freezeHistory: config.freezeHistory ?? current.freezeHistory,
    };

    await this.setMultiple([
      {
        key: 'employee_transfer_freeze_history',
        value: String(next.freezeHistory),
        description: 'Заморозить историю переводов: при изменении отдела/должности обновлять открытое назначение вместо закрытия и создания нового',
      },
    ], userId);

    this.invalidateCache();
    return this.getEmployeeTransferConfig();
  },

  async getDashboardConfig(): Promise<IDashboardSettings> {
    const value = await this.get('dashboard_manager_role_codes');
    return {
      managerRoleCodes: parseCsvCodes(value, DEFAULT_DASHBOARD_MANAGER_ROLE_CODES),
    };
  },

  async setDashboardConfig(config: { managerRoleCodes: string[] }, userId: string): Promise<IDashboardSettings> {
    const codes = Array.from(new Set(config.managerRoleCodes.map(c => c.trim()).filter(Boolean)));
    await this.set(
      'dashboard_manager_role_codes',
      codes.join(','),
      userId,
      'CSV кодов system_roles, считающихся руководителями в «Карте руководителей» дашборда HR.',
    );
    this.invalidateCache();
    return this.getDashboardConfig();
  },

  async getFeedbackHiddenDepartmentsConfig(): Promise<{ hiddenDepartmentIds: string[] }> {
    const value = await this.get('feedback_hidden_su10_departments');
    return { hiddenDepartmentIds: parseCsvCodes(value, []) };
  },

  async setFeedbackHiddenDepartmentsConfig(hiddenDepartmentIds: string[], userId: string): Promise<{ hiddenDepartmentIds: string[] }> {
    const clean = Array.from(new Set(hiddenDepartmentIds.map(id => id.trim()).filter(Boolean)));
    await this.set(
      'feedback_hidden_su10_departments',
      clean.join(','),
      userId,
      'Отделы СУ-10, скрытые из сводки задач на странице «Обратная связь».',
    );
    this.invalidateCache();
    return this.getFeedbackHiddenDepartmentsConfig();
  },

  async getOpenRouterConfig(): Promise<IOpenRouterPublicSettings> {
    await loadCache();

    const settingsApiKey = cache.get('openrouter_api_key') || '';
    const settingsModel = cache.get('openrouter_model') || '';
    const settingsBaseUrl = cache.get('openrouter_base_url') || '';
    const settingsEnabled = cache.get('openrouter_enabled');

    const envApiKey = process.env.OPENROUTER_API_KEY || '';
    const envBaseUrl = process.env.OPENROUTER_BASE_URL || '';

    const hasSettingsKey = Boolean(settingsApiKey);
    const hasEnvKey = Boolean(envApiKey);

    const source: IOpenRouterPublicSettings['source'] = hasSettingsKey
      ? 'system_settings'
      : hasEnvKey
        ? 'env'
        : 'unset';

    const model = isAllowedOcrModel(settingsModel)
      ? settingsModel
      : DEFAULT_OPENROUTER_SETTINGS.model;

    return {
      enabled: parseBoolean(settingsEnabled, DEFAULT_OPENROUTER_SETTINGS.enabled),
      hasApiKey: hasSettingsKey || hasEnvKey,
      model,
      baseUrl: settingsBaseUrl || envBaseUrl || DEFAULT_OPENROUTER_SETTINGS.baseUrl,
      source,
      // Только OCR-модели: текстовая Luna не должна предлагаться для чеков.
      allowedModels: ALLOWED_OPENROUTER_MODELS.filter(m => m.allowedForReceiptOcr),
    };
  },

  async getResolvedOpenRouterConfig(): Promise<IOpenRouterResolvedConfig | null> {
    await loadCache();

    const enabled = parseBoolean(cache.get('openrouter_enabled'), DEFAULT_OPENROUTER_SETTINGS.enabled);
    if (!enabled) return null;

    const settingsApiKey = cache.get('openrouter_api_key') || '';
    const envApiKey = process.env.OPENROUTER_API_KEY || '';

    const apiKey = settingsApiKey || envApiKey;
    if (!apiKey) return null;

    const settingsModel = cache.get('openrouter_model') || '';
    const model = isAllowedOcrModel(settingsModel)
      ? settingsModel
      : DEFAULT_OPENROUTER_SETTINGS.model;

    const baseUrl =
      cache.get('openrouter_base_url')
      || process.env.OPENROUTER_BASE_URL
      || DEFAULT_OPENROUTER_SETTINGS.baseUrl;

    return {
      apiKey,
      model,
      baseUrl,
      source: settingsApiKey ? 'system_settings' : 'env',
    };
  },

  async setOpenRouterConfig(
    config: { enabled?: boolean; apiKey?: string | null; model?: string; baseUrl?: string | null },
    userId: string,
  ): Promise<IOpenRouterPublicSettings> {
    if (config.model !== undefined && !isAllowedOcrModel(config.model)) {
      const known = ALLOWED_OPENROUTER_MODELS.find(m => m.id === config.model);
      const reason = known && !known.allowedForReceiptOcr
        ? `Модель "${config.model}" не разрешена для распознавания чеков`
        : `Модель "${config.model}" не входит в список разрешённых`;
      throw new Error(reason);
    }

    const entries: { key: string; value: string | null; description?: string }[] = [];

    if (config.enabled !== undefined) {
      entries.push({
        key: 'openrouter_enabled',
        value: String(config.enabled),
        description: 'Включить распознавание чеков через OpenRouter',
      });
    }

    if (config.apiKey !== undefined) {
      entries.push({
        key: 'openrouter_api_key',
        value: config.apiKey?.trim() || null,
        description: 'API-ключ OpenRouter',
      });
    }

    if (config.model !== undefined) {
      entries.push({
        key: 'openrouter_model',
        value: config.model,
        description: 'ID модели OpenRouter для распознавания чеков',
      });
    }

    if (config.baseUrl !== undefined) {
      entries.push({
        key: 'openrouter_base_url',
        value: config.baseUrl?.trim() || null,
        description: 'Base URL OpenRouter API',
      });
    }

    if (entries.length > 0) {
      await this.setMultiple(entries, userId);
      this.invalidateCache();
    }

    return this.getOpenRouterConfig();
  },

  // ─── Адаптивное тестирование ───────────────────────────────────────────────

  /** Публичные настройки адаптивного тестирования (ключ никогда не отдаётся). */
  async getAdaptiveTestingSettings(): Promise<IAdaptiveTestingPublicSettings> {
    await loadCache();

    const connectionMode: AdaptiveConnectionMode =
      cache.get('adaptive_testing_connection_mode') === 'dedicated_proxy'
        ? 'dedicated_proxy'
        : 'shared_proxy';

    const model = cache.get('adaptive_testing_model') || DEFAULT_ADAPTIVE_TESTING_MODEL;
    const dedicatedBaseUrl = (cache.get('adaptive_testing_base_url') || '').trim() || null;

    const resolved = await this.getResolvedAdaptiveLlmConfig();

    return {
      enabled: parseBoolean(cache.get('adaptive_testing_enabled'), false),
      model,
      allowedEmails: cache.get('adaptive_testing_allowed_emails') || '',
      dailySessionsLimit: parsePositiveInt(cache.get('adaptive_testing_daily_sessions_limit'), 1),
      connectionMode,
      zdrRequired: parseBoolean(cache.get('adaptive_testing_zdr_required'), false),
      hasDedicatedApiKey: Boolean(cache.get('adaptive_testing_api_key')),
      dedicatedBaseUrl,
      effectiveBaseUrl: resolved.ok ? resolved.baseUrl : null,
      trustedBaseUrls: TRUSTED_LLM_BASE_URLS,
      allowedModels: ALLOWED_OPENROUTER_MODELS.filter(m => m.allowedForAdaptiveTesting),
    };
  },

  /**
   * Итоговый LLM-конфиг адаптивного тестирования. Валидация base URL — здесь,
   * на резолве (не только на PUT): shared-режим наследует openrouter_base_url,
   * который исторически принимается без проверки. Не в allowlist → ok:false,
   * вызов LLM не выполняется.
   *
   * ВАЖНО: kill switch adaptive_testing_enabled здесь НЕ проверяется —
   * health-check должен работать и при выключенном тестировании. Гейт
   * enabled — на уровне adaptive-testing.service.
   */
  async getResolvedAdaptiveLlmConfig(): Promise<AdaptiveLlmConfigResult> {
    await loadCache();

    const connectionMode: AdaptiveConnectionMode =
      cache.get('adaptive_testing_connection_mode') === 'dedicated_proxy'
        ? 'dedicated_proxy'
        : 'shared_proxy';

    const model = cache.get('adaptive_testing_model') || DEFAULT_ADAPTIVE_TESTING_MODEL;
    if (!isAllowedTextModel(model)) return { ok: false, reason: 'invalid_model' };

    let apiKey = '';
    let baseUrl = '';

    if (connectionMode === 'dedicated_proxy') {
      const encrypted = cache.get('adaptive_testing_api_key') || '';
      if (encrypted) {
        const encryptionService = await getEncryption();
        apiKey = encryptionService.decryptField(encrypted) || '';
      }
      baseUrl = (cache.get('adaptive_testing_base_url') || '').trim();
    } else {
      // shared_proxy: наследуются ТОЛЬКО ключ и base URL общего OpenRouter-конфига.
      // openrouter_enabled и OCR-модель не наследуются: выключение распознавания
      // чеков не должно останавливать тестирование.
      apiKey = cache.get('openrouter_api_key') || process.env.OPENROUTER_API_KEY || '';
      baseUrl = (
        cache.get('openrouter_base_url')
        || process.env.OPENROUTER_BASE_URL
        || DEFAULT_OPENROUTER_SETTINGS.baseUrl
      ).trim();
    }

    if (!apiKey) return { ok: false, reason: 'no_api_key' };
    if (!isTrustedLlmBaseUrl(baseUrl)) return { ok: false, reason: 'invalid_base_url' };

    return {
      ok: true,
      apiKey,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      zdrRequired: parseBoolean(cache.get('adaptive_testing_zdr_required'), false),
      connectionMode,
    };
  },

  /**
   * Сохранить настройки адаптивного тестирования (PATCH-семантика: не переданные
   * поля не трогаются; смена credentials требует ключ и URL одновременно).
   */
  async setAdaptiveTestingSettings(
    patch: {
      enabled?: boolean;
      model?: string;
      allowedEmails?: string;
      dailySessionsLimit?: number;
      connectionMode?: AdaptiveConnectionMode;
      zdrRequired?: boolean;
      /** Атомарная пара для dedicated_proxy; ключ шифруется перед записью. */
      dedicated?: { apiKey: string; baseUrl: string } | null;
    },
    userId: string,
  ): Promise<IAdaptiveTestingPublicSettings> {
    await loadCache();

    if (patch.model !== undefined && !isAllowedTextModel(patch.model)) {
      throw new Error(`Модель "${patch.model}" не разрешена для адаптивного тестирования`);
    }

    if (patch.allowedEmails !== undefined && patch.allowedEmails.trim() === '*') {
      // Массовый запуск ('*') — только после включения ZDR и успешной ZDR-проверки.
      const zdrRequired = patch.zdrRequired ?? parseBoolean(cache.get('adaptive_testing_zdr_required'), false);
      const zdrVerifiedAt = cache.get('adaptive_testing_zdr_verified_at');
      if (!zdrRequired || !zdrVerifiedAt) {
        throw new Error('Массовый доступ ("*") запрещён: сначала включите ZDR и выполните успешную проверку подключения с ZDR');
      }
    }

    const targetMode: AdaptiveConnectionMode = patch.connectionMode
      ?? (cache.get('adaptive_testing_connection_mode') === 'dedicated_proxy' ? 'dedicated_proxy' : 'shared_proxy');

    if (patch.dedicated) {
      const apiKey = patch.dedicated.apiKey.trim();
      const baseUrl = patch.dedicated.baseUrl.trim();
      if (!apiKey || !baseUrl) {
        throw new Error('Для отдельного подключения нужны и API-ключ, и Base URL');
      }
      // Маска из UI никогда не сохраняется как ключ.
      if (/^[•*]+$/.test(apiKey)) {
        throw new Error('API-ключ не задан (получена маска)');
      }
      if (!isTrustedLlmBaseUrl(baseUrl)) {
        throw new Error('Base URL не входит в список доверенных шлюзов');
      }
    } else if (targetMode === 'dedicated_proxy' && patch.connectionMode === 'dedicated_proxy') {
      // Переключение на dedicated без передачи пары — допустимо только если
      // ключ и URL уже сохранены ранее.
      const hasKey = Boolean(cache.get('adaptive_testing_api_key'));
      const hasUrl = Boolean((cache.get('adaptive_testing_base_url') || '').trim());
      if (!hasKey || !hasUrl) {
        throw new Error('Для режима dedicated_proxy задайте API-ключ и Base URL');
      }
    }

    const entries: { key: string; value: string | null; description?: string }[] = [];

    if (patch.enabled !== undefined) {
      entries.push({
        key: 'adaptive_testing_enabled',
        value: String(patch.enabled),
        description: 'Адаптивное тестирование: включено (kill switch)',
      });
    }
    if (patch.model !== undefined) {
      entries.push({
        key: 'adaptive_testing_model',
        value: patch.model,
        description: 'Адаптивное тестирование: модель OpenRouter',
      });
    }
    if (patch.allowedEmails !== undefined) {
      entries.push({
        key: 'adaptive_testing_allowed_emails',
        value: patch.allowedEmails.trim(),
        description: 'Адаптивное тестирование: email-allowlist (CSV; пусто = никому; * = всем с правом)',
      });
    }
    if (patch.dailySessionsLimit !== undefined) {
      const limit = Number.isFinite(patch.dailySessionsLimit) && patch.dailySessionsLimit >= 1
        ? Math.floor(patch.dailySessionsLimit)
        : 1;
      entries.push({
        key: 'adaptive_testing_daily_sessions_limit',
        value: String(limit),
        description: 'Адаптивное тестирование: сессий на сотрудника в сутки (МСК)',
      });
    }
    if (patch.connectionMode !== undefined) {
      entries.push({
        key: 'adaptive_testing_connection_mode',
        value: patch.connectionMode,
        description: 'Адаптивное тестирование: shared_proxy | dedicated_proxy',
      });
    }
    if (patch.zdrRequired !== undefined) {
      entries.push({
        key: 'adaptive_testing_zdr_required',
        value: String(patch.zdrRequired),
        description: 'Адаптивное тестирование: требовать ZDR-роутинг OpenRouter',
      });
    }
    if (patch.dedicated) {
      const encryptionService = await getEncryption();
      entries.push({
        key: 'adaptive_testing_api_key',
        value: encryptionService.encrypt(patch.dedicated.apiKey.trim()),
        description: 'Адаптивное тестирование: отдельный API-ключ (зашифрован)',
      });
      entries.push({
        key: 'adaptive_testing_base_url',
        value: patch.dedicated.baseUrl.trim(),
        description: 'Адаптивное тестирование: отдельный Base URL (allowlist)',
      });
    }

    if (entries.length > 0) {
      await this.setMultiple(entries, userId);
      this.invalidateCache();
    }

    return this.getAdaptiveTestingSettings();
  },

  /** Отметить успешную ZDR-проверку (вызывается health-check'ом с zdr:true). */
  async markAdaptiveZdrVerified(userId: string): Promise<void> {
    await this.set(
      'adaptive_testing_zdr_verified_at',
      new Date().toISOString(),
      userId,
      'Адаптивное тестирование: время успешной ZDR-проверки',
    );
    this.invalidateCache();
  },

  /**
   * Публичные настройки подключения МТС (без токена). baseUrl — из БД,
   * фоллбэк на .env, иначе дефолт api.mpoisk.ru. hasToken — есть ли токен.
   */
  async getMtsConnectionSettings(): Promise<IMtsConnectionPublicSettings> {
    await loadCache();

    const settingsBaseUrl = (cache.get('mts_api_base_url') || '').trim();
    const settingsToken = cache.get('mts_api_token') || '';
    const envBaseUrl = (process.env.MTS_API_BASE_URL || '').trim();
    const envToken = process.env.MTS_API_TOKEN || '';

    const source: IMtsConnectionPublicSettings['source'] = settingsToken
      ? 'system_settings'
      : envToken
        ? 'env'
        : 'unset';

    return {
      baseUrl: settingsBaseUrl || envBaseUrl || DEFAULT_MTS_BASE_URL,
      hasToken: Boolean(settingsToken || envToken),
      source,
    };
  },

  /**
   * Резолв конфига для бэк-вызовов МТС. Токен в system_settings хранится
   * зашифрованным (encryption.service) — здесь расшифровываем. .env-токен
   * хранится как есть (его задаёт пользователь, не сервис).
   */
  async getResolvedMtsConfig(): Promise<IMtsResolvedConfig | null> {
    await loadCache();

    const settingsBaseUrl = (cache.get('mts_api_base_url') || '').trim();
    const settingsTokenEnc = cache.get('mts_api_token') || '';

    if (settingsTokenEnc) {
      const encryptionService = await getEncryption();
      const token = encryptionService.decryptField(settingsTokenEnc);
      if (token) {
        return {
          baseUrl: settingsBaseUrl || process.env.MTS_API_BASE_URL || DEFAULT_MTS_BASE_URL,
          token,
          source: 'system_settings',
        };
      }
    }

    const envToken = process.env.MTS_API_TOKEN || '';
    if (envToken) {
      return {
        baseUrl: settingsBaseUrl || process.env.MTS_API_BASE_URL || DEFAULT_MTS_BASE_URL,
        token: envToken,
        source: 'env',
      };
    }

    return null;
  },

  /**
   * Сохранить настройки МТС. Токен шифруется ПЕРЕД записью в system_settings —
   * в БД он не лежит в открытом виде.
   */
  async setMtsConnectionSettings(
    config: { baseUrl?: string | null; token?: string | null },
    userId: string,
  ): Promise<IMtsConnectionPublicSettings> {
    const entries: { key: string; value: string | null; description?: string }[] = [];

    if (config.baseUrl !== undefined) {
      const trimmedUrl = config.baseUrl?.trim() || null;
      if (trimmedUrl) assertMtsBaseUrlAllowed(trimmedUrl);
      entries.push({
        key: 'mts_api_base_url',
        value: trimmedUrl,
        description: 'МТС «Мобильные сотрудники» — base URL API (allow-list)',
      });
    }

    if (config.token !== undefined) {
      const trimmed = config.token?.trim() || null;
      const encryptionService = await getEncryption();
      entries.push({
        key: 'mts_api_token',
        value: trimmed ? encryptionService.encrypt(trimmed) : null,
        description: 'МТС «Мобильные сотрудники» — API-токен (зашифрован)',
      });
    }

    if (entries.length > 0) {
      await this.setMultiple(entries, userId);
      this.invalidateCache();
    }

    return this.getMtsConnectionSettings();
  },

  /** Публичные настройки newdb (без токена). baseUrl — из БД, фоллбэк .env/дефолт. */
  async getNewdbConnectionSettings(): Promise<INewdbConnectionPublicSettings> {
    await loadCache();

    const settingsBaseUrl = (cache.get('newdb_api_base_url') || '').trim();
    const settingsToken = cache.get('newdb_api_token') || '';
    const envBaseUrl = (process.env.NEWDB_API_BASE_URL || '').trim();
    const envToken = process.env.NEWDB_API_TOKEN || '';

    const source: INewdbConnectionPublicSettings['source'] = settingsToken
      ? 'system_settings'
      : envToken
        ? 'env'
        : 'unset';

    return {
      baseUrl: settingsBaseUrl || envBaseUrl || DEFAULT_NEWDB_BASE_URL,
      hasToken: Boolean(settingsToken || envToken),
      source,
    };
  },

  /** Резолв конфига для бэк-вызовов newdb. Токен в system_settings зашифрован. */
  async getResolvedNewdbConfig(): Promise<INewdbResolvedConfig | null> {
    await loadCache();

    const settingsBaseUrl = (cache.get('newdb_api_base_url') || '').trim();
    const settingsTokenEnc = cache.get('newdb_api_token') || '';

    if (settingsTokenEnc) {
      const encryptionService = await getEncryption();
      const token = encryptionService.decryptField(settingsTokenEnc);
      if (token) {
        return {
          baseUrl: settingsBaseUrl || process.env.NEWDB_API_BASE_URL || DEFAULT_NEWDB_BASE_URL,
          token,
          source: 'system_settings',
        };
      }
    }

    const envToken = process.env.NEWDB_API_TOKEN || '';
    if (envToken) {
      return {
        baseUrl: settingsBaseUrl || process.env.NEWDB_API_BASE_URL || DEFAULT_NEWDB_BASE_URL,
        token: envToken,
        source: 'env',
      };
    }

    return null;
  },

  /** Сохранить настройки newdb. Токен шифруется ПЕРЕД записью в system_settings. */
  async setNewdbConnectionSettings(
    config: { baseUrl?: string | null; token?: string | null },
    userId: string,
  ): Promise<INewdbConnectionPublicSettings> {
    const entries: { key: string; value: string | null; description?: string }[] = [];

    if (config.baseUrl !== undefined) {
      const trimmedUrl = config.baseUrl?.trim() || null;
      if (trimmedUrl) assertNewdbBaseUrlAllowed(trimmedUrl);
      entries.push({
        key: 'newdb_api_base_url',
        value: trimmedUrl,
        description: 'newdb.net — base URL API (allow-list)',
      });
    }

    if (config.token !== undefined) {
      const trimmed = config.token?.trim() || null;
      const encryptionService = await getEncryption();
      entries.push({
        key: 'newdb_api_token',
        value: trimmed ? encryptionService.encrypt(trimmed) : null,
        description: 'newdb.net — API-токен X-API-KEY (зашифрован)',
      });
    }

    if (entries.length > 0) {
      await this.setMultiple(entries, userId);
      this.invalidateCache();
    }

    return this.getNewdbConnectionSettings();
  },

  /** Расписание ежедневного автопрогона «Обновить всё» МТС Бизнес. */
  async getMtsBusinessRefreshAllSchedule(): Promise<IMtsBusinessRefreshAllScheduleSettings> {
    const values = await this.getMultiple([
      'mts_business_refresh_all_enabled',
      'mts_business_refresh_all_hour_msk',
    ]);
    return {
      enabled: parseBoolean(values.mts_business_refresh_all_enabled, DEFAULT_MTS_BUSINESS_REFRESH_ALL_SCHEDULE.enabled),
      hourMsk: parseHour(values.mts_business_refresh_all_hour_msk, DEFAULT_MTS_BUSINESS_REFRESH_ALL_SCHEDULE.hourMsk),
    };
  },

  async setMtsBusinessRefreshAllSchedule(
    config: Partial<IMtsBusinessRefreshAllScheduleSettings>,
    userId: string,
  ): Promise<IMtsBusinessRefreshAllScheduleSettings> {
    const current = await this.getMtsBusinessRefreshAllSchedule();
    const next: IMtsBusinessRefreshAllScheduleSettings = {
      enabled: config.enabled ?? current.enabled,
      hourMsk: config.hourMsk ?? current.hourMsk,
    };

    await this.setMultiple([
      {
        key: 'mts_business_refresh_all_enabled',
        value: String(next.enabled),
        description: 'МТС Бизнес: включить ежедневный автопрогон «Обновить»',
      },
      {
        key: 'mts_business_refresh_all_hour_msk',
        value: String(next.hourMsk),
        description: 'МТС Бизнес: час запуска автопрогона «Обновить» (МСК, 0–23)',
      },
    ], userId);

    this.invalidateCache();
    return this.getMtsBusinessRefreshAllSchedule();
  },

  /** Настройки непрерывного конвейера свежести выписки МТС Бизнес. */
  async getMtsBusinessRolling(): Promise<IMtsBusinessRollingSettings> {
    const values = await this.getMultiple([
      'mts_business_rolling_enabled',
      'mts_business_rolling_budget_share',
      'mts_business_rolling_hot_minutes',
      'mts_business_rolling_cold_hours',
    ]);
    const share = parsePositiveInt(values.mts_business_rolling_budget_share, DEFAULT_MTS_BUSINESS_ROLLING.budgetSharePercent);
    return {
      enabled: parseBoolean(values.mts_business_rolling_enabled, DEFAULT_MTS_BUSINESS_ROLLING.enabled),
      // Клампим здесь, а не только в UI: 100% съели бы весь лимит, и живые
      // вызовы карточки абонента вставали бы в очередь ожидания окна.
      budgetSharePercent: Math.min(90, Math.max(10, share)),
      hotMinutes: Math.max(5, parsePositiveInt(values.mts_business_rolling_hot_minutes, DEFAULT_MTS_BUSINESS_ROLLING.hotMinutes)),
      coldHours: Math.max(1, parsePositiveInt(values.mts_business_rolling_cold_hours, DEFAULT_MTS_BUSINESS_ROLLING.coldHours)),
    };
  },

  async setMtsBusinessRolling(
    config: Partial<IMtsBusinessRollingSettings>,
    userId: string,
  ): Promise<IMtsBusinessRollingSettings> {
    const current = await this.getMtsBusinessRolling();
    const next: IMtsBusinessRollingSettings = {
      enabled: config.enabled ?? current.enabled,
      budgetSharePercent: config.budgetSharePercent ?? current.budgetSharePercent,
      hotMinutes: config.hotMinutes ?? current.hotMinutes,
      coldHours: config.coldHours ?? current.coldHours,
    };

    await this.setMultiple([
      {
        key: 'mts_business_rolling_enabled',
        value: String(next.enabled),
        description: 'МТС Бизнес: непрерывное обновление выписки (звонки/начисления)',
      },
      {
        key: 'mts_business_rolling_budget_share',
        value: String(next.budgetSharePercent),
        description: 'МТС Бизнес: доля лимита запросов под конвейер, % (10–90)',
      },
      {
        key: 'mts_business_rolling_hot_minutes',
        value: String(next.hotMinutes),
        description: 'МТС Бизнес: как часто обновлять активные номера, мин',
      },
      {
        key: 'mts_business_rolling_cold_hours',
        value: String(next.coldHours),
        description: 'МТС Бизнес: как часто обновлять неактивные номера, ч',
      },
    ], userId);

    this.invalidateCache();
    return this.getMtsBusinessRolling();
  },

  invalidateCache() {
    cacheLoadedAt = 0;
    cache.clear();
  },
};
