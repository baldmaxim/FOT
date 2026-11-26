import type { Server } from 'socket.io';

let _io: Server | null = null;

export const setIo = (io: Server): void => {
  _io = io;
};

export const getIo = (): Server | null => _io;

/**
 * Рвёт живые сокеты пользователя. Handshake проверяет статус доступа, но уже
 * открытое соединение его не перепроверяет — без этого чат продолжал бы работать
 * после отключения учётной записи. Best-effort: сбой не должен валить операцию.
 *
 * В отличие от аналога в employee-lifecycle-operations (тот работает по
 * employee_id), здесь ключ — user_profile_id: учётка может быть не привязана
 * к карточке сотрудника.
 */
export const disconnectUserSockets = async (userProfileId: string): Promise<void> => {
  try {
    const io = getIo();
    if (!io) return;
    io.in(`user:${userProfileId}`).disconnectSockets(true);
  } catch (error) {
    console.error('[socket] disconnectUserSockets failed:', error);
  }
};

/** Событие сокета: вход учётке закрыт — клиент выходит на форму входа с причиной (миграция 381). */
export const ACCOUNT_BLOCKED_EVENT = 'account_blocked';

export interface IAccountBlockedPayload {
  code: string;
  message: string;
}

/**
 * Закрывает вход открытым вкладкам учёток: шлёт ACCOUNT_BLOCKED_EVENT с причиной, затем отключает их сокеты от
 * пространства имён. disconnectSockets(false) — пакет отключения идёт в том же потоке после события, поэтому событие
 * доходит раньше; повторное подключение режет рукопожатие (статус и token_version). Best-effort: сбой не валит
 * уже закоммиченный перевод — HTTP-запросы всё равно получат 403.
 */
export const blockUserSockets = (userProfileIds: readonly string[], payload: IAccountBlockedPayload): void => {
  try {
    const io = getIo();
    if (!io) return;
    for (const userProfileId of userProfileIds) {
      const room = `user:${userProfileId}`;
      io.to(room).emit(ACCOUNT_BLOCKED_EVENT, payload);
      io.in(room).disconnectSockets(false);
    }
  } catch (error) {
    console.error('[socket] blockUserSockets failed:', error);
  }
};
