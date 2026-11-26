import { getProfileAccessState, resolveEmploymentBlock } from '../services/account-status.service.js';
import type { JWTPayload } from '../types/index.js';

/**
 * Проверка рукопожатия Socket.IO по БД — то же правило, что authenticate для HTTP:
 *  - профиль существует;
 *  - сотрудник не уволен и не неактивен (служебная учётка с login_when_staff_inactive — исключение);
 *  - версия токена совпадает с профилем (увольнение и перевод в неактивные её повышают). Токен без поля — версия 0,
 *    как в authenticate.
 * Возвращает текст ошибки или null — пускать.
 */
export async function authorizeSocketHandshake(decoded: Pick<JWTPayload, 'sub' | 'token_version'>): Promise<string | null> {
  const state = await getProfileAccessState(decoded.sub);
  if (!state) return 'Profile not found';
  const block = resolveEmploymentBlock(state);
  if (block) return block.error;
  const tokenVersion = Number.isFinite(decoded.token_version) ? Number(decoded.token_version) : 0;
  if (tokenVersion !== state.tokenVersion) return 'Token revoked';
  return null;
}
