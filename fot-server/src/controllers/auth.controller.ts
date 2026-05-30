import crypto from 'crypto';
import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { execute, query, queryOne } from '../config/postgres.js';
import { localAuthService, LocalAuthError } from '../services/local-auth.service.js';
import { auditService } from '../services/audit.service.js';
import { mailerService } from '../services/mailer.service.js';
import { notificationService } from '../services/notification.service.js';
import { pushService } from '../services/push.service.js';
import type { AuthenticatedRequest, SystemRole, UserProfile, UserProfileResponse } from '../types/index.js';
import { LOGIN_2FA_ENABLED } from '../config/features.js';
import { getRolePageAccess } from '../services/access-control.service.js';
import { getRoleByCode, getRoleById } from '../services/roles-cache.service.js';
import { listManagedDepartmentIdsForUser } from '../services/department-access.service.js';
import { listDirectSubordinates } from '../services/employee-direct-reports.service.js';
import { TIMEKEEPER_ROLE_CODE, listTimekeeperAccessibleDepartmentIds, listTimekeeperDirectEmployeeIds } from '../services/timekeeper-scope.service.js';
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
  const data = await queryOne<{ org_department_id: string | null }>(
    'SELECT org_department_id FROM employees WHERE id = $1',
    [employeeId],
  );
  return data?.org_department_id || null;
}

async function loadCompanyScopeForProfile(
  profile: UserProfile,
  isAdmin: boolean,
): Promise<{ roots: 'all' | string[] }> {
  if (!isAdmin) return { roots: [] };
  try {
    const rows = await query<{ company_root_id: string }>(
      'SELECT company_root_id FROM user_company_access WHERE user_id = $1::uuid',
      [profile.id],
    );
    const roots = rows.map(row => row.company_root_id);
    return { roots: roots.length === 0 ? 'all' : roots };
  } catch (error) {
    console.error('[loadCompanyScopeForProfile] error:', error);
    return { roots: 'all' };
  }
}

async function buildProfileResponse(
  profile: UserProfile,
): Promise<{ role: SystemRole; response: UserProfileResponse; departmentId: string | null }> {
  const role = await getRoleById(profile.system_role_id);
  if (!role) {
    throw new Error(`Role not found for user ${profile.id}: ${profile.system_role_id}`);
  }

  const [page_access, departmentId, company_scope] = await Promise.all([
    getRolePageAccess(role.code),
    resolveDepartmentId(profile.employee_id),
    loadCompanyScopeForProfile(profile, role.is_admin),
  ]);

  // Табельщица: «управляемые отделы» = поддерево отделов/бригад, назначенных её
  // объектам входа (семена + потомки) — чтобы селектор на /timesheet показывал все
  // дочерние бригады, даже если объект назначен на родительский отдел.
  // НЕ выдаём ей /staff-control.
  const managed_department_ids = role.code === TIMEKEEPER_ROLE_CODE
    ? await listTimekeeperAccessibleDepartmentIds(profile.id)
    : await listManagedDepartmentIdsForUser(profile.id, null, profile.employee_id);

  // Табельщица: «прямые подчинённые» = сотрудники, назначенные её объектам ЯВНО
  // (employee_object_assignment). Нужно фронту для рендера direct-reports ячейки,
  // когда у табельщицы нет отделов, только персональные назначения.
  const has_direct_reports = role.code === TIMEKEEPER_ROLE_CODE
    ? (await listTimekeeperDirectEmployeeIds(profile.id)).length > 0
    : (profile.employee_id != null && (await listDirectSubordinates(profile.employee_id)).length > 0);

  if (!role.is_admin && role.code !== TIMEKEEPER_ROLE_CODE && managed_department_ids.length > 0 && !page_access['/staff-control']?.can_view) {
    page_access['/staff-control'] = { can_view: true, can_edit: true };
  }

  // Руководитель без managed-отделов, но с прямыми подчинёнными (employee_direct_reports)
  // ведёт их табель — даём доступ к странице, если роль его не выдала (бэк всё равно
  // ограничивает выборку/редактирование только его подчинёнными + им самим).
  if (!role.is_admin && managed_department_ids.length === 0 && has_direct_reports && !page_access['/timesheet']?.can_view) {
    page_access['/timesheet'] = { can_view: true, can_edit: true };
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
    show_actual_hours: !!role.show_actual_hours,
    hide_sidebar: !!role.hide_sidebar,
    timesheet_months_back: Number.isFinite(role.timesheet_months_back) ? role.timesheet_months_back : 1,
    timesheet_months_forward: Number.isFinite(role.timesheet_months_forward) ? role.timesheet_months_forward : 1,
    timesheet_show_full_period: role.timesheet_show_full_period !== false,
    weekend_memo_required: !!role.weekend_memo_required,
    employee_id: profile.employee_id,
    department_id: departmentId,
    managed_department_ids,
    has_direct_reports,
    supervisor_id: profile.supervisor_id,
    chat_inbound_mode: profile.chat_inbound_mode || 'open',
    imported_position: profile.imported_position,
    page_access,
    is_approved: profile.is_approved,
    two_factor_enabled: profile.two_factor_enabled,
    company_scope,
  };

  return { role, response, departmentId };
}

