import { Router } from 'express';
import * as reportService from '../services/reportService';
import { authenticate, requireAdmin } from '../middleware/auth';
import { AuthenticatedRequest } from '../types';
import { AppError } from '../middleware/errorHandler';
import { getCairoToday, getCurrentMonth } from '../utils/date';

const router = Router();

router.use(authenticate);

// GET /api/reports/statement/:studentId (Admin + Assistant)
router.get('/statement/:studentId', async (req, res, next) => {
  try {
    const statement = await reportService.getStudentStatement(req.params.studentId as string);
    res.json(statement);
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/debtors (Admin only - PERM-15, D1)
router.get('/debtors', requireAdmin, async (req, res, next) => {
  try {
    const list = await reportService.getDebtorsList({
      subjectId: req.query.subjectId as string | undefined,
      levelId: req.query.levelId as string | undefined,
    });
    res.json(list);
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/attendance/student/:studentId (Admin + Assistant - FR-RPT-03)
router.get('/attendance/student/:studentId', async (req, res, next) => {
  try {
    const report = await reportService.getStudentAttendanceReport(req.params.studentId as string);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/attendance?levelId=...&date=... (Admin + Assistant)
router.get('/attendance', async (req, res, next) => {
  try {
    if (req.query.studentId) {
      const report = await reportService.getStudentAttendanceReport(req.query.studentId as string);
      return res.json(report);
    }
    const levelId = req.query.levelId as string;
    const date = (req.query.date as string) || getCairoToday();
    if (!levelId) {
      throw new AppError(400, 'LEVEL_REQUIRED', 'levelId query parameter is required');
    }
    const report = await reportService.getAttendanceReport(levelId, date);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/financial?month=... (Admin only - PERM-15, D1)
router.get('/financial', requireAdmin, async (req, res, next) => {
  try {
    const month = (req.query.month as string) || getCurrentMonth();
    const summary = await reportService.getMonthlyFinancialSummary(month);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/collections?date=... (Admin + Assistant with user filtering)
router.get('/collections', async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const date = (req.query.date as string) || getCairoToday();
    const report = await reportService.getDailyCollections(
      date,
      authReq.user!.id,
      authReq.user!.role
    );
    res.json(report);
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/unconfirmed?month=... (Admin only - D1)
router.get('/unconfirmed', requireAdmin, async (req, res, next) => {
  try {
    const month = (req.query.month as string) || getCurrentMonth();
    const report = await reportService.getUnconfirmedReport(month);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

export default router;
