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
};
