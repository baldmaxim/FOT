import crypto from 'crypto';
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { supabase, supabaseAuth } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, SystemRole, UserProfile, UserProfileResponse } from '../types/index.js';
import { LOGIN_2FA_ENABLED } from '../config/features.js';
import { getRolePageAccess } from '../services/access-control.service.js';
import { getRoleByCode, getRoleById } from '../services/roles-cache.service.js';
import { listManagedDepartmentIdsForUser } from '../services/department-access.service.js';
import { verify2FA, useRecoveryCode } from './auth-2fa.controller.js';
import {
  clearSessionCookies,
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenFromRequest,
  setSessionCookies,
  verifyRefreshToken,
} from '../utils/auth-session.js';

const DEFAULT_ROLE_CODE_FOR_NEW_USERS = 'office';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  full_name: z.string().min(2, 'Введите ФИО'),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export async function resolveDepartmentId(employeeId: number | null): Promise<string | null> {
  if (!employeeId) return null;
  const { data } = await supabase
    .from('employees')
    .select('org_department_id')
    .eq('id', employeeId)
    .single();
  return data?.org_department_id || null;
}

async function buildProfileResponse(
  profile: UserProfile,
): Promise<{ role: SystemRole; response: UserProfileResponse; departmentId: string | null }> {
  const role = await getRoleById(profile.system_role_id);
  if (!role) {
    throw new Error(`Role not found for user ${profile.id}: ${profile.system_role_id}`);
  }

  const [page_access, departmentId] = await Promise.all([
    getRolePageAccess(role.code),
    resolveDepartmentId(profile.employee_id),
  ]);

  const managed_department_ids = await listManagedDepartmentIdsForUser(
    profile.id,
    null,
    profile.employee_id,
  );

  if (!role.is_admin && managed_department_ids.length > 0 && !page_access['/staff-control']?.can_view) {
    page_access['/staff-control'] = { can_view: true, can_edit: true };
  }

  const response: UserProfileResponse = {
    id: profile.id,
    full_name: profile.full_name,
    system_role_id: profile.system_role_id,
    role_code: role.code,
    role_name: role.name,
    position_type: role.code,
    is_admin: role.is_admin,
    employee_variant: role.employee_variant,
    employee_id: profile.employee_id,
    department_id: departmentId,
    managed_department_ids,
    supervisor_id: profile.supervisor_id,
    chat_inbound_mode: profile.chat_inbound_mode || 'open',
    imported_position: profile.imported_position,
    page_access,
    is_approved: profile.is_approved,
    two_factor_enabled: profile.two_factor_enabled,
  };

  return { role, response, departmentId };
}

