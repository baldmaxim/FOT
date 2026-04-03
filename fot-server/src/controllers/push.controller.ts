import type { Request, Response } from 'express';
import { z } from 'zod';
import { pushService } from '../services/push.service.js';
import { env } from '../config/env.js';

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
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
