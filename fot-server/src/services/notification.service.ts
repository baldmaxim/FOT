import { execute, query } from '../config/postgres.js';
import { getIo } from '../socket/io-instance.js';

export interface INotification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

interface ICreateNotification {
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

// Шлёт получателю авторитетный счётчик непрочитанных. Вызывается после
// любого изменения (создание/прочтение), чтобы бейдж в шапке был
// консистентен во всех вкладках без перезагрузки.
async function emitUnreadCount(userId: string): Promise<void> {
  const io = getIo();
  if (!io) return;
  try {
    const rows = await query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM notifications
        WHERE user_id = $1 AND is_read = false`,
      [userId],
    );
    io.to(`user:${userId}`).emit('notification_count', { count: rows[0]?.count ?? 0 });
  } catch (err) {
    console.error('notifications.emitUnreadCount error:', err);
  }
}

export const notificationService = {
  async createMany(items: ICreateNotification[]): Promise<void> {
    if (items.length === 0) return;

    // INSERT набора строк с RETURNING-объектом. Используем unnest, чтобы
    // не плодить $1,$2,$3,... в цикле и переносить порядок параметров
    // безопасно через массивы.
    const userIds = items.map(n => n.userId);
    const types = items.map(n => n.type);
    const titles = items.map(n => n.title);
    const bodies = items.map(n => n.body);
    const metadatas = items.map(n => JSON.stringify(n.metadata || {}));

    let data: INotification[] = [];
    try {
      data = await query<INotification>(
        `INSERT INTO notifications (user_id, type, title, body, metadata)
         SELECT u.user_id, u.type, u.title, u.body, u.metadata::jsonb
           FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])
             AS u(user_id, type, title, body, metadata)
         RETURNING id, user_id, type, title, body, metadata, is_read, created_at`,
        [userIds, types, titles, bodies, metadatas],
      );
    } catch (err) {
      console.error('notifications.createMany error:', err);
      return;
    }

    // Отправляем через Socket.IO каждому получателю
    const io = getIo();
    if (io && data.length > 0) {
      for (const notification of data) {
        io.to(`user:${notification.user_id}`).emit('notification_new', notification);
      }
    }

    const recipients = new Set(data.map(n => n.user_id));
    for (const uid of recipients) {
      await emitUnreadCount(uid);
    }
  },

  async getByUser(userId: string, limit = 50, offset = 0): Promise<INotification[]> {
    return query<INotification>(
      `SELECT id, user_id, type, title, body, metadata, is_read, created_at
         FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
  },

  async countUnread(userId: string): Promise<number> {
    const rows = await query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM notifications
        WHERE user_id = $1 AND is_read = false`,
      [userId],
    );
    return rows[0]?.count ?? 0;
  },

  async markRead(userId: string, notificationId: string): Promise<void> {
    await execute(
      `UPDATE notifications SET is_read = true
        WHERE id = $1 AND user_id = $2`,
      [notificationId, userId],
    );
    await emitUnreadCount(userId);
  },

  async markAllRead(userId: string): Promise<void> {
    await execute(
      `UPDATE notifications SET is_read = true
        WHERE user_id = $1 AND is_read = false`,
      [userId],
    );
    await emitUnreadCount(userId);
  },

  // Гасит chat_message-уведомления конкретной переписки при её прочтении,
  // чтобы бейдж не висел после открытия диалога.
  async markChatRead(userId: string, conversationId: string): Promise<void> {
    await execute(
      `UPDATE notifications SET is_read = true
        WHERE user_id = $1 AND type = 'chat_message'
          AND metadata->>'conversationId' = $2 AND is_read = false`,
      [userId, conversationId],
    );
    await emitUnreadCount(userId);
  },
};
