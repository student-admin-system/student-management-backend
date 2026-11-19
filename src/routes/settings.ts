import { Router } from 'express';
import { z } from 'zod';
import * as settingsService from '../services/settingsService';
import { authenticate, requireAdmin } from '../middleware/auth';
import { validateBody } from '../middleware/validateRequest';

const router = Router();

router.use(authenticate);

const updateSettingsSchema = z.object({
  businessName: z.string().min(1).optional(),
});

// GET /api/settings
router.get('/', async (_req, res, next) => {
  try {
    const settings = await settingsService.getSettings();
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/settings (Admin only - PERM-13)
router.patch('/', requireAdmin, validateBody(updateSettingsSchema), async (req, res, next) => {
  try {
    const updated = await settingsService.updateSettings(req.body);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

export default router;
