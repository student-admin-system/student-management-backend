import { Router } from 'express';
import { z } from 'zod';
import * as paymentService from '../services/paymentService';
import { authenticate, requireAdmin } from '../middleware/auth';
import { validateBody } from '../middleware/validateRequest';
import { AuthenticatedRequest } from '../types';
import { AppError } from '../middleware/errorHandler';

const router = Router();

router.use(authenticate);

const createPaymentGroupSchema = z.object({
  studentId: z.string().uuid('Invalid student ID'),
  chargeIds: z.array(z.string().uuid()).min(1, 'At least one charge must be selected'),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
});

const createSubscriptionPaymentSchema = z.object({
  studentId: z.string().uuid('Invalid student ID'),
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM'),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
});

// GET /api/payments
router.get('/', async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role === 'ASSISTANT' && !req.query.studentId) {
      throw new AppError(403, 'FORBIDDEN', 'Assistants must specify studentId to view payments');
    }
    const studentId = req.query.studentId as string | undefined;
    const paymentGroups = await paymentService.listPaymentGroups(studentId);
    res.json(paymentGroups);
  } catch (error) {
    next(error);
  }
});

// GET /api/payments/:id
router.get('/:id', async (req, res, next) => {
  try {
    const paymentGroup = await paymentService.getPaymentGroupById(req.params.id as string);
    res.json(paymentGroup);
  } catch (error) {
    next(error);
  }
});

// POST /api/payments - Record payment settling unpaid charges (Admin + Assistant)
router.post('/', validateBody(createPaymentGroupSchema), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await paymentService.createPaymentGroup({
      ...req.body,
      recordedById: authReq.user!.id,
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/payments/subscription - Record standalone monthly subscription payment (BR-02.3, Admin + Assistant)
router.post('/subscription', validateBody(createSubscriptionPaymentSchema), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await paymentService.createSubscriptionPayment({
      ...req.body,
      recordedById: authReq.user!.id,
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/payments/:id/void & /api/payments/groups/:id/void - Void payment group (Admin only)
const voidHandler = async (req: any, res: any, next: any) => {
  try {
    const result = await paymentService.voidPaymentGroup(req.params.id as string);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

router.post('/:id/void', requireAdmin, voidHandler);
router.post('/groups/:id/void', requireAdmin, voidHandler);

export default router;
