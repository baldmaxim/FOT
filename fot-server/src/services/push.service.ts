import webpush from 'web-push';
import * as Sentry from '@sentry/node';
import { execute, query, queryOne, withTransaction } from '../config/postgres.js';
import { env } from '../config/env.js';

// Лимит зашифрованного web-push payload у большинства провайдеров ~4КБ.
const MAX_PAYLOAD_BYTES = 4000;

const vapidReady = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

if (vapidReady) {
  webpush.setVapidDetails(
    env.VAPID_SUBJECT!,
    env.VAPID_PUBLIC_KEY!,
    env.VAPID_PRIVATE_KEY!,
  );
}

interface IPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  device_id?: string;
}

interface IChatNotificationPayload {
  senderName: string;
  messagePreview: string;
  conversationId: string;
}

interface IGenericNotificationPayload {
  [key: string]: unknown;
}

interface ISubscriptionRow {
  user_id?: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const LEAVE_TYPE_LABELS: Record<string, string> = {
  vacation: 'Отпуск',
  sick_leave: 'Больничный',
  remote: 'Удалёнка',
  dayoff: 'Отгул',
  certificate: 'Справка',
  unpaid: 'За свой счёт',
};

async function deleteStaleSubscriptionByEndpoint(endpoint: string): Promise<void> {
  try {
    await execute('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  } catch (err) {
    console.error('push.deleteStaleSubscription failed:', err);
  }
}

// Единая отправка одной подписке: 404/410 → чистим протухшую подписку,
// прочие ошибки больше НЕ глотаем тихо — логируем в Sentry/console,
// иначе в проде невозможно понять, почему пуши не доходят.
async function dispatchToSubscription(
  sub: ISubscriptionRow,
  notification: string,
  context: string,
): Promise<void> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      notification,
    );
  } catch (err: unknown) {
    const statusCode =
      err && typeof err === 'object' && 'statusCode' in err
        ? (err as { statusCode: number }).statusCode
        : undefined;
    if (statusCode === 404 || statusCode === 410) {
      await deleteStaleSubscriptionByEndpoint(sub.endpoint);
      return;
    }
    console.error(`push.send failed [${context}] status=${statusCode ?? 'n/a'}:`, err);
    Sentry.captureException(err, {
      tags: { push: context },
      extra: { statusCode, endpoint: sub.endpoint.slice(0, 60) },
    });
  }
}

// Отправка списку подписок с защитой от слишком большого payload.
async function dispatchToAll(
  subscriptions: ISubscriptionRow[],
  notification: string,
  context: string,
): Promise<void> {
  const size = Buffer.byteLength(notification, 'utf8');
  if (size > MAX_PAYLOAD_BYTES) {
    console.error(`push.send skipped [${context}]: payload ${size}B > ${MAX_PAYLOAD_BYTES}B`);
    Sentry.captureMessage(`push payload too large [${context}]: ${size}B`, 'warning');
    return;
  }
  await Promise.allSettled(
    subscriptions.map((sub) => dispatchToSubscription(sub, notification, context)),
  );
}

export const pushService = {
  async saveSubscription(userId: string, subscription: IPushSubscription): Promise<void> {
    const { endpoint, p256dh, auth, device_id } = subscription;

    // С device_id: одна строка на (пользователь, браузер). При ротации endpoint
    // удаляем прежнюю строку этого устройства (по device_id) и любую строку с
    // тем же endpoint (legacy без device_id), затем вставляем актуальную — так
    // подписки не накапливаются и push не дублируется.
    if (device_id) {
      await withTransaction(async (client) => {
        await client.query(
          `DELETE FROM push_subscriptions
            WHERE user_id = $1::uuid AND (device_id = $2 OR endpoint = $3)`,
          [userId, device_id, endpoint],
        );
        await client.query(
          `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_id)
           VALUES ($1::uuid, $2, $3, $4, $5)`,
          [userId, endpoint, p256dh, auth, device_id],
        );
      });
      return;
    }

    // Клиент старой версии без device_id — прежнее поведение: upsert по endpoint.
    await execute(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1::uuid, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth`,
      [userId, endpoint, p256dh, auth],
    );
  },

  async deleteSubscription(userId: string, endpoint: string): Promise<void> {
    await execute(
      'DELETE FROM push_subscriptions WHERE user_id = $1::uuid AND endpoint = $2',
      [userId, endpoint],
    );
  },

  async sendLeaveRequestNotification(
    employeeId: number,
    requestType: string,
    submitterUserId: string,
  ): Promise<string[]> {
    const profile = await queryOne<{ supervisor_id: string | null }>(
      'SELECT supervisor_id FROM user_profiles WHERE employee_id = $1 LIMIT 1',
      [employeeId],
    );

    const recipientIds = new Set<string>();
    if (profile?.supervisor_id) {
      recipientIds.add(profile.supervisor_id);
    }
    recipientIds.delete(submitterUserId);

    const ids = Array.from(recipientIds);
    if (!vapidReady || ids.length === 0) return ids;

    const label = LEAVE_TYPE_LABELS[requestType] || requestType;
    const notification = JSON.stringify({
      title: 'Новое заявление',
      body: `Сотрудник подал заявление: ${label}`,
    });

    const subscriptions = await query<ISubscriptionRow>(
      `SELECT user_id, endpoint, p256dh, auth FROM push_subscriptions
        WHERE user_id = ANY($1::uuid[])`,
      [ids],
    );

    await dispatchToAll(subscriptions, notification, 'leave-request');

    return ids;
  },

  async sendSalaryRaiseNotification(
    targetUserIds: string[],
    title: string,
    body: string,
  ): Promise<string[]> {
    if (!vapidReady || targetUserIds.length === 0) return targetUserIds;

    const notification = JSON.stringify({ title, body });

    const subscriptions = await query<ISubscriptionRow>(
      `SELECT user_id, endpoint, p256dh, auth FROM push_subscriptions
        WHERE user_id = ANY($1::uuid[])`,
      [targetUserIds],
    );

    await dispatchToAll(subscriptions, notification, 'salary-raise');

    return targetUserIds;
  },

  async sendChatNotification(recipientId: string, payload: IChatNotificationPayload): Promise<void> {
    if (!vapidReady) return;

    const subscriptions = await query<ISubscriptionRow>(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1::uuid',
      [recipientId],
    );

    if (subscriptions.length === 0) return;

    const notification = JSON.stringify({
      title: payload.senderName,
      body: payload.messagePreview,
      conversationId: payload.conversationId,
    });

    await dispatchToAll(subscriptions, notification, 'chat-message');
  },

  async sendGenericNotification(
    targetUserIds: string[],
    title: string,
    body: string,
    payload: IGenericNotificationPayload = {},
  ): Promise<string[]> {
    if (!vapidReady || targetUserIds.length === 0) return targetUserIds;

    const notification = JSON.stringify({
      title,
      body,
      ...payload,
    });

    const subscriptions = await query<ISubscriptionRow>(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions
        WHERE user_id = ANY($1::uuid[])`,
      [targetUserIds],
    );

    await dispatchToAll(subscriptions, notification, 'generic');

    return targetUserIds;
  },
};
