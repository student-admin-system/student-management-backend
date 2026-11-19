import { Router } from 'express';
import { z } from 'zod';
import * as attendanceService from '../services/attendanceService';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validateRequest';
import { AuthenticatedRequest } from '../types';
import { AppError } from '../middleware/errorHandler';

const router = Router();

router.use(authenticate);

const recordAttendanceSchema = z.object({
  studentId: z.string().uuid('Invalid student ID'),
  lessonDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  levelId: z.string().uuid('Invalid level ID'),
  billingAction: z.enum(['PAY_PER_LESSON', 'ATTEND_UNPAID', 'PAY_SUBSCRIPTION']).optional(),
  paidForLesson: z.boolean().optional(),
});

// GET /api/attendance/lesson?levelId=...&date=...
router.get('/lesson', async (req, res, next) => {
  try {
    const levelId = req.query.levelId as string;
    const date = req.query.date as string;
    if (!levelId || !date) {
      throw new AppError(400, 'MISSING_PARAMS', 'levelId and date query parameters are required');
    }
    const result = await attendanceService.getLessonAttendance(levelId, date);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// GET /api/attendance/student/:studentId — Student Attendance Report (FR-RPT-03 in v2.0)
router.get('/student/:studentId', async (req, res, next) => {
  try {
    const result = await attendanceService.getStudentAttendanceReport(req.params.studentId as string);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/attendance - Record attendance with streamlined billing/payment (Admin + Assistant)
router.post('/', validateBody(recordAttendanceSchema), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await attendanceService.recordAttendance({
      ...req.body,
      recordedById: authReq.user!.id,
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/attendance/:id/void - Void attendance (Admin or Assistant same Cairo day)
router.post('/:id/void', async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await attendanceService.voidAttendance(
      req.params.id as string,
      authReq.user!.id,
      authReq.user!.role
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
