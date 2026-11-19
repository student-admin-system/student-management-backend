import { Router } from 'express';
import { z } from 'zod';
import * as feeService from '../services/feeService';
import { authenticate, requireAdmin } from '../middleware/auth';
import { validateBody } from '../middleware/validateRequest';
import { AppError } from '../middleware/errorHandler';

const router = Router();

router.use(authenticate);

const upsertFeeSchema = z.object({
  levelId: z.string().uuid('Invalid level ID'),
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM'),
  subscriptionFee: z.number().min(0, 'Subscription fee must be non-negative'),
  perLessonFee: z.number().min(0, 'Per-lesson fee must be non-negative'),
});

// GET /api/fees?levelId=...
router.get('/', async (req, res, next) => {
  try {
    const levelId = req.query.levelId as string;
    if (!levelId) {
      throw new AppError(400, 'LEVEL_REQUIRED', 'levelId query parameter is required');
    }
    const month = req.query.month as string | undefined;
    if (month) {
      const fee = await feeService.getFeeForMonth(levelId, month);
      return res.json(fee);
    }
    const fees = await feeService.listFees(levelId);
    res.json(fees);
  } catch (error) {
    next(error);
  }
});

// GET /api/fees/effective?levelId=...&month=...
router.get('/effective', async (req, res, next) => {
  try {
    const levelId = req.query.levelId as string;
    const month = req.query.month as string;
    if (!levelId || !month) {
      throw new AppError(400, 'MISSING_PARAMS', 'levelId and month query parameters are required');
    }
    const fee = await feeService.getEffectiveFee(levelId, month);
    res.json(fee);
  } catch (error) {
    next(error);
  }
});

// POST /api/fees - Upsert fee (Admin only)
router.post('/', requireAdmin, validateBody(upsertFeeSchema), async (req, res, next) => {
  try {
    const fee = await feeService.upsertFee(req.body);
    res.status(201).json(fee);
  } catch (error) {
    next(error);
  }
});

export default router;
