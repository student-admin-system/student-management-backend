import { Router } from 'express';
import { z } from 'zod';
import * as authService from '../services/authService';
import { authenticate, loginRateLimiter } from '../middleware/auth';
import { validateBody } from '../middleware/validateRequest';
import { AuthenticatedRequest } from '../types';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

// POST /login
router.post('/login', loginRateLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const result = await authService.login(username, password);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// GET /me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const profile = await authService.getProfile(authReq.user!.id);
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

// POST /change-password
router.post('/change-password', authenticate, validateBody(changePasswordSchema), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { currentPassword, newPassword } = req.body;
    await authService.changePassword(authReq.user!.id, currentPassword, newPassword);
    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;
