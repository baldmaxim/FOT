import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { totpService } from '../services/totp.service.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, UserProfile } from '../types/index.js';
import { generateToken } from './auth.controller.js';

// Схемы валидации
const verify2FASchema = z.object({
  code: z.string().length(6),
});

const recoveryCodeSchema = z.object({
  code: z.string().min(8).max(9), // XXXX-XXXX или XXXXXXXX
});

/**
 * POST /api/auth/verify-2fa
 * Верификация 2FA кода
 */
export const verify2FA = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { code } = verify2FASchema.parse(req.body);

    const { data: profile, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error || !profile || !profile.totp_secret) {
      res.status(400).json({ success: false, error: '2FA not configured' });
      return;
    }

    const isValid = totpService.verifyToken(profile.totp_secret, code);

    if (!isValid) {
      await auditService.logFromRequest(req, req.user.id, '2FA_FAILED');
      res.status(401).json({ success: false, error: 'Invalid 2FA code' });
      return;
    }

    const token = generateToken(profile as UserProfile, req.user.email, true);

    await auditService.logFromRequest(req, req.user.id, '2FA_VERIFIED');

    res.json({
      success: true,
      token,
      user: {
        id: profile.id,
        email: req.user.email,
        full_name: profile.full_name,
        position_type: profile.position_type,
        imported_position: profile.imported_position,
        organization_id: profile.organization_id,
        two_factor_enabled: profile.two_factor_enabled,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: error.errors[0].message });
      return;
    }
    console.error('2FA verification error:', error);
    res.status(500).json({ success: false, error: '2FA verification failed' });
  }
};

/**
 * POST /api/auth/recovery
 * Вход с кодом восстановления
 */
export const useRecoveryCode = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { code } = recoveryCodeSchema.parse(req.body);

    const { data: profile, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error || !profile || !profile.recovery_codes) {
      res.status(400).json({ success: false, error: 'Recovery codes not available' });
      return;
    }

    const usedIndex = totpService.verifyRecoveryCode(profile.recovery_codes, code);

    if (usedIndex === -1) {
      await auditService.logFromRequest(req, req.user.id, '2FA_FAILED', {
        details: { method: 'recovery_code' },
      });
      res.status(401).json({ success: false, error: 'Invalid recovery code' });
      return;
    }

    const updatedCodes = [...profile.recovery_codes];
    updatedCodes.splice(usedIndex, 1);

    await supabase
      .from('user_profiles')
      .update({ recovery_codes: updatedCodes })
      .eq('id', req.user.id);

    const token = generateToken(profile as UserProfile, req.user.email, true);

    await auditService.logFromRequest(req, req.user.id, '2FA_VERIFIED', {
      details: { method: 'recovery_code', remaining_codes: updatedCodes.length },
    });

    res.json({
      success: true,
      token,
      remaining_recovery_codes: updatedCodes.length,
      user: {
        id: profile.id,
        email: req.user.email,
        full_name: profile.full_name,
        position_type: profile.position_type,
        organization_id: profile.organization_id,
        two_factor_enabled: profile.two_factor_enabled,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ success: false, error: error.errors[0].message });
      return;
    }
    console.error('Recovery code error:', error);
    res.status(500).json({ success: false, error: 'Recovery failed' });
  }
};
