import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import prisma from '../prisma';
import { AuthenticatedRequest, AuthenticatedUser } from '../types';
import { AppError } from './errorHandler';

// ---------- Login Rate Limiter ----------
interface RateLimitEntry {
  count: number;
  firstAttempt: number;
}

const loginAttempts = new Map<string, RateLimitEntry>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export function clearLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

export function loginRateLimiter(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (process.env.NODE_ENV !== 'production' && (ip === '127.0.0.1' || ip === '::1' || ip.includes('127.0.0.1'))) {
    return next();
  }

  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (entry) {
    if (now - entry.firstAttempt > WINDOW_MS) {
      // Window expired, reset
      loginAttempts.set(ip, { count: 1, firstAttempt: now });
    } else if (entry.count >= MAX_ATTEMPTS) {
      return next(
        new AppError(
          429,
          'RATE_LIMIT_EXCEEDED',
          'Too many login attempts. Please try again later.'
        )
      );
    } else {
      entry.count++;
    }
  } else {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  }

  next();
}

// ---------- JWT Authentication ----------
export function authenticate(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError(401, 'UNAUTHORIZED', 'No token provided'));
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, config.jwt.secret) as {
      id?: string;
      userId?: string;
      username?: string;
      name?: string;
      role?: 'ADMIN' | 'ASSISTANT';
    };

    const targetId = payload.id || payload.userId;
    if (!targetId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Invalid token payload'));
    }

    // Look up user to ensure they still exist and are active
    prisma.user
      .findUnique({ where: { id: targetId } })
      .then((user) => {
        if (!user || !user.isActive) {
          return next(new AppError(401, 'UNAUTHORIZED', 'User not found or inactive'));
        }

        req.user = {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role as 'ADMIN' | 'ASSISTANT',
        };
        next();
      })
      .catch(next);
  } catch (err: any) {
    if (err instanceof AppError) {
      return next(err);
    }
    return next(new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token'));
  }
}

/** Require any authenticated user */
export function requireAuth() {
  return [authenticate];
}

/** Require an authenticated admin user */
export function requireAdmin(req?: any, res?: any, next?: any): any {
  if (req && next && typeof next === 'function') {
    if (req.user?.role !== 'ADMIN') {
      return next(new AppError(403, 'FORBIDDEN', 'Admin access required'));
    }
    return next();
  }
  return [
    authenticate,
    (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      if (req.user?.role !== 'ADMIN') {
        return next(new AppError(403, 'FORBIDDEN', 'Admin access required'));
      }
      next();
    },
  ];
}
