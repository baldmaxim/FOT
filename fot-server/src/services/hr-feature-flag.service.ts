/**
 * Флаг раскатки кадрового модуля. Пока выключен, весь /api/hr-profiles отвечает 503,
 * а фронт не показывает ни кнопку «Реквизиты», ни мастер — интерфейс не отличается
 * от прежнего ни для кого, включая администратора (у него право есть всегда).
 *
 * Включение/выключение — значением в system_settings, без передеплоя:
 *   INSERT INTO system_settings (key, value) VALUES ('hr_profiles_enabled','true')
 *     ON CONFLICT (key) DO UPDATE SET value = 'true';
 */
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { settingsService } from './settings.service.js';

export const HR_PROFILES_ENABLED_KEY = 'hr_profiles_enabled';

/** Выключено по умолчанию: пустое значение = выключено. */
export const isHrProfilesEnabled = async (): Promise<boolean> => {
  try {
    const raw = await settingsService.get(HR_PROFILES_ENABLED_KEY);
    return String(raw ?? '').trim().toLowerCase() === 'true';
  } catch (err) {
    console.error('[hr-flag] не удалось прочитать настройку:', err instanceof Error ? err.message : err);
    return false;
  }
};

export const requireHrEnabled = async (_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  if (await isHrProfilesEnabled()) {
    next();
    return;
  }
  res.status(503).json({
    success: false,
    error: 'Кадровый модуль отключён',
    code: 'HR_DISABLED',
  });
};
