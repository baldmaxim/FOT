import webpush from 'web-push';
import { supabase } from '../config/database.js';
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

const LEAVE_TYPE_LABELS: Record<string, string> = {
  vacation: 'Отпуск',
  sick_leave: 'Больничный',
  remote: 'Удалёнка',
  dayoff: 'Отгул',
  certificate: 'Справка',
};

export const pushService = {
  async saveSubscription(userId: string, subscription: IPushSubscription): Promise<void> {
    await supabase
      .from('push_subscriptions')
      .upsert(
        { user_id: userId, ...subscription },
        { onConflict: 'user_id,endpoint' },
      );
  },

  async deleteSubscription(userId: string, endpoint: string): Promise<void> {
    await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', userId)
      .eq('endpoint', endpoint);
  },

  /** Возвращает user_id непосредственного руководителя (supervisor_id) */
  async sendLeaveRequestNotification(
    employeeId: number,
    requestType: string,
    submitterUserId: string,
  ): Promise<string[]> {
    // Находим непосредственного руководителя через supervisor_id
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('supervisor_id')
      .eq('employee_id', employeeId)
      .single();

    const recipientIds = new Set<string>();

    if (profile?.supervisor_id) {
      recipientIds.add(profile.supervisor_id);
    }

    // Исключаем самого отправителя (на случай если сам себе руководитель)
    recipientIds.delete(submitterUserId);

    const ids = Array.from(recipientIds);

    if (!vapidReady || ids.length === 0) return ids;

    const label = LEAVE_TYPE_LABELS[requestType] || requestType;
    const notification = JSON.stringify({
      title: 'Новое заявление',
      body: `Сотрудник подал заявление: ${label}`,
    });

    const { data: subscriptions } = await supabase
      .from('push_subscriptions')
      .select('user_id, endpoint, p256dh, auth')
      .in('user_id', ids);

    await Promise.allSettled(
      (subscriptions || []).map(async (sub: { user_id: string; endpoint: string; p256dh: string; auth: string }) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            notification,
          );
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 410) {
            await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          }
        }
      }),
    );

    return ids;
  },

  /** Отправить уведомление о заявке на повышение по списку user_ids */
  async sendSalaryRaiseNotification(
    targetUserIds: string[],
    title: string,
    body: string,
  ): Promise<string[]> {
    if (!vapidReady || targetUserIds.length === 0) return targetUserIds;

    const notification = JSON.stringify({ title, body });

    const { data: subscriptions } = await supabase
      .from('push_subscriptions')
      .select('user_id, endpoint, p256dh, auth')
      .in('user_id', targetUserIds);

    await Promise.allSettled(
      (subscriptions || []).map(async (sub: { user_id: string; endpoint: string; p256dh: string; auth: string }) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            notification,
          );
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 410) {
            await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          }
        }
      }),
    );

    return targetUserIds;
  },

  async sendChatNotification(recipientId: string, payload: IChatNotificationPayload): Promise<void> {
    if (!vapidReady) return;

    const { data: subscriptions } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', recipientId);

    if (!subscriptions || subscriptions.length === 0) return;

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
          // Подписка устарела — удаляем
          if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 410) {
            await supabase
              .from('push_subscriptions')
              .delete()
              .eq('endpoint', sub.endpoint);
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

    const { data: subscriptions } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .in('user_id', targetUserIds);

    await Promise.allSettled(
      (subscriptions || []).map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            notification,
          );
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 410) {
            await supabase
              .from('push_subscriptions')
              .delete()
              .eq('endpoint', sub.endpoint);
          }
        }
      }),
    );

    return targetUserIds;
  },
};
