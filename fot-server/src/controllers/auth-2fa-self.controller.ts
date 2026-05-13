import { Response } from 'express';
import { z } from 'zod';
import { execute, queryOne } from '../config/postgres.js';
import { localAuthService } from '../services/local-auth.service.js';
import { totpService } from '../services/totp.service.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const enable2FASchema = z.object({
  code: z.string().length(6),
});

export const auth2faSelfController = {
  async setup2FA(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const profile = await queryOne<{ two_factor_enabled: boolean }>(
        'SELECT two_factor_enabled FROM user_profiles WHERE id = $1::uuid',
        [req.user.id],
      );

      if (!profile) {
        res.status(404).json({ success: false, error: 'Профиль не найден' });
        return;
      }

      if (profile.two_factor_enabled) {
        res.status(400).json({ success: false, error: '2FA уже включена' });
        return;
      }

      const authUser = await localAuthService.getUserById(req.user.id);

      if (!authUser?.email) {
        res.status(400).json({ success: false, error: 'Email пользователя не найден' });
        return;
      }

      const { secret, encryptedSecret } = totpService.generateSecret(authUser.email);
      const qrCode = await totpService.generateQRCode(authUser.email, secret);

      try {
        await execute(
          'UPDATE user_profiles SET totp_secret = $1 WHERE id = $2::uuid',
          [encryptedSecret, req.user.id],
        );
      } catch (updateError) {
        console.error('Setup 2FA error:', updateError);
        res.status(500).json({ success: false, error: 'Не удалось сохранить настройки 2FA' });
        return;
      }

      res.json({ success: true, secret, qrCode });
    } catch (error) {
      console.error('Setup 2FA error:', error);
      res.status(500).json({ success: false, error: 'Ошибка настройки 2FA' });
    }
  },

  async enable2FA(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { code } = enable2FASchema.parse(req.body);

      const profile = await queryOne<{ totp_secret: string | null; two_factor_enabled: boolean }>(
        'SELECT totp_secret, two_factor_enabled FROM user_profiles WHERE id = $1::uuid',
        [req.user.id],
      );

      if (!profile) {
        res.status(404).json({ success: false, error: 'Профиль не найден' });
        return;
      }

      if (profile.two_factor_enabled) {
        res.status(400).json({ success: false, error: '2FA уже включена' });
        return;
      }

      if (!profile.totp_secret) {
        res.status(400).json({ success: false, error: 'Сначала выполните настройку 2FA' });
        return;
      }

      const isValid = totpService.verifyToken(profile.totp_secret, code);

      if (!isValid) {
        res.status(400).json({ success: false, error: 'Неверный код подтверждения' });
        return;
      }

      const { codes, encryptedCodes } = totpService.generateRecoveryCodes();

      try {
        await execute(
          `UPDATE user_profiles
              SET two_factor_enabled = true, recovery_codes = $1
            WHERE id = $2::uuid`,
          [encryptedCodes, req.user.id],
        );
      } catch (updateError) {
        console.error('Enable 2FA error:', updateError);
        res.status(500).json({ success: false, error: 'Не удалось включить 2FA' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, '2FA_ENABLED', {
        entityType: 'user',
        entityId: req.user.id,
      });

      res.json({
        success: true,
        recoveryCodes: codes.map(totpService.formatRecoveryCode),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Enable 2FA error:', error);
      res.status(500).json({ success: false, error: 'Ошибка включения 2FA' });
    }
  },

  async disable2FA(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      try {
        await execute(
          `UPDATE user_profiles
              SET totp_secret = NULL, recovery_codes = NULL, two_factor_enabled = false
            WHERE id = $1::uuid`,
          [req.user.id],
        );
      } catch (error) {
        console.error('Disable 2FA error:', error);
        res.status(500).json({ success: false, error: 'Не удалось отключить 2FA' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, '2FA_DISABLED', {
        entityType: 'user',
        entityId: req.user.id,
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Disable 2FA error:', error);
      res.status(500).json({ success: false, error: 'Ошибка отключения 2FA' });
    }
  },
};
