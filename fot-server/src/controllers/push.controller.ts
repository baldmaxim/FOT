import type { Request, Response } from 'express';
import { z } from 'zod';
import { pushService } from '../services/push.service.js';
import { env } from '../config/env.js';

// SSRF mitigation: endpoint должен принадлежать одному из легитимных push-
// провайдеров браузеров. Без allowlist авторизованный пользователь мог бы
// сохранить произвольный URL и заставить сервер слать туда POST'ы.
const PUSH_ENDPOINT_HOST_SUFFIXES = [
  '.googleapis.com',          // FCM (Chrome/Android/Edge через Chromium)
  '.push.services.mozilla.com', // Firefox autopush
  '.push.apple.com',          // Safari/iOS Web Push
  '.notify.windows.com',      // Edge/Windows Notification Service
];

function isAllowedPushEndpoint(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return PUSH_ENDPOINT_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
  } catch {
    return false;
  }
}

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000).refine(isAllowedPushEndpoint, {
    message: 'Push endpoint host is not allowed',
  }),
  // p256dh — base64url ECDH P-256 публичный ключ (65 байт → ~88 символов).
  // auth   — base64url 16-байтовый секрет (~22-24 символа).
  p256dh: z.string().min(80).max(140),
  auth: z.string().min(16).max(40),
  // device_id — стабильный id браузера (localStorage). По нему сервер заменяет
  // подписку при ротации endpoint, а не плодит новые строки. optional —
  // на время выката возможны клиенты старой версии.
  device_id: z.string().min(8).max(64).optional(),
});

export const pushController = {
  getVapidPublicKey(_req: Request, res: Response): void {
    if (!env.VAPID_PUBLIC_KEY) {
      res.status(503).json({ success: false, error: 'Push notifications not configured' });
      return;
    }
    res.json({ success: true, data: { publicKey: env.VAPID_PUBLIC_KEY } });
  },

  async subscribe(req: Request, res: Response): Promise<void> {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid subscription data' });
      return;
    }
    const userId = req.user!.id;
    await pushService.saveSubscription(userId, parsed.data);
    res.json({ success: true });
  },

  async unsubscribe(req: Request, res: Response): Promise<void> {
    const { endpoint } = req.body as { endpoint?: string };
    if (!endpoint) {
      res.status(400).json({ success: false, error: 'endpoint required' });
      return;
    }
    const userId = req.user!.id;
    await pushService.deleteSubscription(userId, endpoint);
    res.json({ success: true });
  },
};
