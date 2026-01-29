import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { supabase, supabaseAuth } from '../config/database.js';
import { env } from '../config/env.js';
import { totpService } from '../services/totp.service.js';
import { auditService } from '../services/audit.service.js';
import { encryptionService } from '../services/encryption.service.js';
import type { AuthenticatedRequest, JWTPayload, UserProfile } from '../types/index.js';

// Схемы валидации
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

// Схема регистрации: email + пароль + ФИО
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  full_name: z.string().min(2, 'Введите ФИО'),
  organization_id: z.string().uuid().optional(),
});

const verify2FASchema = z.object({
  code: z.string().length(6),
});

const recoveryCodeSchema = z.object({
  code: z.string().min(8).max(9), // XXXX-XXXX или XXXXXXXX
});

/**
 * Генерирует JWT токен
 */
function generateToken(profile: UserProfile, email: string, twoFactorVerified: boolean): string {
  const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
    sub: profile.id,
    email,
    organization_id: profile.organization_id,
    position_type: profile.position_type,
    is_approved: profile.is_approved,
    two_factor_enabled: profile.two_factor_enabled,
    two_factor_verified: twoFactorVerified,
  };

  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export const authController = {
  /**
   * POST /api/auth/register
   * Регистрация нового пользователя
   */
  async register(req: Request, res: Response): Promise<void> {
    try {
      const { email, password, full_name, organization_id } = registerSchema.parse(req.body);

      // 1. Создаём пользователя в Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (authError || !authData.user) {
        if (authError?.message?.includes('already been registered') || authError?.message?.includes('already exists')) {
          res.status(400).json({ success: false, error: 'Пользователь с таким email уже существует' });
          return;
        }
        console.error('Auth creation error:', authError);
        res.status(400).json({ success: false, error: authError?.message || 'Registration failed' });
        return;
      }

      // 2. Создаём профиль пользователя (без привязки к сотруднику - это делает админ)
      const { error: profileError } = await supabase.from('user_profiles').insert({
        id: authData.user.id,
        full_name,
        organization_id: organization_id || null,
        position_type: 'worker',  // По умолчанию
        is_approved: false,       // Требуется одобрение админа
        two_factor_enabled: false,
      });

      if (profileError) {
        console.error('Profile creation failed:', profileError);
        // Откатываем создание пользователя
        await supabase.auth.admin.deleteUser(authData.user.id);
        res.status(500).json({ success: false, error: 'Failed to create user profile' });
        return;
      }

      res.status(201).json({
        success: true,
        message: 'Регистрация успешна. Ожидайте одобрения администратором.',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Register error:', error);
      res.status(500).json({ success: false, error: 'Registration failed' });
    }
  },

  /**
   * POST /api/auth/login
   * Вход в систему
   */
  async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, password } = loginSchema.parse(req.body);

      // Аутентификация через Supabase
      const { data: authData, error: authError } = await supabaseAuth.auth.signInWithPassword({
        email,
        password,
      });

      if (authError || !authData.user) {
        console.error('Login error for', email, ':', authError?.message);
        await auditService.logFromRequest(req, 'unknown', 'LOGIN_FAILED', {
          details: { email, reason: authError?.message },
        });

        let errorMessage = 'Неверный email или пароль';
        if (authError?.message?.includes('Email not confirmed')) {
          errorMessage = 'Email не подтверждён. Обратитесь к администратору.';
        } else if (authError?.message?.includes('Invalid login credentials')) {
          errorMessage = 'Неверный email или пароль';
        } else if (authError?.message) {
          errorMessage = authError.message;
        }

        res.status(401).json({ success: false, error: errorMessage });
        return;
      }

      // Получаем профиль
      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', authData.user.id)
        .single();

      if (profileError || !profile) {
        res.status(404).json({ success: false, error: 'User profile not found' });
        return;
      }

      // Проверяем одобрение
      if (!profile.is_approved) {
        res.status(403).json({
          success: false,
          error: 'Account pending approval',
          code: 'PENDING_APPROVAL',
        });
        return;
      }

      // Если 2FA включена, возвращаем промежуточный ответ
      // TODO: Временно отключено для разработки
      if (false && profile.two_factor_enabled) {
        const tempToken = generateToken(profile, email, false);

        res.json({
          success: true,
          requires_2fa: true,
          access_token: tempToken,
          refresh_token: tempToken,
          user: {
            id: profile.id,
            email,
          },
          profile: {
            id: profile.id,
            full_name: profile.full_name,
            position_type: profile.position_type,
            imported_position: profile.imported_position,
            organization_id: profile.organization_id,
            is_approved: profile.is_approved,
            two_factor_enabled: profile.two_factor_enabled,
          },
        });
        return;
      }

      // 2FA не включена, выдаём полный токен
      const accessToken = generateToken(profile, email, true);

      await auditService.logFromRequest(req, profile.id, 'LOGIN');

      res.json({
        success: true,
        access_token: accessToken,
        refresh_token: accessToken,
        user: {
          id: profile.id,
          email,
        },
        profile: {
          id: profile.id,
          full_name: profile.full_name,
          position_type: profile.position_type,
          imported_position: profile.imported_position,
          employee_id: profile.employee_id,
          supervisor_id: profile.supervisor_id,
          organization_id: profile.organization_id,
          is_approved: profile.is_approved,
          two_factor_enabled: profile.two_factor_enabled,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Login error:', error);
      res.status(500).json({ success: false, error: 'Login failed' });
    }
  },

  /**
   * POST /api/auth/verify-2fa
   * Верификация 2FA кода
   */
  async verify2FA(req: AuthenticatedRequest, res: Response): Promise<void> {
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

      const token = generateToken(profile, req.user.email, true);

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
  },

  /**
   * POST /api/auth/recovery
   * Вход с кодом восстановления
   */
  async useRecoveryCode(req: AuthenticatedRequest, res: Response): Promise<void> {
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

      const token = generateToken(profile, req.user.email, true);

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
  },

  /**
   * GET /api/auth/me
   * Получение текущего пользователя
   */
  async getMe(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: profile, error } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', req.user.id)
        .single();

      if (error || !profile) {
        res.status(404).json({ success: false, error: 'Profile not found' });
        return;
      }

      res.json({
        success: true,
        user: {
          id: profile.id,
          email: req.user.email,
        },
        profile: {
          id: profile.id,
          full_name: profile.full_name,
          position_type: profile.position_type,
          imported_position: profile.imported_position,
          employee_id: profile.employee_id,
          supervisor_id: profile.supervisor_id,
          organization_id: profile.organization_id,
          is_approved: profile.is_approved,
          two_factor_enabled: profile.two_factor_enabled,
          created_at: profile.created_at,
        },
      });
    } catch (error) {
      console.error('Get me error:', error);
      res.status(500).json({ success: false, error: 'Failed to get user' });
    }
  },

  /**
   * GET /api/auth/organizations
   * Публичный список организаций для регистрации
   */
  async getOrganizations(req: Request, res: Response): Promise<void> {
    try {
      const { data: orgsEncrypted, error } = await supabase
        .from('organizations')
        .select('id, name_encrypted')
        .order('created_at');

      if (error) {
        console.error('Get organizations error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch organizations' });
        return;
      }

      // Расшифровываем и сортируем по имени
      const organizations = (orgsEncrypted || [])
        .map((org: { id: string; name_encrypted: string }) => ({
          id: org.id,
          name: encryptionService.decrypt(org.name_encrypted),
        }))
        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'ru'));

      res.json({
        success: true,
        data: organizations,
      });
    } catch (error) {
      console.error('Get organizations error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch organizations' });
    }
  },
};
