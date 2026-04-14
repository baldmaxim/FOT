import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { CRITICAL_2FA_ENABLED } from '../config/features.js';
import type { AccessAction } from '../config/access-control.js';
import type { AuthenticatedRequest, JWTPayload, EmployeePositionType } from '../types/index.js';
import {
  hasAnyPermission,
  hasPageEdit,
  hasPageView,
  hasPermission,
} from '../services/access-control.service.js';
import { getHierarchyLevel } from '../services/roles-cache.service.js';
import { getAccessTokenFromRequest } from '../utils/auth-session.js';

/**
 * Middleware для проверки JWT токена
 */
export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = getAccessTokenFromRequest(req);

    if (!token) {
      res.status(401).json({ success: false, error: 'Authorization token required' });
      return;
    }

    // Верифицируем JWT
    const decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;
    if (decoded.token_type === 'refresh') {
      res.status(401).json({ success: false, error: 'Invalid access token' });
      return;
    }

    // Проверяем что пользователь одобрен
    if (!decoded.is_approved) {
      res.status(403).json({ success: false, error: 'Account not approved' });
      return;
    }

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      position_type: decoded.position_type,
      system_role_id: decoded.system_role_id ?? null,
      employee_id: decoded.employee_id ?? null,
      department_id: decoded.department_id ?? null,
      is_approved: decoded.is_approved,
      two_factor_enabled: decoded.two_factor_enabled,
      two_factor_verified: decoded.two_factor_verified,
    };

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

/**
 * Middleware для проверки 2FA
 * Используется для критичных операций
 */
export const require2FA = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  // Если 2FA включена, но не верифицирована в текущей сессии
  if (req.user.two_factor_enabled && !req.user.two_factor_verified) {
    res.status(403).json({ success: false, error: '2FA verification required' });
    return;
  }

  next();
};

/**
 * Middleware-обёртка: если CRITICAL_2FA_ENABLED=false — пропускает,
 * иначе ведёт себя как require2FA.
 */
export const requireCritical2FA = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!CRITICAL_2FA_ENABLED) {
    next();
    return;
  }
  require2FA(req, res, next);
};

/**
 * Middleware для проверки должности пользователя
 */
export const requirePosition = (...allowedPositions: EmployeePositionType[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    if (!allowedPositions.includes(req.user.position_type)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }

    next();
  };
};

export const requirePermission = (permission: string) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    try {
      const roleRef = req.user.system_role_id ?? req.user.position_type;
      if (!(await hasPermission(roleRef, permission))) {
        res.status(403).json({ success: false, error: 'Insufficient permissions' });
        return;
      }

      next();
    } catch (error) {
      console.error('requirePermission error:', error);
      res.status(500).json({ success: false, error: 'Authorization check failed' });
    }
  };
};

export const requireAnyPermission = (permissions: string[]) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    try {
      const roleRef = req.user.system_role_id ?? req.user.position_type;
      if (!(await hasAnyPermission(roleRef, permissions))) {
        res.status(403).json({ success: false, error: 'Insufficient permissions' });
        return;
      }

      next();
    } catch (error) {
      console.error('requireAnyPermission error:', error);
      res.status(500).json({ success: false, error: 'Authorization check failed' });
    }
  };
};

export const requirePageAccess = (pagePath: string, action: AccessAction = 'view') => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    try {
      const roleRef = req.user.system_role_id ?? req.user.position_type;
      const hasAccess = action === 'edit'
        ? await hasPageEdit(roleRef, pagePath)
        : await hasPageView(roleRef, pagePath);

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

export const requireSuperAdminOrPageAccess = (pagePath: string, action: AccessAction = 'view') => {
  const pageAccessMiddleware = requirePageAccess(pagePath, action);

  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    if (req.user.position_type === 'super_admin') {
      next();
      return;
    }

    await pageAccessMiddleware(req, res, next);
  };
};

export const requireAnyPageAccess = (pagePaths: string[], action: AccessAction = 'view') => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    try {
      const roleRef = req.user.system_role_id ?? req.user.position_type;
      const checks = await Promise.all(
        pagePaths.map(pagePath => (
          action === 'edit'
            ? hasPageEdit(roleRef, pagePath)
            : hasPageView(roleRef, pagePath)
        )),
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


/**
 * Middleware для проверки должности пользователя по иерархии (динамически из system_roles)
 */
export const requireMinPosition = (minPosition: EmployeePositionType) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    try {
      const [userLevel, requiredLevel] = await Promise.all([
        getHierarchyLevel(req.user.position_type),
        getHierarchyLevel(minPosition),
      ]);

      if (userLevel < requiredLevel) {
        res.status(403).json({ success: false, error: 'Insufficient permissions' });
        return;
      }

      next();
    } catch (error) {
      console.error('requireMinPosition error:', error);
      res.status(500).json({ success: false, error: 'Authorization check failed' });
    }
  };
};

/**
 * Middleware для проверки что пользователь - super_admin
 */
export const requireSuperAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  if (req.user.position_type !== 'super_admin') {
    res.status(403).json({ success: false, error: 'Super admin access required' });
    return;
  }

  next();
};

