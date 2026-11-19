import { Router } from 'express';
import * as chargeService from '../services/chargeService';
import { authenticate, requireAdmin } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';
import { AppError } from '../middleware/errorHandler';
import { ChargeStatus, ChargeType } from '@prisma/client';

const router = Router();

router.use(authenticate);

// GET /api/charges
router.get('/', async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.role === 'ASSISTANT' && !req.query.studentId) {
      throw new AppError(403, 'FORBIDDEN', 'Assistants must specify studentId to view charges');
    }
    const charges = await chargeService.listCharges({
      studentId: req.query.studentId as string | undefined,
      billedMonth: req.query.billedMonth as string | undefined,
      status: req.query.status as ChargeStatus | undefined,
      type: req.query.type as ChargeType | undefined,
    });
    res.json(charges);
  } catch (error) {
    next(error);
  }
});

// GET /api/charges/:id
router.get('/:id', async (req, res, next) => {
  try {
    const charge = await chargeService.getChargeById(req.params.id as string);
    res.json(charge);
  } catch (error) {
    next(error);
  }
});

// POST /api/charges/:id/waive (Admin only)
router.post('/:id/waive', requireAdmin, async (req, res, next) => {
  try {
    const charge = await chargeService.waiveCharge(req.params.id as string);
    res.json(charge);
  } catch (error) {
    next(error);
  }
});

export default router;
