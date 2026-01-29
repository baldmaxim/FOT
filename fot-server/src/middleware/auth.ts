import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { supabaseAuth } from '../config/database.js';
import type { AuthenticatedRequest, JWTPayload, EmployeePositionType } from '../types/index.js';

/**
 * Middleware для проверки JWT токена
 */
export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Authorization token required' });
      return;
    }

    const token = authHeader.substring(7);

    // Верифицируем JWT
    const decoded = jwt.verify(token, env.JWT_SECRET) as JWTPayload;

    // Проверяем что пользователь одобрен
    if (!decoded.is_approved) {
      res.status(403).json({ success: false, error: 'Account not approved' });
      return;
    }

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      organization_id: decoded.organization_id,
      position_type: decoded.position_type,
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

// Alias для обратной совместимости
export const requireRole = requirePosition;

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

/**
 * Middleware для проверки принадлежности к организации
 * Используется для операций с данными организации
 */
export const requireOrganization = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  // Super admin может работать без организации
  if (req.user.position_type === 'super_admin') {
    next();
    return;
  }

  if (!req.user.organization_id) {
    res.status(403).json({ success: false, error: 'Organization membership required' });
    return;
  }

  next();
};
