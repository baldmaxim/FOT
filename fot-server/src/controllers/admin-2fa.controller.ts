import { Response } from 'express';
import { execute, queryOne } from '../config/postgres.js';
import { localAuthService } from '../services/local-auth.service.js';
import { totpService } from '../services/totp.service.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, UserProfile } from '../types/index.js';

export const admin2faController = {
  async generate2FA(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const profile = await queryOne<UserProfile>(
        'SELECT * FROM user_profiles WHERE id = $1::uuid',
        [id],
      );

      if (!profile) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      const authUser = await localAuthService.getUserById(id);

      if (!authUser?.email) {
        res.status(400).json({ success: false, error: 'User email not found' });
        return;
      }

      const { secret, encryptedSecret } = totpService.generateSecret(authUser.email);
      const { codes, encryptedCodes } = totpService.generateRecoveryCodes();
      const qrCode = await totpService.generateQRCode(authUser.email, secret);

      try {
        await execute(
          `UPDATE user_profiles
              SET totp_secret = $1, recovery_codes = $2, two_factor_enabled = true
            WHERE id = $3::uuid`,
          [encryptedSecret, encryptedCodes, id],
        );
      } catch (updateError) {
        console.error('Update 2FA error:', updateError);
        res.status(500).json({ success: false, error: 'Failed to save 2FA settings' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, '2FA_ENABLED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({
        success: true,
        data: {
          secret,
          qr_code: qrCode,
          recovery_codes: codes.map(totpService.formatRecoveryCode),
        },
        message: 'Передайте эти данные пользователю безопасным способом',
      });
    } catch (error) {
      console.error('Generate 2FA error:', error);
      res.status(500).json({ success: false, error: 'Failed to generate 2FA' });
    }
  },

  async disable2FA(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      try {
        await execute(
          `UPDATE user_profiles
              SET totp_secret = NULL, recovery_codes = NULL, two_factor_enabled = false
            WHERE id = $1::uuid`,
          [id],
        );
      } catch (error) {
        console.error('Disable 2FA error:', error);
        res.status(500).json({ success: false, error: 'Failed to disable 2FA' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, '2FA_DISABLED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: '2FA disabled for user' });
    } catch (error) {
      console.error('Disable 2FA error:', error);
      res.status(500).json({ success: false, error: 'Failed to disable 2FA' });
    }
  },
};
