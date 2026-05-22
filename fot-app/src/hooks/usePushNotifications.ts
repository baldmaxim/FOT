import { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import { apiClient } from '../api/client';

type NotificationPermission = 'default' | 'granted' | 'denied';

export type PushSubscribeResult =
  | 'subscribed'
  | 'denied'
  | 'dismissed'
  | 'unsupported'
  | 'error';

export type PushUnsubscribeResult = 'unsubscribed' | 'error';

interface IUsePushNotifications {
  isSupported: boolean;
  permission: NotificationPermission;
  isSubscribed: boolean;
  subscribe: () => Promise<PushSubscribeResult>;
  unsubscribe: () => Promise<PushUnsubscribeResult>;
}

const OPT_OUT_KEY = 'push_opt_out';
const DEVICE_ID_KEY = 'push_device_id';

// Стабильный id браузера. Сервер по нему заменяет подписку при ротации
// push-endpoint, а не плодит новые строки → один браузер = один push.
// localStorage общий для всех окон/вкладок одного origin.
const getDeviceId = (): string => {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
};

const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return new Uint8Array([...rawData].map(char => char.charCodeAt(0)));
};

// Сравнение applicationServerKey уже существующей подписки с актуальным
// VAPID-ключом. При ротации ключа (cutover) старый ключ не совпадёт и
// pushManager.subscribe() кинул бы InvalidStateError.
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a) return false;
  const av = new Uint8Array(a);
  if (av.length !== b.length) return false;
  for (let i = 0; i < av.length; i += 1) {
    if (av[i] !== b[i]) return false;
  }
  return true;
};

const saveSubscriptionToServer = async (sub: PushSubscription): Promise<boolean> => {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
  try {
    await apiClient.post('/push/subscribe', {
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      device_id: getDeviceId(),
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

    const keyBytes = urlBase64ToUint8Array(res.data.publicKey);
    const applicationServerKey = keyBytes.buffer as ArrayBuffer;

    let sub = await reg.pushManager.getSubscription();
    // Старая подписка с другим VAPID-ключом → без переотписки повторный
    // subscribe() кинет InvalidStateError и тумблер молча не включится.
    if (sub && !sameKey(sub.options.applicationServerKey, keyBytes)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }
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

  // Достаём регистрацию SW устойчиво: не полагаемся на гонку setRegistration —
  // навигатор отдаёт активную регистрацию через serviceWorker.ready.
  const resolveRegistration = useCallback(async (): Promise<ServiceWorkerRegistration | null> => {
    if (registration) return registration;
    try {
      const reg = await navigator.serviceWorker.ready;
      setRegistration(reg);
      return reg;
    } catch (err) {
      console.error('[push] serviceWorker.ready failed', err);
      Sentry.captureException(err, { tags: { push: 'sw-ready' } });
      return null;
    }
  }, [registration]);

  const subscribe = useCallback(async (): Promise<PushSubscribeResult> => {
    if (!isSupported) return 'unsupported';

    const reg = await resolveRegistration();
    if (!reg) return 'error';

    let perm: NotificationPermission;
    try {
      perm = await Notification.requestPermission();
    } catch (err) {
      console.error('[push] requestPermission failed', err);
      Sentry.captureException(err, { tags: { push: 'request-permission' } });
      return 'error';
    }
    setPermission(perm);

    if (perm === 'denied') {
      console.warn('[push] permission denied');
      Sentry.addBreadcrumb({ category: 'push', level: 'warning', message: 'permission denied' });
      return 'denied';
    }
    if (perm !== 'granted') {
      console.warn('[push] permission prompt dismissed (default)');
      Sentry.addBreadcrumb({ category: 'push', level: 'info', message: 'permission dismissed' });
      return 'dismissed';
    }

    const ok = await createSubscription(reg);
    if (!ok) return 'error';

    localStorage.removeItem(OPT_OUT_KEY);
    setIsSubscribed(true);
    return 'subscribed';
  }, [isSupported, resolveRegistration]);

  const unsubscribe = useCallback(async (): Promise<PushUnsubscribeResult> => {
    if (!isSupported) return 'error';

    // Запоминаем явный отказ, чтобы авто-подписка при granted не включила обратно.
    localStorage.setItem(OPT_OUT_KEY, '1');

    const reg = await resolveRegistration();
    try {
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await apiClient.delete('/push/subscribe', { body: JSON.stringify({ endpoint }) });
      }
      setIsSubscribed(false);
      return 'unsubscribed';
    } catch (err) {
      console.error('[push] unsubscribe failed', err);
      Sentry.captureException(err, { tags: { push: 'unsubscribe' } });
      setIsSubscribed(false);
      return 'error';
    }
  }, [isSupported, resolveRegistration]);

  return { isSupported, permission, isSubscribed, subscribe, unsubscribe };
};
