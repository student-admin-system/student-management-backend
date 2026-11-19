import { Router } from 'express';
import { z } from 'zod';
import * as billingService from '../services/billingService';
import { authenticate, requireAdmin } from '../middleware/auth';
import { validateBody } from '../middleware/validateRequest';
import { AppError } from '../middleware/errorHandler';
import { BillingMethod } from '@prisma/client';
import { getCurrentMonth } from '../utils/date';

const router = Router();

router.use(authenticate);

const confirmBillingSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM'),
  confirmations: z.array(
    z.object({
      studentId: z.string().uuid('Invalid student ID'),
      method: z.nativeEnum(BillingMethod),
    })
  ).min(1, 'At least one student confirmation is required'),
});

const reopenBillingSchema = z.object({
  studentId: z.string().uuid('Invalid student ID'),
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM'),
});

// GET /api/billing/selection & /api/billing/candidates
const selectionHandler = async (req: any, res: any, next: any) => {
  try {
    const month = (req.query.month as string) || getCurrentMonth();
    const list = await billingService.getBillingSelectionList(month);
    res.json(list);
  } catch (error) {
    next(error);
  }
};

router.get('/selection', requireAdmin, selectionHandler);
router.get('/candidates', requireAdmin, selectionHandler);

// GET /api/billing/unconfirmed?month=...
router.get('/unconfirmed', requireAdmin, async (req, res, next) => {
  try {
    const month = (req.query.month as string) || getCurrentMonth();
    const list = await billingService.getUnconfirmedBillingList(month);
    res.json(list);
  } catch (error) {
    next(error);
  }
});

// POST /api/billing/confirm (Admin only)
router.post('/confirm', requireAdmin, validateBody(confirmBillingSchema), async (req, res, next) => {
  try {
    const result = await billingService.confirmMonthlyBilling(req.body.month, req.body.confirmations);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/billing/reopen (Admin only)
router.post('/reopen', requireAdmin, validateBody(reopenBillingSchema), async (req, res, next) => {
  try {
    const result = await billingService.reopenMonthlyBilling(req.body.studentId, req.body.month);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
