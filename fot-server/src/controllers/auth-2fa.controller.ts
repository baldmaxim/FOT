import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { totpService } from '../services/totp.service.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, UserProfile } from '../types/index.js';
import { resolveDepartmentId } from './auth.controller.js';
import { getRoleById } from '../services/roles-cache.service.js';
import {
  generateAccessToken,
  generateRefreshToken,
  setSessionCookies,
} from '../utils/auth-session.js';

const verify2FASchema = z.object({
  code: z.string().length(6),
});

const recoveryCodeSchema = z.object({
  code: z.string().min(8).max(9),
});

export const verify2FA = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { code } = verify2FASchema.parse(req.body);

    const { data: profileRow, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error || !profileRow || !profileRow.totp_secret) {
      res.status(400).json({ success: false, error: '2FA not configured' });
      return;
    }

    const profile = profileRow as UserProfile;
    const isValid = totpService.verifyToken(profile.totp_secret!, code);

    if (!isValid) {
      await auditService.logFromRequest(req, req.user.id, '2FA_FAILED');
      res.status(401).json({ success: false, error: 'Invalid 2FA code' });
      return;
    }

    const role = await getRoleById(profile.system_role_id);
    if (!role) {
      res.status(500).json({ success: false, error: 'Роль пользователя не найдена' });
      return;
    }

    const departmentId = await resolveDepartmentId(profile.employee_id);
    const token = generateAccessToken(profile, role, req.user.email, true, departmentId);
    const refreshToken = generateRefreshToken(profile.id, req.user.email);
    setSessionCookies(res, token, refreshToken);

    await auditService.logFromRequest(req, req.user.id, '2FA_VERIFIED');

    res.json({
      success: true,
      token,
      refresh_token: refreshToken,
      user: {
        id: profile.id,
        email: req.user.email,
        full_name: profile.full_name,
        role_code: role.code,
        is_admin: role.is_admin,
        employee_variant: role.employee_variant,
        imported_position: profile.imported_position,
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

export const useRecoveryCode = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { code } = recoveryCodeSchema.parse(req.body);

    const { data: profileRow, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error || !profileRow || !profileRow.recovery_codes) {
      res.status(400).json({ success: false, error: 'Recovery codes not available' });
      return;
    }

    const profile = profileRow as UserProfile;
    const usedIndex = totpService.verifyRecoveryCode(profile.recovery_codes!, code);

    if (usedIndex === -1) {
      await auditService.logFromRequest(req, req.user.id, '2FA_FAILED', {
        details: { method: 'recovery_code' },
      });
      res.status(401).json({ success: false, error: 'Invalid recovery code' });
      return;
    }

    const updatedCodes = [...profile.recovery_codes!];
    updatedCodes.splice(usedIndex, 1);

    await supabase
      .from('user_profiles')
      .update({ recovery_codes: updatedCodes })
      .eq('id', req.user.id);

    const role = await getRoleById(profile.system_role_id);
    if (!role) {
      res.status(500).json({ success: false, error: 'Роль пользователя не найдена' });
      return;
    }

    const departmentId = await resolveDepartmentId(profile.employee_id);
    const token = generateAccessToken(profile, role, req.user.email, true, departmentId);
    const refreshToken = generateRefreshToken(profile.id, req.user.email);
    setSessionCookies(res, token, refreshToken);

    await auditService.logFromRequest(req, req.user.id, '2FA_VERIFIED', {
      details: { method: 'recovery_code', remaining_codes: updatedCodes.length },
    });

    res.json({
      success: true,
      token,
      refresh_token: refreshToken,
      remaining_recovery_codes: updatedCodes.length,
      user: {
        id: profile.id,
        email: req.user.email,
        full_name: profile.full_name,
        role_code: role.code,
        is_admin: role.is_admin,
        employee_variant: role.employee_variant,
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
