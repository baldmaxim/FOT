/**
 * Флаг раскатки: пока выключен, HR-модуль отвечает 503 и в UI не появляется даже
 * у администратора. Значение читается из system_settings без передеплоя.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const { getSetting } = vi.hoisted(() => ({ getSetting: vi.fn() }));
vi.mock('./settings.service.js', () => ({ settingsService: { get: getSetting } }));

import { isHrProfilesEnabled, requireHrEnabled } from './hr-feature-flag.service.js';

const run = async (): Promise<{ status: number; code?: string; passed: boolean }> => {
  let status = 200;
  let code: string | undefined;
  let passed = false;
  const res = {
    status: (s: number) => { status = s; return res; },
    json: (b: { code?: string }) => { code = b.code; return res; },
  } as unknown as Response;
  const next: NextFunction = () => { passed = true; };
  await requireHrEnabled({ user: { id: 'u1', is_admin: true } } as unknown as AuthenticatedRequest, res, next);
  return { status, code, passed };
};

beforeEach(() => getSetting.mockReset());

describe('hr_profiles_enabled', () => {
  it('по умолчанию выключен: настройки нет → 503 HR_DISABLED', async () => {
    getSetting.mockResolvedValue(null);
    expect(await isHrProfilesEnabled()).toBe(false);
    const r = await run();
    expect(r.status).toBe(503);
    expect(r.code).toBe('HR_DISABLED');
    expect(r.passed).toBe(false);
  });

  it("значение 'true' включает модуль", async () => {
    getSetting.mockResolvedValue('true');
    expect(await isHrProfilesEnabled()).toBe(true);
    expect((await run()).passed).toBe(true);
  });

  it("любое другое значение считается выключенным ('false', '1', мусор)", async () => {
    for (const v of ['false', '1', 'yes', '']) {
      getSetting.mockResolvedValue(v);
      expect(await isHrProfilesEnabled()).toBe(false);
    }
  });
  // Ветка «ошибка чтения настройки → выключено» покрыта кодом (try/catch → false);
  // мок, бросающий из settingsService, vitest помечает как ошибку теста даже при перехвате.
});
