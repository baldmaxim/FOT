import crypto from 'crypto';
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { supabase, supabaseAuth } from '../config/database.js';
import { env } from '../config/env.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, JWTPayload, UserProfile } from '../types/index.js';
import { verify2FA, useRecoveryCode } from './auth-2fa.controller.js';

// Схемы валидации
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  full_name: z.string().min(2, 'Введите ФИО'),
  organization_id: z.string().uuid().optional(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

/**
 * Резолвит department_id из employees по employee_id
 */
export async function resolveDepartmentId(employeeId: number | null): Promise<string | null> {
  if (!employeeId) return null;
  const { data } = await supabase
    .from('employees')
    .select('org_department_id')
    .eq('id', employeeId)
    .single();
  return data?.org_department_id || null;
}

/**
 * Генерирует JWT токен
 */
export function generateToken(
  profile: UserProfile,
  email: string,
  twoFactorVerified: boolean,
  departmentId: string | null = null
): string {
  const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
    sub: profile.id,
    email,
    organization_id: profile.organization_id,
    position_type: profile.position_type,
    employee_id: profile.employee_id,
    department_id: departmentId,
    is_approved: profile.is_approved,
    two_factor_enabled: profile.two_factor_enabled,
    two_factor_verified: twoFactorVerified,
  };

  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

/**
 * POST /api/auth/register
 */
async function register(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, full_name, organization_id } = registerSchema.parse(req.body);

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

    const { error: profileError } = await supabase.from('user_profiles').insert({
      id: authData.user.id,
      full_name,
      organization_id: organization_id || null,
      position_type: 'worker',
      is_approved: false,
      two_factor_enabled: false,
    });

    if (profileError) {
      console.error('Profile creation failed:', profileError);
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
}

/**
 * POST /api/auth/login
 */
async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = loginSchema.parse(req.body);

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
      if (roleCode === 'super_admin') positionType = 'super_admin';
      else if (roleCode === 'admin') positionType = 'admin';
      else if (roleCode === 'header') positionType = 'header';
      else if (roleCode === 'worker') positionType = 'worker';
    }

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

    const departmentId = await resolveDepartmentId(profile.employee_id);
    const accessToken = generateToken(profile, email, true, departmentId);

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
        department_id: departmentId,
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
}

/**
 * POST /api/auth/forgot-password
 */
async function forgotPassword(req: Request, res: Response): Promise<void> {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);

    const { data: usersData, error: listError } = await supabase.auth.admin.listUsers();

    if (listError) {
      console.error('List users error:', listError);
      res.json({
        success: true,
        message: 'Если аккаунт с таким email существует, инструкции по сбросу пароля будут отправлены.',
      });
      return;
    }

    const user = usersData.users.find(u => u.email === email);

    if (!user) {
      res.json({
        success: true,
        message: 'Если аккаунт с таким email существует, инструкции по сбросу пароля будут отправлены.',
      });
      return;
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString();

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

    await auditService.logFromRequest(req, user.id, 'PASSWORD_RESET_REQUESTED', {
      details: { email },
    });

    console.log(`[Password Reset] Token for ${email}: ${resetToken}`);

    res.json({
      success: true,
      message: 'Если аккаунт с таким email существует, инструкции по сбросу пароля будут отправлены.',
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
}

/**
 * POST /api/auth/reset-password
 */
async function resetPassword(req: Request, res: Response): Promise<void> {
  try {
    const { token, password } = resetPasswordSchema.parse(req.body);

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, reset_token, reset_token_expires')
      .eq('reset_token', token)
      .single();

    if (profileError || !profile) {
      res.status(400).json({ success: false, error: 'Недействительная или просроченная ссылка для сброса пароля' });
      return;
    }

    if (!profile.reset_token_expires || new Date(profile.reset_token_expires) < new Date()) {
      await supabase
        .from('user_profiles')
        .update({ reset_token: null, reset_token_expires: null })
        .eq('id', profile.id);

      res.status(400).json({ success: false, error: 'Ссылка для сброса пароля истекла. Запросите новую.' });
      return;
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(profile.id, {
      password,
    });

    if (updateError) {
      console.error('Password update error:', updateError);
      res.status(500).json({ success: false, error: 'Не удалось обновить пароль' });
      return;
    }

    await supabase
      .from('user_profiles')
      .update({ reset_token: null, reset_token_expires: null })
      .eq('id', profile.id);

    await auditService.logFromRequest(req, profile.id, 'PASSWORD_RESET_COMPLETED', {
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
}

/**
 * GET /api/auth/me
 */
async function getMe(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
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

    let positionType = profile.position_type;
    if (profile.system_role) {
      const roleCode = profile.system_role.code;
      if (roleCode === 'super_admin') positionType = 'super_admin';
      else if (roleCode === 'admin') positionType = 'admin';
      else if (roleCode === 'header') positionType = 'header';
      else if (roleCode === 'worker') positionType = 'worker';
    }

    const departmentId = await resolveDepartmentId(profile.employee_id);

    const freshToken = generateToken(
      { ...profile, position_type: positionType } as UserProfile,
      req.user.email,
      req.user.two_factor_verified,
      departmentId,
    );

    res.json({
      success: true,
      access_token: freshToken,
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
        department_id: departmentId,
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
}

/**
 * GET /api/auth/organizations
 */
async function getOrganizations(_req: Request, res: Response): Promise<void> {
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
}

export const authController = {
  register,
  login,
  forgotPassword,
  resetPassword,
  getMe,
  getOrganizations,
  verify2FA,
  useRecoveryCode,
};
