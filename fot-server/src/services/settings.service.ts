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

export interface ITimesheetTeamManagementSettings {
  enabled: boolean;
}

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

export const DEFAULT_TIMESHEET_TEAM_MANAGEMENT_SETTINGS: ITimesheetTeamManagementSettings = {
  enabled: false,
};

let cache: Map<string, string | null> = new Map();
let cacheLoadedAt = 0;
const CACHE_TTL = 60_000; // 60 сек

const isSecretKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return normalized.includes('secret') || normalized.includes('key') || normalized.includes('password');
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
        is_secret: isSecretKey(key),
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
      is_secret: isSecretKey(e.key),
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

  /** Получить R2 / S3-совместимый конфиг (из БД, фоллбэк на .env) */
  async getR2Config(): Promise<{
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    endpoint: string;
    region: string;
    forcePathStyle: boolean;
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
    return {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucketName,
      endpoint,
      region,
      forcePathStyle,
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
    userId: string,
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

  async getTimesheetTeamManagementConfig(): Promise<ITimesheetTeamManagementSettings> {
    const values = await this.getMultiple([
      'timesheet_team_management_enabled',
    ]);

    return {
      enabled: parseBoolean(
        values.timesheet_team_management_enabled,
        DEFAULT_TIMESHEET_TEAM_MANAGEMENT_SETTINGS.enabled,
      ),
    };
  },

  async setTimesheetTeamManagementConfig(
    config: Partial<ITimesheetTeamManagementSettings>,
    userId: string,
  ): Promise<ITimesheetTeamManagementSettings> {
    const current = await this.getTimesheetTeamManagementConfig();
    const next: ITimesheetTeamManagementSettings = {
      enabled: config.enabled ?? current.enabled,
    };

    await this.setMultiple([
      {
        key: 'timesheet_team_management_enabled',
        value: String(next.enabled),
        description: 'Разрешить ручное управление составом отдела на странице табеля',
      },
    ], userId);

    this.invalidateCache();
    return this.getTimesheetTeamManagementConfig();
  },

  invalidateCache() {
    cacheLoadedAt = 0;
    cache.clear();
  },
};
