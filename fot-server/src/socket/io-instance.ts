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
