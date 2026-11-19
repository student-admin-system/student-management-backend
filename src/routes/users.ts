import { Router } from 'express';
import { z } from 'zod';
import * as userService from '../services/userService';
import { authenticate, requireAdmin } from '../middleware/auth';
import { validateBody } from '../middleware/validateRequest';
import { AuthenticatedRequest } from '../types';

const router = Router();

// All routes require authenticate + requireAdmin
router.use(authenticate, requireAdmin);

const createUserSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().min(1, 'Name is required'),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
});

// GET /
router.get('/', async (req, res, next) => {
  try {
    const users = await userService.listUsers();
    res.json(users);
  } catch (error) {
    next(error);
  }
});

// POST /
router.post('/', validateBody(createUserSchema), async (req, res, next) => {
  try {
    const user = await userService.createUser(req.body);
    res.status(201).json(user);
  } catch (error) {
    next(error);
  }
});

// PATCH /:id
router.patch('/:id', validateBody(updateUserSchema), async (req, res, next) => {
  try {
    const user = await userService.updateUser(req.params.id as string, req.body);
    res.json(user);
  } catch (error) {
    next(error);
  }
});

// POST /:id/reset-password
router.post('/:id/reset-password', validateBody(resetPasswordSchema), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    await userService.resetPassword(req.params.id as string, req.body.newPassword, authReq.user!.id);
    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;
