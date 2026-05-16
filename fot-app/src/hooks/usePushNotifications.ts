import { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import { apiClient } from '../api/client';

type NotificationPermission = 'default' | 'granted' | 'denied';

interface IUsePushNotifications {
  isSupported: boolean;
  permission: NotificationPermission;
  isSubscribed: boolean;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
}

const OPT_OUT_KEY = 'push_opt_out';

const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return new Uint8Array([...rawData].map(char => char.charCodeAt(0)));
};

const saveSubscriptionToServer = async (sub: PushSubscription): Promise<boolean> => {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
  try {
    await apiClient.post('/push/subscribe', {
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    });
    return true;
  } catch (err) {
    console.error('[push] save subscription failed', err);
    Sentry.captureException(err, { tags: { push: 'save-subscription' } });
    return false;
  }
};

// Создаёт подписку через готовую регистрацию SW. Не запрашивает разрешение —
// вызывается только когда Notification.permission уже 'granted'.
const createSubscription = async (reg: ServiceWorkerRegistration): Promise<boolean> => {
  try {
    const res = await apiClient.get<{ success: boolean; data: { publicKey: string } }>(
      '/push/vapid-public-key',
      { skipAuth: true },
    );
    if (!res.success) return false;

    const applicationServerKey = urlBase64ToUint8Array(res.data.publicKey).buffer as ArrayBuffer;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    return await saveSubscriptionToServer(sub);
  } catch (err) {
    console.error('[push] subscribe failed', err);
    Sentry.captureException(err, { tags: { push: 'subscribe' } });
    return false;
  }
};

export const usePushNotifications = (): IUsePushNotifications => {
  const isSupported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  const [permission, setPermission] = useState<NotificationPermission>(
    isSupported ? Notification.permission : 'denied',
  );
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  // Регистрируем SW. Если подписка уже есть — переотправляем (могла потеряться).
  // Если разрешение уже выдано, подписки нет и пользователь не отключал вручную —
  // тихо подписываем (без повторного промпта). Это закрывает кейс «разрешение
  // в браузере есть, но PushSubscription не создавалась → пуши не приходят».
  useEffect(() => {
    if (!isSupported) return;

    navigator.serviceWorker
      .register('/sw.js')
      .then(async (reg) => {
        setRegistration(reg);
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          setIsSubscribed(true);
          await saveSubscriptionToServer(existing);
          return;
        }
        const optedOut = localStorage.getItem(OPT_OUT_KEY) === '1';
        if (Notification.permission === 'granted' && !optedOut) {
          const ok = await createSubscription(reg);
          if (ok) setIsSubscribed(true);
        }
      })
      .catch((err) => {
        console.error('[push] SW registration failed', err);
        Sentry.captureException(err, { tags: { push: 'sw-register' } });
      });
  }, [isSupported]);

  const subscribe = useCallback(async () => {
    if (!isSupported || !registration) return;

    const perm = await Notification.requestPermission();
    setPermission(perm);
    if (perm !== 'granted') return;

    const ok = await createSubscription(registration);
    if (ok) {
      localStorage.removeItem(OPT_OUT_KEY);
      setIsSubscribed(true);
    }
  }, [isSupported, registration]);

  const unsubscribe = useCallback(async () => {
    if (!isSupported || !registration) return;

    // Запоминаем явный отказ, чтобы авто-подписка при granted не включила обратно.
    localStorage.setItem(OPT_OUT_KEY, '1');

    const sub = await registration.pushManager.getSubscription();
    if (!sub) {
      setIsSubscribed(false);
      return;
    }

    const endpoint = sub.endpoint;
    try {
      await sub.unsubscribe();
      await apiClient.delete('/push/subscribe', { body: JSON.stringify({ endpoint }) });
    } catch (err) {
      console.error('[push] unsubscribe failed', err);
      Sentry.captureException(err, { tags: { push: 'unsubscribe' } });
    }
    setIsSubscribed(false);
  }, [isSupported, registration]);

  return { isSupported, permission, isSubscribed, subscribe, unsubscribe };
};
