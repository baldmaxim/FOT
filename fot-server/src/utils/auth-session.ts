import type { Request, Response, CookieOptions } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { JWTPayload, SystemRole, UserProfile } from '../types/index.js';

export const ACCESS_TOKEN_COOKIE_NAME = 'fot_access_token';
export const REFRESH_TOKEN_COOKIE_NAME = 'fot_refresh_token';

interface RefreshTokenPayload {
  sub: string;
  email: string;
  token_type: 'refresh';
  iat: number;
  exp: number;
}

const parseDurationToMs = (value: string): number | undefined => {
  const match = value.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return undefined;

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  return amount * multipliers[unit];
};

const buildCookieOptions = (maxAge: number | undefined): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
  path: '/',
  ...(maxAge ? { maxAge } : {}),
});

export function parseCookieHeader(cookieHeader?: string | null): Record<string, string> {
  if (!cookieHeader) return {};

  return cookieHeader
    .split(';')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, chunk) => {
      const separatorIndex = chunk.indexOf('=');
      if (separatorIndex === -1) return acc;

      const key = decodeURIComponent(chunk.slice(0, separatorIndex).trim());
      const value = decodeURIComponent(chunk.slice(separatorIndex + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

export function generateAccessToken(
  profile: Pick<UserProfile, 'id' | 'system_role_id' | 'employee_id' | 'is_approved' | 'two_factor_enabled'>,
  role: Pick<SystemRole, 'code' | 'is_admin' | 'employee_variant' | 'show_actual_hours' | 'timesheet_months_back' | 'timesheet_months_forward'>,
  email: string,
  twoFactorVerified: boolean,
  departmentId: string | null = null,
): string {
  const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
    sub: profile.id,
    email,
    token_type: 'access',
    system_role_id: profile.system_role_id,
    role_code: role.code,
    is_admin: !!role.is_admin,
    employee_variant: role.employee_variant ?? null,
    show_actual_hours: !!role.show_actual_hours,
    timesheet_months_back: Number.isFinite(role.timesheet_months_back) ? role.timesheet_months_back : 1,
    timesheet_months_forward: Number.isFinite(role.timesheet_months_forward) ? role.timesheet_months_forward : 1,
    employee_id: profile.employee_id,
    department_id: departmentId,
    is_approved: profile.is_approved,
    two_factor_enabled: profile.two_factor_enabled,
    two_factor_verified: twoFactorVerified,
  };

  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function generateRefreshToken(userId: string, email: string): string {
  const refreshSecret = env.JWT_REFRESH_SECRET || env.JWT_SECRET;
  return jwt.sign(
    {
      sub: userId,
      email,
      token_type: 'refresh',
    },
    refreshSecret,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN } as jwt.SignOptions,
  );
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const refreshSecret = env.JWT_REFRESH_SECRET || env.JWT_SECRET;
  return jwt.verify(token, refreshSecret, { algorithms: ['HS256'] }) as unknown as RefreshTokenPayload;
}

export function setSessionCookies(
  res: Response,
  accessToken: string,
  refreshToken?: string | null,
): void {
  res.cookie(
    ACCESS_TOKEN_COOKIE_NAME,
    accessToken,
    buildCookieOptions(parseDurationToMs(env.JWT_EXPIRES_IN)),
  );

  if (refreshToken) {
    res.cookie(
      REFRESH_TOKEN_COOKIE_NAME,
      refreshToken,
      buildCookieOptions(parseDurationToMs(env.JWT_REFRESH_EXPIRES_IN)),
    );
  } else {
    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, buildCookieOptions(undefined));
  }
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, buildCookieOptions(undefined));
  res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, buildCookieOptions(undefined));
}

export function getAccessTokenFromRequest(req: Pick<Request, 'headers'>): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[ACCESS_TOKEN_COOKIE_NAME] || null;
}

export function getRefreshTokenFromRequest(req: Pick<Request, 'headers'>): string | null {
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[REFRESH_TOKEN_COOKIE_NAME] || null;
}
