import crypto from 'crypto';
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { supabase, supabaseAuth } from '../config/database.js';
import { env } from '../config/env.js';
import { totpService } from '../services/totp.service.js';
import { auditService } from '../services/audit.service.js';
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

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
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

      // Получаем профиль с данными системной роли
      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select(`
          *,
          system_role:system_roles!system_role_id(code, name)
        `)
        .eq('id', authData.user.id)
        .single();

      if (profileError || !profile) {
        res.status(404).json({ success: false, error: 'User profile not found' });
        return;
      }

      // Маппинг system_role_id в position_type для обратной совместимости
      let positionType = profile.position_type;
      if (profile.system_role) {
        const roleCode = profile.system_role.code;
        // Маппинг кода роли в ENUM значение
        if (roleCode === 'super_admin') positionType = 'super_admin';
        else if (roleCode === 'admin') positionType = 'admin';
        else if (roleCode === 'header') positionType = 'header';
        else if (roleCode === 'worker') positionType = 'worker';
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
            position_type: positionType,
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
          position_type: positionType,
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
   * POST /api/auth/forgot-password
   * Запрос на сброс пароля
   */
  async forgotPassword(req: Request, res: Response): Promise<void> {
    try {
      const { email } = forgotPasswordSchema.parse(req.body);

      // Ищем пользователя в Supabase Auth
      const { data: usersData, error: listError } = await supabase.auth.admin.listUsers();

      if (listError) {
        console.error('List users error:', listError);
        // Не раскрываем детали ошибки
        res.json({
          success: true,
          message: 'Если аккаунт с таким email существует, инструкции по сбросу пароля будут отправлены.',
        });
        return;
      }

      const user = usersData.users.find(u => u.email === email);

      if (!user) {
        // Не раскрываем, что пользователя нет — для безопасности
        res.json({
          success: true,
          message: 'Если аккаунт с таким email существует, инструкции по сбросу пароля будут отправлены.',
        });
        return;
      }

      // Генерируем токен сброса
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 час

      // Сохраняем токен в профиле
      const { error: updateError } = await supabase
        .from('user_profiles')
        .update({
          reset_token: resetToken,
          reset_token_expires: resetTokenExpires,
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('Update reset token error:', updateError);
        res.status(500).json({ success: false, error: 'Не удалось создать запрос на сброс пароля' });
        return;
      }

      await auditService.logFromRequest(req, user.id, 'PASSWORD_RESET_REQUESTED' as any, {
        details: { email },
      });

      // В production здесь будет отправка email
      // Для разработки логируем токен в консоль
      console.log(`[Password Reset] Token for ${email}: ${resetToken}`);

      res.json({
        success: true,
        message: 'Если аккаунт с таким email существует, инструкции по сбросу пароля будут отправлены.',
        // В development режиме возвращаем токен (убрать в production)
        ...(env.NODE_ENV === 'development' && { reset_token: resetToken }),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Forgot password error:', error);
      res.status(500).json({ success: false, error: 'Ошибка при запросе сброса пароля' });
    }
  },

  /**
   * POST /api/auth/reset-password
   * Сброс пароля по токену
   */
  async resetPassword(req: Request, res: Response): Promise<void> {
    try {
      const { token, password } = resetPasswordSchema.parse(req.body);

      // Ищем профиль с таким токеном
      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('id, reset_token, reset_token_expires')
        .eq('reset_token', token)
        .single();

      if (profileError || !profile) {
        res.status(400).json({ success: false, error: 'Недействительная или просроченная ссылка для сброса пароля' });
        return;
      }

      // Проверяем срок действия
      if (!profile.reset_token_expires || new Date(profile.reset_token_expires) < new Date()) {
        // Очищаем просроченный токен
        await supabase
          .from('user_profiles')
          .update({ reset_token: null, reset_token_expires: null })
          .eq('id', profile.id);

        res.status(400).json({ success: false, error: 'Ссылка для сброса пароля истекла. Запросите новую.' });
        return;
      }

      // Обновляем пароль через Supabase Admin API
      const { error: updateError } = await supabase.auth.admin.updateUserById(profile.id, {
        password,
      });

      if (updateError) {
        console.error('Password update error:', updateError);
        res.status(500).json({ success: false, error: 'Не удалось обновить пароль' });
        return;
      }

      // Очищаем токен сброса
      await supabase
        .from('user_profiles')
        .update({ reset_token: null, reset_token_expires: null })
        .eq('id', profile.id);

      await auditService.logFromRequest(req, profile.id, 'PASSWORD_RESET_COMPLETED' as any, {
        details: { method: 'reset_token' },
      });

      res.json({
        success: true,
        message: 'Пароль успешно изменён. Теперь вы можете войти с новым паролем.',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Reset password error:', error);
      res.status(500).json({ success: false, error: 'Ошибка при сбросе пароля' });
    }
  },

  /**
   * GET /api/auth/me
   * Получение текущего пользователя
   */
  async getMe(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Получаем профиль с данными системной роли
      const { data: profile, error } = await supabase
        .from('user_profiles')
        .select(`
          *,
          system_role:system_roles!system_role_id(code, name)
        `)
        .eq('id', req.user.id)
        .single();

      if (error || !profile) {
        res.status(404).json({ success: false, error: 'Profile not found' });
        return;
      }

      // Маппинг system_role_id в position_type для обратной совместимости
      let positionType = profile.position_type;
      if (profile.system_role) {
        const roleCode = profile.system_role.code;
        // Маппинг кода роли в ENUM значение
        if (roleCode === 'super_admin') positionType = 'super_admin';
        else if (roleCode === 'admin') positionType = 'admin';
        else if (roleCode === 'header') positionType = 'header';
        else if (roleCode === 'worker') positionType = 'worker';
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
          position_type: positionType,
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
        .select('id, name')
        .order('created_at');

      if (error) {
        console.error('Get organizations error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch organizations' });
        return;
      }

      const organizations = (orgsEncrypted || [])
        .map((org: { id: string; name: string }) => ({
          id: org.id,
          name: org.name || '',
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
