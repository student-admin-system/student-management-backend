import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { AppError } from './errorHandler';

/** Validate request body against a Zod schema */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      }));
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request body', details);
    }
    req.body = result.data;
    next();
  };
}

/** Validate request query against a Zod schema */
export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const details = result.error.issues.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      }));
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query parameters', details);
    }
    req.query = result.data as any;
    next();
  };
}