async function register(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, full_name } = registerSchema.parse(req.body);

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
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

    const defaultRole = await getRoleByCode(DEFAULT_ROLE_CODE_FOR_NEW_USERS);
    if (!defaultRole) {
      await supabase.auth.admin.deleteUser(authData.user.id);
      res.status(500).json({ success: false, error: `Default role "${DEFAULT_ROLE_CODE_FOR_NEW_USERS}" not found` });
      return;
    }

    const { error: profileError } = await supabase.from('user_profiles').insert({
      id: authData.user.id,
      full_name,
      system_role_id: defaultRole.id,
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

async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const { data: authData, error: authError } = await supabaseAuth.auth.signInWithPassword({
      email,
      password,
    });

    if (authError || !authData.user) {
      // User enumeration защита: единый ответ для всех ветвей (несуществующий
      // email / неверный пароль / email не подтверждён). Конкретная причина —
      // только в audit-логе и Sentry, не в response.
      console.error('Login error for', email, ':', authError?.message);
      await auditService.logFromRequest(req, null, 'LOGIN_FAILED', {
        details: { email, reason: authError?.message },
      });

      res.status(401).json({ success: false, error: 'Неверный email или пароль' });
      return;
    }

    const { data: profileRow, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', authData.user.id)
      .single();

    if (profileError || !profileRow) {
      res.status(404).json({ success: false, error: 'User profile not found' });
      return;
    }

    const profile = profileRow as UserProfile;
    const { role, response, departmentId } = await buildProfileResponse(profile);

    if (!profile.is_approved) {
      res.status(403).json({
        success: false,
        error: 'Account pending approval',
        code: 'PENDING_APPROVAL',
      });
      return;
    }

    if (LOGIN_2FA_ENABLED && profile.two_factor_enabled) {
      const tempToken = generateAccessToken(profile, role, email, false, departmentId);
      setSessionCookies(res, tempToken, null);

      res.json({
        success: true,
        requires_2fa: true,
        access_token: tempToken,
        refresh_token: '',
        user: { id: profile.id, email },
        profile: response,
      });
      return;
    }

    const accessToken = generateAccessToken(profile, role, email, true, departmentId);
    const refreshToken = generateRefreshToken(profile.id, email);
    setSessionCookies(res, accessToken, refreshToken);

    await auditService.logFromRequest(req, profile.id, 'LOGIN');

    res.json({
      success: true,
      access_token: accessToken,
      refresh_token: refreshToken,
      user: { id: profile.id, email },
      profile: response,
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
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({
        reset_token: resetTokenHash,
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

    res.json({
      success: true,
      message: 'Если аккаунт с таким email существует, инструкции по сбросу пароля будут отправлены.',
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

async function resetPassword(req: Request, res: Response): Promise<void> {
  try {
    const { token, password } = resetPasswordSchema.parse(req.body);
    const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, reset_token, reset_token_expires')
      .eq('reset_token', resetTokenHash)
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

async function getMe(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { data: profileRow, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error || !profileRow) {
      res.status(404).json({ success: false, error: 'Profile not found' });
      return;
    }

    const profile = profileRow as UserProfile;
    const { role, response, departmentId } = await buildProfileResponse(profile);

    const freshToken = generateAccessToken(
      profile,
      role,
      req.user.email,
      req.user.two_factor_verified,
      departmentId,
    );
    setSessionCookies(res, freshToken);

    res.json({
      success: true,
      access_token: freshToken,
      user: { id: profile.id, email: req.user.email },
      profile: { ...response, created_at: profile.created_at },
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ success: false, error: 'Failed to get user' });
  }
}

async function refresh(req: Request, res: Response): Promise<void> {
  try {
    const refreshToken = getRefreshTokenFromRequest(req);
    if (!refreshToken) {
      clearSessionCookies(res);
      res.status(401).json({ success: false, error: 'Refresh token required' });
      return;
    }

    const decoded = verifyRefreshToken(refreshToken);
    if (decoded.token_type !== 'refresh') {
      clearSessionCookies(res);
      res.status(401).json({ success: false, error: 'Invalid refresh token' });
      return;
    }

    const { data: profileRow, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', decoded.sub)
      .single();

    if (error || !profileRow || !profileRow.is_approved) {
      clearSessionCookies(res);
      res.status(401).json({ success: false, error: 'Session is no longer valid' });
      return;
    }

    const profile = profileRow as UserProfile;
    const { role, response, departmentId } = await buildProfileResponse(profile);

    const accessToken = generateAccessToken(profile, role, decoded.email, true, departmentId);
    const nextRefreshToken = generateRefreshToken(profile.id, decoded.email);

    setSessionCookies(res, accessToken, nextRefreshToken);

    res.json({
      success: true,
      access_token: accessToken,
      refresh_token: nextRefreshToken,
      user: { id: profile.id, email: decoded.email },
      profile: { ...response, created_at: profile.created_at },
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      clearSessionCookies(res);
      res.status(401).json({ success: false, error: 'Refresh token expired' });
      return;
    }
    console.error('Refresh error:', error);
    res.status(500).json({ success: false, error: 'Failed to refresh session' });
  }
}

async function logout(_req: Request, res: Response): Promise<void> {
  clearSessionCookies(res);
  res.json({ success: true });
}

export const authController = {
  register,
  login,
  forgotPassword,
  resetPassword,
  getMe,
  refresh,
  logout,
  verify2FA,
  useRecoveryCode,
};
