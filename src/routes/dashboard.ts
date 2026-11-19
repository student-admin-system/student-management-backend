import { Router } from 'express';
import * as dashboardService from '../services/dashboardService';
import { authenticate } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';

const router = Router();

router.use(authenticate);

// GET /api/dashboard
router.get('/', async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user!.role === 'ADMIN') {
      const data = await dashboardService.getAdminDashboard();
      res.json(data);
    } else {
      const data = await dashboardService.getAssistantDashboard(authReq.user!.id);
      res.json(data);
    }
  } catch (error) {
    next(error);
  }
});

export default router;
