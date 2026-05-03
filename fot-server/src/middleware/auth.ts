import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { CRITICAL_2FA_ENABLED } from '../config/features.js';
import type { AccessAction } from '../config/access-control.js';
import type { AuthenticatedRequest, JWTPayload } from '../types/index.js';
import { resolveEffectivePageAccess } from '../services/access-control.service.js';
import { getAccessTokenFromRequest } from '../utils/auth-session.js';

export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const token = getAccessTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ success: false, error: 'Authorization token required' });
      return;
    }

    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as JWTPayload;
    if (decoded.token_type === 'refresh') {
      res.status(401).json({ success: false, error: 'Invalid access token' });
      return;
    }

    if (!decoded.is_approved) {
      res.status(403).json({ success: false, error: 'Account not approved' });
      return;
    }

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      system_role_id: decoded.system_role_id,
      role_code: decoded.role_code,
      is_admin: !!decoded.is_admin,
      employee_variant: decoded.employee_variant ?? null,
      employee_id: decoded.employee_id ?? null,
      department_id: decoded.department_id ?? null,
      is_approved: decoded.is_approved,
      two_factor_enabled: decoded.two_factor_enabled,
      two_factor_verified: decoded.two_factor_verified,
    };

    // PII в Sentry-scope не пишем: только id для группировки. role_code в
    // контекст не идёт, т.к. он не нужен Sentry для группировки и может
    // косвенно идентифицировать пользователя.
    Sentry.getCurrentScope().setUser({ id: req.user.id });

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ success: false, error: 'Token expired' });
      return;
    }
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ success: false, error: 'Invalid token' });
      return;
    }
    console.error('Auth middleware error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
};

export const require2FA = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  if (req.user.two_factor_enabled && !req.user.two_factor_verified) {
    res.status(403).json({ success: false, error: '2FA verification required' });
    return;
  }

  next();
};

export const requireCritical2FA = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  if (!CRITICAL_2FA_ENABLED) {
    next();
    return;
  }
  require2FA(req, res, next);
};

export const requirePageAccess = (pagePath: string, action: AccessAction = 'view') => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    try {
      const hasAccess = await resolveEffectivePageAccess(req, pagePath, action);

      if (!hasAccess) {
        res.status(403).json({ success: false, error: 'Insufficient permissions' });
        return;
      }

      next();
    } catch (error) {
      console.error('requirePageAccess error:', error);
      res.status(500).json({ success: false, error: 'Authorization check failed' });
    }
  };
};

export const requireAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  if (!req.user.is_admin) {
    res.status(403).json({ success: false, error: 'Доступно только администраторам' });
    return;
  }
  next();
};

export const requireAnyPageAccess = (pagePaths: string[], action: AccessAction = 'view') => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    try {
      const checks = await Promise.all(
        pagePaths.map(pagePath => resolveEffectivePageAccess(req, pagePath, action)),
      );

      if (!checks.some(Boolean)) {
        res.status(403).json({ success: false, error: 'Insufficient permissions' });
        return;
      }

      next();
    } catch (error) {
      console.error('requireAnyPageAccess error:', error);
      res.status(500).json({ success: false, error: 'Authorization check failed' });
    }
  };
};