async function register(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, full_name } = registerSchema.parse(req.body);

    let authUser;
    try {
      authUser = await localAuthService.createUser({
        email,
        password,
        emailConfirm: false,
      });
    } catch (authError) {
      if (authError instanceof LocalAuthError && authError.code === 'DUPLICATE_EMAIL') {
        res.status(400).json({ success: false, error: 'Пользователь с таким email уже существует' });
        return;
      }
      console.error('Auth creation error:', authError);
      const msg = authError instanceof Error ? authError.message : 'Registration failed';
      res.status(400).json({ success: false, error: msg });
      return;
    }

    const defaultRole = await getRoleByCode(DEFAULT_ROLE_CODE_FOR_NEW_USERS);
    if (!defaultRole) {
      try { await localAuthService.deleteUser(authUser.id); } catch { /* ignore */ }
      res.status(500).json({ success: false, error: `Default role "${DEFAULT_ROLE_CODE_FOR_NEW_USERS}" not found` });
      return;
    }

    try {
      await execute(
        `INSERT INTO user_profiles (id, full_name, system_role_id, is_approved, two_factor_enabled)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5)`,
        [authUser.id, full_name, defaultRole.id, false, false],
      );
    } catch (profileError) {
      console.error('Profile creation failed:', profileError);
      try { await localAuthService.deleteUser(authUser.id); } catch { /* ignore */ }
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

    let authUser;
    try {
      authUser = await localAuthService.verifyPassword(email, password);
    } catch (verifyError) {
      console.error('Login verifyPassword error for', email, ':', verifyError);
      authUser = null;
    }

    if (!authUser) {
      // User enumeration защита: единый ответ для всех ветвей (несуществующий
      // email / неверный пароль / email не подтверждён). Конкретная причина —
      // только в audit-логе и Sentry, не в response.
      await auditService.logFromRequest(req, null, 'LOGIN_FAILED', {
        details: { email, reason: 'invalid_credentials' },
      });

      res.status(401).json({ success: false, error: 'Неверный email или пароль' });
      return;
    }

    const profileRow = await queryOne<UserProfile>(
      'SELECT * FROM user_profiles WHERE id = $1::uuid',
      [authUser.id],
    );

    if (!profileRow) {
      res.status(404).json({ success: false, error: 'User profile not found' });
      return;
    }

    const profile = profileRow;
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

    // Ищем пользователя по email напрямую в app_auth.users (case-insensitive),
    // вместо пагинированного listUsers — это и быстрее, и не зависит от размера базы.
    const normalizedEmail = email.trim().toLowerCase();
    const userRow = await queryOne<{ id: string }>(
      'SELECT id FROM app_auth.users WHERE lower(email) = $1 LIMIT 1',
      [normalizedEmail],
    );

    if (!userRow) {
      res.json({
        success: true,
        message: 'Если аккаунт с таким email существует, инструкции по сбросу пароля будут отправлены.',
      });
      return;
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    try {
      await execute(
        `UPDATE user_profiles
            SET reset_token = $1, reset_token_expires = $2
          WHERE id = $3::uuid`,
        [resetTokenHash, resetTokenExpires, userRow.id],
      );
    } catch (updateError) {
      console.error('Update reset token error:', updateError);
      res.status(500).json({ success: false, error: 'Не удалось создать запрос на сброс пароля' });
      return;
    }

    const appUrlBase = (process.env.APP_URL || 'https://fot.su10.ru').replace(/\/+$/, '');
    const resetUrl = `${appUrlBase}/reset-password?token=${resetToken}`;

    try {
      const targetProfile = await queryOne<{ full_name: string | null }>(
        'SELECT full_name FROM user_profiles WHERE id = $1::uuid',
        [userRow.id],
      );
      const fullName = targetProfile?.full_name?.trim() || normalizedEmail;

      const adminRows = await query<{ id: string }>(
        `SELECT up.id
           FROM user_profiles up
           JOIN system_roles sr ON sr.id = up.system_role_id
          WHERE sr.is_admin = true
            AND up.id <> $1::uuid
            AND NOT EXISTS (SELECT 1 FROM user_company_access uca WHERE uca.user_id = up.id)`,
        [userRow.id],
      );
      const adminIds = adminRows.map(r => r.id);

      if (adminIds.length > 0) {
        const title = 'Запрос на сброс пароля';
        const body = `${fullName} (${normalizedEmail}) запросил сброс пароля. Откройте карточку пользователя и нажмите «Сбросить пароль (ссылка)».`;
        const path = `/admin/users?openUser=${userRow.id}`;

        await notificationService.createMany(adminIds.map(uid => ({
          userId: uid,
          type: 'password_reset_requested',
          title,
          body,
          metadata: { path, targetUserId: userRow.id, targetEmail: normalizedEmail },
        })));

        await pushService.sendGenericNotification(adminIds, title, body, { path });
      }
    } catch (notifyError) {
      console.error('Forgot password admin notification failed:', notifyError);
    }

    if (mailerService.isConfigured()) {
      try {
        await mailerService.sendPasswordResetEmail({ to: normalizedEmail, resetUrl });
      } catch (mailError) {
        // Не палим клиенту, что аккаунт существует, поэтому не отдаём 500 — токен
        // уже создан в БД, пользователь увидит generic-success.
        console.error('Password reset email send failed:', mailError);
      }
    } else if (process.env.NODE_ENV !== 'production') {
      console.log(`[Password Reset] ${normalizedEmail}: ${resetUrl}`);
    } else {
      console.warn('[Password Reset] SMTP не настроен — письмо не отправлено для', normalizedEmail);
    }

    await auditService.logFromRequest(req, userRow.id, 'PASSWORD_RESET_REQUESTED', {
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

    const profile = await queryOne<{ id: string; reset_token: string | null; reset_token_expires: string | null }>(
      `SELECT id, reset_token, reset_token_expires
         FROM user_profiles
        WHERE reset_token = $1`,
      [resetTokenHash],
    );

    if (!profile) {
      res.status(400).json({ success: false, error: 'Недействительная или просроченная ссылка для сброса пароля' });
      return;
    }

    if (!profile.reset_token_expires || new Date(profile.reset_token_expires) < new Date()) {
      try {
        await execute(
          `UPDATE user_profiles
              SET reset_token = NULL, reset_token_expires = NULL
            WHERE id = $1::uuid`,
          [profile.id],
        );
      } catch {
        // ignore
      }

      res.status(400).json({ success: false, error: 'Ссылка для сброса пароля истекла. Запросите новую.' });
      return;
    }

    try {
      await localAuthService.updateUserById(profile.id, { password });
    } catch (updateError) {
      console.error('Password update error:', updateError);
      res.status(500).json({ success: false, error: 'Не удалось обновить пароль' });
      return;
    }

    try {
      await execute(
        `UPDATE user_profiles
            SET reset_token = NULL, reset_token_expires = NULL
          WHERE id = $1::uuid`,
        [profile.id],
      );
    } catch {
      // ignore
    }

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
    const profileRow = await queryOne<UserProfile>(
      'SELECT * FROM user_profiles WHERE id = $1::uuid',
      [req.user.id],
    );

    if (!profileRow) {
      res.status(404).json({ success: false, error: 'Profile not found' });
      return;
    }

    const profile = profileRow;
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

    const profileRow = await queryOne<UserProfile>(
      'SELECT * FROM user_profiles WHERE id = $1::uuid',
      [decoded.sub],
    );

    if (!profileRow || !profileRow.is_approved) {
      clearSessionCookies(res);
      res.status(401).json({ success: false, error: 'Session is no longer valid' });
      return;
    }

    const profile = profileRow;
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
