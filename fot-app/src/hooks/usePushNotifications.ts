import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../api/client';

type NotificationPermission = 'default' | 'granted' | 'denied';

interface IUsePushNotifications {
  isSupported: boolean;
  permission: NotificationPermission;
  isSubscribed: boolean;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
}

const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
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

  // Регистрируем SW и проверяем текущую подписку
  useEffect(() => {
    if (!isSupported) return;

    navigator.serviceWorker
      .register('/sw.js')
      .then(async (reg) => {
        setRegistration(reg);
        const existing = await reg.pushManager.getSubscription();
        setIsSubscribed(!!existing);
      })
      .catch(() => undefined);
  }, [isSupported]);

  const subscribe = useCallback(async () => {
    if (!isSupported || !registration) return;

    const perm = await Notification.requestPermission();
    setPermission(perm);
    if (perm !== 'granted') return;

    try {
      const res = await apiClient.get<{ success: boolean; data: { publicKey: string } }>(
        '/push/vapid-public-key',
        { skipAuth: true },
      );
      if (!res.success) return;

      const applicationServerKey = urlBase64ToUint8Array(res.data.publicKey);
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });

      const json = sub.toJSON();
      await apiClient.post('/push/subscribe', {
        endpoint: json.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
      });

      setIsSubscribed(true);
    } catch {
      // ignore — пользователь отклонил или сервер не настроен
    }
  }, [isSupported, registration]);

  const unsubscribe = useCallback(async () => {
    if (!isSupported || !registration) return;

    const sub = await registration.pushManager.getSubscription();
    if (!sub) return;

    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await apiClient.delete('/push/subscribe', { body: JSON.stringify({ endpoint }) });
    setIsSubscribed(false);
  }, [isSupported, registration]);

  return { isSupported, permission, isSubscribed, subscribe, unsubscribe };
};
