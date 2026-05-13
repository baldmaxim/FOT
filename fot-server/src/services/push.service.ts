import webpush from 'web-push';
import { execute, query, queryOne } from '../config/postgres.js';
import { env } from '../config/env.js';

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
};

async function deleteStaleSubscriptionByEndpoint(endpoint: string): Promise<void> {
  try {
    await execute('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  } catch (err) {
    console.error('push.deleteStaleSubscription failed:', err);
  }
}

export const pushService = {
  async saveSubscription(userId: string, subscription: IPushSubscription): Promise<void> {
    await execute(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1::uuid, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth`,
      [userId, subscription.endpoint, subscription.p256dh, subscription.auth],
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

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            notification,
          );
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 410) {
            await deleteStaleSubscriptionByEndpoint(sub.endpoint);
          }
        }
      }),
    );

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

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            notification,
          );
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 410) {
            await deleteStaleSubscriptionByEndpoint(sub.endpoint);
          }
        }
      }),
    );

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

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            notification,
          );
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 410) {
            await deleteStaleSubscriptionByEndpoint(sub.endpoint);
          }
        }
      }),
    );
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

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            notification,
          );
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 410) {
            await deleteStaleSubscriptionByEndpoint(sub.endpoint);
          }
        }
      }),
    );

    return targetUserIds;
  },
};
