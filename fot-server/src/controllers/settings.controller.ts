import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { settingsService } from '../services/settings.service.js';

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

/** Получить R2 статус (подключено / не подключено) */
const getR2Status = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const cfg = await settingsService.getR2Config();
    res.json({
      success: true,
      data: {
        enabled: cfg.enabled,
        bucket_name: cfg.bucketName,
        has_account_id: !!cfg.accountId,
        has_access_key: !!cfg.accessKeyId,
        has_secret_key: !!cfg.secretAccessKey,
      },
    });
  } catch (err) {
    console.error('settings.getR2Status error:', err);
    res.status(500).json({ success: false, error: 'Ошибка проверки R2' });
  }
};

/** Сохранить R2 настройки */
const saveR2 = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { account_id, access_key_id, secret_access_key, bucket_name } = req.body;

    const entries: { key: string; value: string | null; description?: string }[] = [];

    if (account_id !== undefined) {
      entries.push({ key: 'r2_account_id', value: account_id || null, description: 'Cloudflare R2 Account ID' });
    }
    if (access_key_id !== undefined) {
      entries.push({ key: 'r2_access_key_id', value: access_key_id || null, description: 'Cloudflare R2 Access Key ID' });
    }
    if (secret_access_key !== undefined && secret_access_key !== '••••••••') {
      entries.push({ key: 'r2_secret_access_key', value: secret_access_key || null, description: 'Cloudflare R2 Secret Access Key' });
    }
    if (bucket_name !== undefined) {
      entries.push({ key: 'r2_bucket_name', value: bucket_name || 'fot-documents', description: 'Cloudflare R2 Bucket Name' });
    }

    if (entries.length > 0) {
      await settingsService.setMultiple(entries, req.user.id);
      settingsService.invalidateCache();
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
    res.status(500).json({ success: false, error: 'Ошибка сохранения настроек R2' });
  }
};

/** Тест подключения R2 */
const testR2 = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
    const cfg = await settingsService.getR2Config();

    if (!cfg.enabled) {
      res.json({ success: true, data: { connected: false, error: 'R2 не настроен — заполните все поля' } });
      return;
    }

    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });

    await client.send(new ListBucketsCommand({}));
    res.json({ success: true, data: { connected: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Неизвестная ошибка';
    res.json({ success: true, data: { connected: false, error: msg } });
  }
};

export const settingsController = {
  getAll,
  getR2Status,
  saveR2,
  testR2,
};
