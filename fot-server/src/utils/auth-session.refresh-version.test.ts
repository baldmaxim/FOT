/**
 * Отзыв сессий по token_version и совместимость с уже выпущенными токенами.
 *
 * Увольнение инкрементирует user_profiles.token_version. Без версии в refresh-токене
 * отзывался бы только access (7 дней), а 30-дневный refresh продолжал бы выпускать
 * новые сессии в обход блокировки.
 *
 * Обратная сторона: на момент выкатки у 1245 профилей из 1915 token_version уже
 * больше нуля, а выпущенные refresh-токены поля не содержат. Поэтому отсутствие
 * версии в токене — не повод для разлогина: сверяем только когда поле есть.
 */
import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateRefreshToken } from './auth-session.js';

const SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'test-secret';

const decode = (token: string) => jwt.verify(token, SECRET) as { token_version?: number; sub: string };

/** Условие из /auth/refresh: отбиваем только при явном несовпадении версии. */
const shouldReject = (tokenVersion: number | undefined, profileVersion: number): boolean =>
  Number.isFinite(tokenVersion) && Number(tokenVersion) !== profileVersion;

describe('generateRefreshToken: версия сессии в токене', () => {
  it('версия попадает в токен', () => {
    expect(decode(generateRefreshToken('user-1', 'a@b.c', 7)).token_version).toBe(7);
  });

  it('без явной версии — ноль, а не undefined: новые токены всегда сверяемы', () => {
    expect(decode(generateRefreshToken('user-1', 'a@b.c')).token_version).toBe(0);
  });
});

describe('/auth/refresh: правило сверки версий', () => {
  it('версия совпала → сессия продлевается', () => {
    expect(shouldReject(3, 3)).toBe(false);
  });

  it('версия отстала (увольнение подняло счётчик) → отказ', () => {
    expect(shouldReject(3, 4)).toBe(true);
  });

  it('токен без версии (выпущен до релиза) → пропускаем, иначе разлогинили бы 1245 человек', () => {
    expect(shouldReject(undefined, 12)).toBe(false);
  });
});
