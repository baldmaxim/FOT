import { Response } from 'express';
import { supabase } from '../config/database.js';
import { totpService } from '../services/totp.service.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

export const admin2faController = {
  async generate2FA(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const { data: profile, error: fetchError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError || !profile) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      const { data: authUser } = await supabase.auth.admin.getUserById(id);

      if (!authUser?.user?.email) {
        res.status(400).json({ success: false, error: 'User email not found' });
        return;
      }

      const { secret, encryptedSecret } = totpService.generateSecret(authUser.user.email);
      const { codes, encryptedCodes } = totpService.generateRecoveryCodes();
      const qrCode = await totpService.generateQRCode(authUser.user.email, secret);

      const { error: updateError } = await supabase
        .from('user_profiles')
        .update({
          totp_secret: encryptedSecret,
          recovery_codes: encryptedCodes,
          two_factor_enabled: true,
        })
        .eq('id', id);

      if (updateError) {
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

      const { error } = await supabase
        .from('user_profiles')
        .update({
          totp_secret: null,
          recovery_codes: null,
          two_factor_enabled: false,
        })
        .eq('id', id);

      if (error) {
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
