import { Router } from 'express';
import { z } from 'zod';
import * as subjectService from '../services/subjectService';
import { authenticate, requireAdmin } from '../middleware/auth';
import { validateBody } from '../middleware/validateRequest';

const router = Router();

router.use(authenticate);

const createSubjectSchema = z.object({
  name: z.string().min(1, 'Subject name is required'),
});

const updateSubjectSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

const createLevelSchema = z.object({
  subjectId: z.string().uuid('Invalid subject ID'),
  name: z.string().min(1, 'Level name is required'),
});

const updateLevelSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Subjects CRUD
// ---------------------------------------------------------------------------

router.get('/', async (_req, res, next) => {
  try {
    const subjects = await subjectService.listSubjects();
    res.json(subjects);
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAdmin, validateBody(createSubjectSchema), async (req, res, next) => {
  try {
    const subject = await subjectService.createSubject(req.body);
    res.status(201).json(subject);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Levels routes (placed before /:id to avoid ID conflict)
// ---------------------------------------------------------------------------

router.get('/levels', async (req, res, next) => {
  try {
    const subjectId = req.query.subjectId as string | undefined;
    const levels = await subjectService.listLevels(subjectId);
    res.json(levels);
  } catch (error) {
    next(error);
  }
});

router.post('/levels', requireAdmin, validateBody(createLevelSchema), async (req, res, next) => {
  try {
    const level = await subjectService.createLevel(req.body);
    res.status(201).json(level);
  } catch (error) {
    next(error);
  }
});

router.get('/levels/:id', async (req, res, next) => {
  try {
    const level = await subjectService.getLevel(req.params.id as string);
    res.json(level);
  } catch (error) {
    next(error);
  }
});

router.patch('/levels/:id', requireAdmin, validateBody(updateLevelSchema), async (req, res, next) => {
  try {
    const level = await subjectService.updateLevel(req.params.id as string, req.body);
    res.json(level);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Subject by ID
// ---------------------------------------------------------------------------

router.get('/:id', async (req, res, next) => {
  try {
    const subject = await subjectService.getSubject(req.params.id as string);
    res.json(subject);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', requireAdmin, validateBody(updateSubjectSchema), async (req, res, next) => {
  try {
    const subject = await subjectService.updateSubject(req.params.id as string, req.body);
    res.json(subject);
  } catch (error) {
    next(error);
  }
});

// Nested levels support: POST /:subjectId/levels
router.post('/:subjectId/levels', requireAdmin, async (req, res, next) => {
  try {
    const body = { ...req.body, subjectId: req.params.subjectId as string };
    const parsed = createLevelSchema.parse(body);
    const level = await subjectService.createLevel(parsed);
    res.status(201).json(level);
  } catch (error) {
    next(error);
  }
});

export default router;
