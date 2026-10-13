import { describe, expect, it } from 'vitest';

import { BANNER_DELAY_MS, isBannerDue, shouldReloadOnNavigation } from './appUpdate';

const NAVIGATION = {
  updateAvailable: true,
  prevPath: '/timesheet',
  nextPath: '/employees',
  latestBuildId: 'bbb',
  reloadedFor: null,
  isMutating: false,
};

describe('shouldReloadOnNavigation', () => {
  it('переход в другой раздел при вышедшей сборке — перезагружаем', () => {
    expect(shouldReloadOnNavigation(NAVIGATION)).toBe(true);
    expect(shouldReloadOnNavigation({ ...NAVIGATION, prevPath: '/mts/subscribers', nextPath: '/mts/linked' })).toBe(true);
  });

  it('новой сборки нет — не трогаем', () => {
    expect(shouldReloadOnNavigation({ ...NAVIGATION, updateAvailable: false })).toBe(false);
    expect(shouldReloadOnNavigation({ ...NAVIGATION, latestBuildId: null })).toBe(false);
  });

  it('путь не менялся (сменился только ?tab= или хвостовой слэш) — не трогаем', () => {
    expect(shouldReloadOnNavigation({ ...NAVIGATION, nextPath: '/timesheet' })).toBe(false);
    expect(shouldReloadOnNavigation({ ...NAVIGATION, nextPath: '/timesheet/' })).toBe(false);
  });

  it('вход и 2FA перезагрузкой не прерываем', () => {
    expect(shouldReloadOnNavigation({ ...NAVIGATION, prevPath: '/login', nextPath: '/verify-2fa' })).toBe(false);
    expect(shouldReloadOnNavigation({ ...NAVIGATION, prevPath: '/verify-2fa', nextPath: '/' })).toBe(false);
    expect(shouldReloadOnNavigation({ ...NAVIGATION, prevPath: '/', nextPath: '/dashboard' })).toBe(false);
    expect(shouldReloadOnNavigation({ ...NAVIGATION, nextPath: '/login' })).toBe(false);
    expect(shouldReloadOnNavigation({ ...NAVIGATION, prevPath: '/login/', nextPath: '/dashboard' })).toBe(false);
  });

  it('пока летит сохранение — ждём следующего перехода', () => {
    expect(shouldReloadOnNavigation({ ...NAVIGATION, isMutating: true })).toBe(false);
  });

  it('ради одной сборки перезагружаемся один раз, ради следующей — снова', () => {
    expect(shouldReloadOnNavigation({ ...NAVIGATION, reloadedFor: 'bbb' })).toBe(false);
    expect(shouldReloadOnNavigation({ ...NAVIGATION, reloadedFor: 'aaa' })).toBe(true);
  });
});

describe('isBannerDue', () => {
  it('баннер — только через 2 часа после обнаружения сборки', () => {
    const detectedAt = 1_000_000;
    expect(isBannerDue(null, detectedAt + BANNER_DELAY_MS)).toBe(false);
    expect(isBannerDue(detectedAt, detectedAt)).toBe(false);
    expect(isBannerDue(detectedAt, detectedAt + BANNER_DELAY_MS - 1)).toBe(false);
    expect(isBannerDue(detectedAt, detectedAt + BANNER_DELAY_MS)).toBe(true);
  });
});
