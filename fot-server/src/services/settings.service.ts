import { supabase } from '../config/database.js';

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

export interface ISkudTravelSettings {
  limitMinutes: number | null;
}

let cache: Map<string, string | null> = new Map();
let cacheLoadedAt = 0;
const CACHE_TTL = 60_000; // 60 сек

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

const loadCache = async () => {
  if (Date.now() - cacheLoadedAt < CACHE_TTL && cache.size > 0) return;
  const { data } = await supabase.from('system_settings').select('key, value');
  cache = new Map((data || []).map((s: { key: string; value: string | null }) => [s.key, s.value]));
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
    await supabase
      .from('system_settings')
      .upsert({
        key,
        value,
        description: description || null,
        is_secret: key.includes('secret') || key.includes('key'),
        updated_at: new Date().toISOString(),
        updated_by: userId,
      }, { onConflict: 'key' });
    cache.set(key, value);
  },

  async setMultiple(entries: { key: string; value: string | null; description?: string }[], userId: string): Promise<void> {
    const rows = entries.map(e => ({
      key: e.key,
      value: e.value,
      description: e.description || null,
      is_secret: e.key.includes('secret') || e.key.includes('key'),
      updated_at: new Date().toISOString(),
      updated_by: userId,
    }));
    await supabase.from('system_settings').upsert(rows, { onConflict: 'key' });
    for (const e of entries) cache.set(e.key, e.value);
  },

  /** Все настройки (для admin UI). Секретные значения маскируются. */
  async getAll(): Promise<ISetting[]> {
    const { data } = await supabase
      .from('system_settings')
      .select('*')
      .order('key');
    return (data || []).map((s: ISetting) => ({
      ...s,
      value: s.is_secret && s.value ? '••••••••' : s.value,
    }));
  },

  /** Получить R2 конфиг (из БД, фоллбэк на .env) */
  async getR2Config(): Promise<{
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    enabled: boolean;
  }> {
    await loadCache();
    const accountId = cache.get('r2_account_id') || process.env.R2_ACCOUNT_ID || '';
    const accessKeyId = cache.get('r2_access_key_id') || process.env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = cache.get('r2_secret_access_key') || process.env.R2_SECRET_ACCESS_KEY || '';
    const bucketName = cache.get('r2_bucket_name') || process.env.R2_BUCKET_NAME || 'fot-documents';
    return {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucketName,
      enabled: !!(accountId && accessKeyId && secretAccessKey),
    };
  },

  async getSkudTravelConfig(): Promise<ISkudTravelSettings> {
    const values = await this.getMultiple(['skud_travel_limit_minutes']);
    return {
      limitMinutes: parseNullablePositiveInt(values.skud_travel_limit_minutes),
    };
  },

  async setSkudTravelConfig(config: Partial<ISkudTravelSettings>, userId: string): Promise<ISkudTravelSettings> {
    const current = await this.getSkudTravelConfig();
    const next: ISkudTravelSettings = {
      limitMinutes: config.limitMinutes ?? current.limitMinutes,
    };

    await this.setMultiple([
      {
        key: 'skud_travel_limit_minutes',
        value: next.limitMinutes != null ? String(next.limitMinutes) : null,
        description: 'Единый лимит передвижения между объектами в минутах',
      },
    ], userId);

    this.invalidateCache();
    return this.getSkudTravelConfig();
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

  invalidateCache() {
    cacheLoadedAt = 0;
    cache.clear();
  },
};
