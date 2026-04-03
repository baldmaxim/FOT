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

const LEAVE_TYPE_LABELS: Record<string, string> = {
  vacation: 'Отпуск',
  sick_leave: 'Больничный',
  remote: 'Удалёнка',
  dayoff: 'Отгул',
  business_trip: 'Командировка',
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

  /** Возвращает user_ids получателей (руководитель отдела + админы), исключая submitterUserId */
  async sendLeaveRequestNotification(
    employeeId: number,
    requestType: string,
    submitterUserId: string,
  ): Promise<string[]> {
    // Отдел сотрудника
    const { data: emp } = await supabase
      .from('employees')
      .select('org_department_id')
      .eq('id', employeeId)
      .single();

    const recipientIds = new Set<string>();

    // Руководитель отдела
    if (emp?.org_department_id) {
      const { data: headers } = await supabase
        .from('user_profiles')
        .select('id, employee_id')
        .eq('position_type', 'header')
        .eq('is_approved', true);

      if (headers && headers.length > 0) {
        const headerEmpIds = headers.map((h: { id: string; employee_id: number | null }) => h.employee_id).filter(Boolean);
        if (headerEmpIds.length > 0) {
          const { data: headerEmps } = await supabase
            .from('employees')
            .select('id, org_department_id')
            .in('id', headerEmpIds)
            .eq('org_department_id', emp.org_department_id);

          const matchingEmpIds = new Set((headerEmps || []).map((e: { id: number }) => e.id));
          for (const h of headers) {
            if (h.employee_id && matchingEmpIds.has(h.employee_id)) {
              recipientIds.add(h.id);
            }
          }
        }
      }
    }

    // Администраторы
    const { data: admins } = await supabase
      .from('user_profiles')
      .select('id')
      .in('position_type', ['admin', 'super_admin'])
      .eq('is_approved', true);

    for (const a of admins || []) {
      recipientIds.add(a.id);
    }

    // Исключаем самого отправителя
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
