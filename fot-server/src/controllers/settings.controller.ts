import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { settingsService } from '../services/settings.service.js';
import {
  r2Service,
  sanitizeS3Endpoint,
  sanitizeS3Value,
  buildS3Endpoint,
  createS3Client,
} from '../services/r2.service.js';
import { openRouterService } from '../services/openrouter.service.js';

/** Получить все настройки (секретные маскируются) */
const getAll = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const settings = await settingsService.getAll();
    res.json({ success: true, data: settings });
  } catch (err) {
    console.error('settings.getAll error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения настроек' });
  }
};

/** Получить R2 / S3 статус (подключено / не подключено) */
const getR2Status = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const cfg = await settingsService.getR2Config();
    res.json({
      success: true,
      data: {
        enabled: cfg.enabled,
        bucket_name: cfg.bucketName,
        has_account_id: !!cfg.accountId,
        account_id: cfg.accountId,
        has_access_key: !!cfg.accessKeyId,
        has_secret_key: !!cfg.secretAccessKey,
        has_endpoint: !!cfg.endpoint,
        endpoint: cfg.endpoint,
        region: cfg.region,
        force_path_style: cfg.forcePathStyle,
        has_kms_key: !!cfg.kmsKeyId,
        kms_key_id: cfg.kmsKeyId,
      },
    });
  } catch (err) {
    console.error('settings.getR2Status error:', err);
    res.status(500).json({ success: false, error: 'Ошибка проверки R2' });
  }
};

/** Сохранить R2 / S3 настройки */
const saveR2 = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const {
      account_id,
      access_key_id,
      secret_access_key,
      bucket_name,
      endpoint,
      region,
      force_path_style,
      kms_key_id,
    } = req.body;

    const entries: { key: string; value: string | null; description?: string }[] = [];

    if (account_id !== undefined) {
      const clean = typeof account_id === 'string' ? sanitizeS3Value(account_id) : '';
      entries.push({ key: 'r2_account_id', value: clean || null, description: 'Cloudflare R2 Account ID' });
    }
    if (access_key_id !== undefined) {
      const clean = typeof access_key_id === 'string' ? sanitizeS3Value(access_key_id) : '';
      entries.push({ key: 'r2_access_key_id', value: clean || null, description: 'S3 Access Key ID' });
    }
    if (secret_access_key !== undefined && secret_access_key !== '••••••••') {
      entries.push({ key: 'r2_secret_access_key', value: secret_access_key || null, description: 'S3 Secret Access Key' });
    }
    if (bucket_name !== undefined) {
      entries.push({ key: 'r2_bucket_name', value: bucket_name || 'fot-documents', description: 'S3 Bucket Name' });
    }
    if (endpoint !== undefined) {
      const clean = typeof endpoint === 'string' ? sanitizeS3Endpoint(endpoint) : '';
      entries.push({ key: 'r2_endpoint', value: clean || null, description: 'S3 Endpoint URL (для Cloud.ru и других S3-совместимых провайдеров)' });
    }
    if (region !== undefined) {
      const clean = typeof region === 'string' ? sanitizeS3Value(region) : '';
      entries.push({ key: 'r2_region', value: clean || null, description: 'S3 Region' });
    }
    if (force_path_style !== undefined) {
      entries.push({ key: 'r2_force_path_style', value: force_path_style ? 'true' : 'false', description: 'S3 Force Path Style URL' });
    }
    if (kms_key_id !== undefined) {
      const clean = typeof kms_key_id === 'string' ? sanitizeS3Value(kms_key_id) : '';
      entries.push({ key: 'r2_kms_key_id', value: clean || null, description: 'S3 SSE-KMS Key ID (симметричный ключ для aws:kms шифрования)' });
    }

    if (entries.length > 0) {
      await settingsService.setMultiple(entries, req.user.id);
      settingsService.invalidateCache();
      r2Service.invalidateCachedConfig();
    }

    const cfg = await settingsService.getR2Config();
    res.json({
      success: true,
      data: {
        enabled: cfg.enabled,
        bucket_name: cfg.bucketName,
      },
    });
  } catch (err) {
    console.error('settings.saveR2 error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения настроек S3' });
  }
};

/** Тест подключения R2 / S3 */
const testR2 = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  const cfg = await settingsService.getR2Config();

  if (!cfg.enabled) {
    res.json({ success: true, data: { connected: false, error: 'S3 не настроен — заполните Access Key, Secret Key и (Account ID или Endpoint URL)' } });
    return;
  }

  try {
    const { ListBucketsCommand } = await import('@aws-sdk/client-s3');
    const client = createS3Client({
      accountId: cfg.accountId,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
    });

    await client.send(new ListBucketsCommand({}));
    res.json({ success: true, data: { connected: true } });
  } catch (err) {
    const raw = err instanceof Error ? err.message : 'Неизвестная ошибка';
    const resolvedEndpoint = buildS3Endpoint(cfg);
    console.error('[s3 test] endpoint=', resolvedEndpoint, 'error=', raw);
    const isHandshake = raw.includes('EPROTO') || raw.includes('handshake failure');
    const msg = isHandshake
      ? `TLS handshake failed при подключении к ${resolvedEndpoint}. Проверьте Endpoint URL (для Cloud.ru: https://s3.cloud.ru), Account ID и регион.`
      : raw;
    res.json({ success: true, data: { connected: false, error: msg } });
  }
};

const getSigurMonitorSettings = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const config = await settingsService.getSigurMonitorConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    console.error('settings.getSigurMonitorSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения настроек мониторинга Sigur' });
  }
};

