import { Router } from 'express';
import { z } from 'zod';
import * as studentService from '../services/studentService';
import { authenticate, requireAdmin } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validateRequest';
import { AuthenticatedRequest } from '../types';
import { StudentStatus } from '@prisma/client';

const router = Router();

router.use(authenticate);

const registerStudentSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  enrollmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  levelId: z.string().uuid('Invalid level ID'),
  studentPhone: z.string().optional(),
  guardianName: z.string().optional(),
  guardianPhone: z.string().optional(),
  school: z.string().optional(),
  notes: z.string().optional(),
});

const updateStudentSchema = z.object({
  fullName: z.string().min(1).optional(),
  enrollmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  studentPhone: z.string().nullable().optional(),
  guardianName: z.string().nullable().optional(),
  guardianPhone: z.string().nullable().optional(),
  school: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const changeStatusSchema = z.object({
  status: z.nativeEnum(StudentStatus),
});

const changeCombinationSchema = z.object({
  levelId: z.string().uuid('Invalid level ID'),
});

// GET /api/students - Search / List
router.get('/', async (req, res, next) => {
  try {
    const pageSizeParam = (req.query.pageSize || req.query.limit) as string | undefined;
    const result = await studentService.searchStudents({
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
      pageSize: pageSizeParam ? parseInt(pageSizeParam, 10) : 20,
      q: req.query.q as string | undefined,
      forAttendance: req.query.forAttendance === 'true',
      subjectId: req.query.subjectId as string | undefined,
      levelId: req.query.levelId as string | undefined,
      status: req.query.status as any,
      hasDebt:
        req.query.hasDebt === 'true'
          ? true
          : req.query.hasDebt === 'false'
          ? false
          : undefined,
      month: req.query.month as string | undefined,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/students - Register student (Admin + Assistant)
router.post('/', validateBody(registerStudentSchema), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await studentService.registerStudent(req.body, authReq.user!.id);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// GET /api/students/:id - Student Profile
router.get('/:id', async (req, res, next) => {
  try {
    const profile = await studentService.getStudentProfile(req.params.id as string);
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/students/:id - Update info (Admin only)
router.patch('/:id', requireAdmin, validateBody(updateStudentSchema), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const updated = await studentService.updateStudent(req.params.id as string, req.body, authReq.user!.id);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/students/:id/status - Change status (Admin only)
router.patch('/:id/status', requireAdmin, validateBody(changeStatusSchema), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const updated = await studentService.changeStudentStatus(req.params.id as string, req.body.status, authReq.user!.id);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/students/:id/combination - Change combination (Admin only)
router.patch('/:id/combination', requireAdmin, validateBody(changeCombinationSchema), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await studentService.changeStudentCombination(req.params.id as string, req.body.levelId, authReq.user!.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/students/:id - Permanent Delete (Admin only)
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await studentService.deleteStudent(req.params.id as string);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
