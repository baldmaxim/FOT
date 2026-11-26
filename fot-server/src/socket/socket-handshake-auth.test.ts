/**
 * Рукопожатие Socket.IO (миграция 381): уволенного и неактивного не пускаем, служебную учётку — пускаем,
 * отозванный токен (после перевода в неактивные и «Вернуть в активные») — нет.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getProfileAccessState: vi.fn() }));

vi.mock('../services/account-status.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/account-status.service.js')>('../services/account-status.service.js');
  return { ...actual, getProfileAccessState: h.getProfileAccessState };
});

import { authorizeSocketHandshake } from './socket-handshake-auth.js';

const state = (over: Record<string, unknown> = {}) => ({
  employmentStatus: 'active', staffInactive: false, loginWhenStaffInactive: false, isDisabled: false, tokenVersion: 3, ...over,
});

beforeEach(() => h.getProfileAccessState.mockReset());

describe('authorizeSocketHandshake', () => {
  it('работающий с актуальным токеном — пускать', async () => {
    h.getProfileAccessState.mockResolvedValue(state());
    expect(await authorizeSocketHandshake({ sub: 'u', token_version: 3 })).toBeNull();
  });

  it('профиль не найден — отказ', async () => {
    h.getProfileAccessState.mockResolvedValue(null);
    expect(await authorizeSocketHandshake({ sub: 'u', token_version: 0 })).toBe('Profile not found');
  });

  it('уволенный и неактивный — отказ с причиной', async () => {
    h.getProfileAccessState.mockResolvedValue(state({ employmentStatus: 'fired' }));
    expect(await authorizeSocketHandshake({ sub: 'u', token_version: 3 })).toBe('Учётная запись отключена: сотрудник уволен');
    h.getProfileAccessState.mockResolvedValue(state({ staffInactive: true }));
    expect(await authorizeSocketHandshake({ sub: 'u', token_version: 3 }))
      .toBe('Учётная запись отключена: сотрудник переведён в неактивные');
  });

  it('служебная учётка неактивной карточки — пускать', async () => {
    h.getProfileAccessState.mockResolvedValue(state({ staffInactive: true, loginWhenStaffInactive: true }));
    expect(await authorizeSocketHandshake({ sub: 'u', token_version: 3 })).toBeNull();
  });

  it('старый токен после «Вернуть в активные» — отказ; токен без поля версии считается версией 0', async () => {
    h.getProfileAccessState.mockResolvedValue(state({ tokenVersion: 4 }));
    expect(await authorizeSocketHandshake({ sub: 'u', token_version: 3 })).toBe('Token revoked');
    h.getProfileAccessState.mockResolvedValue(state({ tokenVersion: 0 }));
    expect(await authorizeSocketHandshake({ sub: 'u', token_version: undefined as unknown as number })).toBeNull();
  });
});