const saveSigurMonitorSettings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const {
      enabled,
      failureThreshold,
      recoveryThreshold,
      silenceWindowMinutes,
      baselineLookbackDays,
      baselineMinEvents,
      alertCooldownMinutes,
      timezone,
    } = req.body as Record<string, unknown>;

    const config = await settingsService.setSigurMonitorConfig({
      enabled: typeof enabled === 'boolean' ? enabled : undefined,
      failureThreshold: typeof failureThreshold === 'number' ? failureThreshold : undefined,
      recoveryThreshold: typeof recoveryThreshold === 'number' ? recoveryThreshold : undefined,
      silenceWindowMinutes: typeof silenceWindowMinutes === 'number' ? silenceWindowMinutes : undefined,
      baselineLookbackDays: typeof baselineLookbackDays === 'number' ? baselineLookbackDays : undefined,
      baselineMinEvents: typeof baselineMinEvents === 'number' ? baselineMinEvents : undefined,
      alertCooldownMinutes: typeof alertCooldownMinutes === 'number' ? alertCooldownMinutes : undefined,
      timezone: typeof timezone === 'string' ? timezone : undefined,
    }, req.user.id);

    res.json({ success: true, data: config });
  } catch (err) {
    console.error('settings.saveSigurMonitorSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения настроек мониторинга Sigur' });
  }
};

const getTimesheetReminderSettings = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const config = await settingsService.getTimesheetReminderConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    console.error('settings.getTimesheetReminderSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения настроек напоминаний табеля' });
  }
};

const saveTimesheetReminderSettings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const {
      enabled,
      timezone,
      openingReminderHour,
      deadlineMorningHour,
      deadlineAfternoonHour,
      escalationHour,
      overdueHour,
    } = req.body as Record<string, unknown>;

    const config = await settingsService.setTimesheetReminderConfig({
      enabled: typeof enabled === 'boolean' ? enabled : undefined,
      timezone: typeof timezone === 'string' ? timezone : undefined,
      openingReminderHour: typeof openingReminderHour === 'number' ? openingReminderHour : undefined,
      deadlineMorningHour: typeof deadlineMorningHour === 'number' ? deadlineMorningHour : undefined,
      deadlineAfternoonHour: typeof deadlineAfternoonHour === 'number' ? deadlineAfternoonHour : undefined,
      escalationHour: typeof escalationHour === 'number' ? escalationHour : undefined,
      overdueHour: typeof overdueHour === 'number' ? overdueHour : undefined,
    }, req.user.id);

    res.json({ success: true, data: config });
  } catch (err) {
    console.error('settings.saveTimesheetReminderSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения настроек напоминаний табеля' });
  }
};

const getTimesheetTeamManagementSettings = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const config = await settingsService.getTimesheetTeamManagementConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    console.error('settings.getTimesheetTeamManagementSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения настроек управления составом табеля' });
  }
};

const saveTimesheetTeamManagementSettings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { enabled } = req.body as Record<string, unknown>;

    const config = await settingsService.setTimesheetTeamManagementConfig({
      enabled: typeof enabled === 'boolean' ? enabled : undefined,
    }, req.user.id);

    res.json({ success: true, data: config });
  } catch (err) {
    console.error('settings.saveTimesheetTeamManagementSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения настроек управления составом табеля' });
  }
};

const getEmployeeTransferSettings = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const config = await settingsService.getEmployeeTransferConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    console.error('settings.getEmployeeTransferSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения настроек заморозки переводов' });
  }
};

const saveEmployeeTransferSettings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { freezeHistory } = req.body as Record<string, unknown>;

    const config = await settingsService.setEmployeeTransferConfig({
      freezeHistory: typeof freezeHistory === 'boolean' ? freezeHistory : undefined,
    }, req.user.id);

    res.json({ success: true, data: config });
  } catch (err) {
    console.error('settings.saveEmployeeTransferSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения настроек заморозки переводов' });
  }
};

/** Получить настройки OpenRouter (API key маскируется) */
const getOpenRouterSettings = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const config = await settingsService.getOpenRouterConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    console.error('settings.getOpenRouterSettings error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения настроек OpenRouter' });
  }
};

/** Сохранить настройки OpenRouter */
const saveOpenRouterSettings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { enabled, apiKey, model, baseUrl } = req.body as Record<string, unknown>;

    const patch: Parameters<typeof settingsService.setOpenRouterConfig>[0] = {};

    if (typeof enabled === 'boolean') patch.enabled = enabled;
    if (typeof apiKey === 'string' && apiKey !== '••••••••') patch.apiKey = apiKey;
    if (typeof model === 'string') patch.model = model;
    if (typeof baseUrl === 'string') patch.baseUrl = baseUrl;

    const config = await settingsService.setOpenRouterConfig(patch, req.user.id);
    res.json({ success: true, data: config });
  } catch (err) {
    console.error('settings.saveOpenRouterSettings error:', err);
    const msg = err instanceof Error ? err.message : 'Ошибка сохранения настроек OpenRouter';
    res.status(400).json({ success: false, error: msg });
  }
};

/** Тест подключения OpenRouter */
const testOpenRouter = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await openRouterService.healthCheck();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('settings.testOpenRouter error:', err);
    res.json({
      success: true,
      data: { ok: false, error: err instanceof Error ? err.message : 'unknown error' },
    });
  }
};

export const settingsController = {
  getAll,
  getR2Status,
  saveR2,
  testR2,
  getSigurMonitorSettings,
  saveSigurMonitorSettings,
  getTimesheetReminderSettings,
  saveTimesheetReminderSettings,
  getTimesheetTeamManagementSettings,
  saveTimesheetTeamManagementSettings,
  getEmployeeTransferSettings,
  saveEmployeeTransferSettings,
  getOpenRouterSettings,
  saveOpenRouterSettings,
  testOpenRouter,
};
