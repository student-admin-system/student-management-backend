import prisma from '../prisma';
import { AppError } from '../middleware/errorHandler';

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

export async function listSubjects() {
  return prisma.subject.findMany({
    include: {
      levels: {
        orderBy: { name: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  });
}

export async function getSubject(id: string) {
  const subject = await prisma.subject.findUnique({
    where: { id },
    include: {
      levels: {
        orderBy: { name: 'asc' },
      },
    },
  });
  if (!subject) throw new AppError(404, 'SUBJECT_NOT_FOUND', 'Subject not found');
  return subject;
}

export async function createSubject(data: { name: string }) {
  const existing = await prisma.subject.findUnique({ where: { name: data.name } });
  if (existing) throw new AppError(409, 'SUBJECT_EXISTS', 'A subject with this name already exists');

  return prisma.subject.create({ data: { name: data.name }, include: { levels: true } });
}

export async function updateSubject(id: string, data: { name?: string; isActive?: boolean }) {
  const subject = await prisma.subject.findUnique({ where: { id } });
  if (!subject) throw new AppError(404, 'SUBJECT_NOT_FOUND', 'Subject not found');

  // FR-ACA-01: Cannot deactivate subject with active students
  if (data.isActive === false && subject.isActive) {
    const activeStudentCount = await prisma.student.count({
      where: {
        status: 'ACTIVE',
        combinationHistories: {
          some: {
            level: { subjectId: id },
          },
        },
      },
    });
    if (activeStudentCount > 0) {
      throw new AppError(
        400,
        'SUBJECT_HAS_ACTIVE_STUDENTS',
        'Cannot deactivate a subject with active students'
      );
    }
  }

  if (data.name && data.name !== subject.name) {
    const existing = await prisma.subject.findUnique({ where: { name: data.name } });
    if (existing) throw new AppError(409, 'SUBJECT_EXISTS', 'A subject with this name already exists');
  }

  return prisma.subject.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
    include: { levels: true },
  });
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export async function listLevels(subjectId?: string) {
  return prisma.level.findMany({
    where: subjectId ? { subjectId } : undefined,
    include: { subject: true },
    orderBy: { name: 'asc' },
  });
}

export async function getLevel(id: string) {
  const level = await prisma.level.findUnique({
    where: { id },
    include: { subject: true },
  });
  if (!level) throw new AppError(404, 'LEVEL_NOT_FOUND', 'Level not found');
  return level;
}

export async function createLevel(data: { subjectId: string; name: string }) {
  const subject = await prisma.subject.findUnique({ where: { id: data.subjectId } });
  if (!subject) throw new AppError(404, 'SUBJECT_NOT_FOUND', 'Subject not found');
  if (!subject.isActive) throw new AppError(400, 'SUBJECT_INACTIVE', 'Subject is not active');

  const existing = await prisma.level.findUnique({
    where: { subjectId_name: { subjectId: data.subjectId, name: data.name } },
  });
  if (existing) throw new AppError(409, 'LEVEL_EXISTS', 'A level with this name already exists in this subject');

  return prisma.level.create({
    data: { subjectId: data.subjectId, name: data.name },
    include: { subject: true },
  });
}

export async function updateLevel(id: string, data: { name?: string; isActive?: boolean }) {
  const level = await prisma.level.findUnique({ where: { id }, include: { subject: true } });
  if (!level) throw new AppError(404, 'LEVEL_NOT_FOUND', 'Level not found');

  // FR-ACA-01: Cannot deactivate level with active students
  if (data.isActive === false && level.isActive) {
    const activeStudentCount = await prisma.student.count({
      where: {
        status: 'ACTIVE',
        combinationHistories: {
          some: { levelId: id },
        },
      },
    });
    if (activeStudentCount > 0) {
      throw new AppError(
        400,
        'LEVEL_HAS_ACTIVE_STUDENTS',
        'Cannot deactivate a level with active students'
      );
    }
  }

  if (data.name && data.name !== level.name) {
    const existing = await prisma.level.findUnique({
      where: { subjectId_name: { subjectId: level.subjectId, name: data.name } },
    });
    if (existing) throw new AppError(409, 'LEVEL_EXISTS', 'A level with this name already exists in this subject');
  }

  return prisma.level.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
    include: { subject: true },
  });
}

// ---------------------------------------------------------------------------
// Permanent Subject Deletion (Admin only - BR-27)
// ---------------------------------------------------------------------------

export async function deleteSubjectPermanently(id: string) {
  const subject = await prisma.subject.findUnique({
    where: { id },
    include: {
      levels: true,
    },
  });
  if (!subject) throw new AppError(404, 'SUBJECT_NOT_FOUND', 'Subject not found');

  await prisma.$transaction(async (tx) => {
    const levelIds = subject.levels.map((l) => l.id);

    if (levelIds.length > 0) {
      // 1. Get all lessons for these levels
      const lessons = await tx.lesson.findMany({
        where: { levelId: { in: levelIds } },
        select: { id: true },
      });
      const lessonIds = lessons.map((l) => l.id);

      if (lessonIds.length > 0) {
        // 2. Get all attendances for those lessons
        const attendances = await tx.attendance.findMany({
          where: { lessonId: { in: lessonIds } },
          select: { id: true },
        });
        const attendanceIds = attendances.map((a) => a.id);

        if (attendanceIds.length > 0) {
          // 3. Find charges linked to these attendances
          const charges = await tx.charge.findMany({
            where: { attendanceId: { in: attendanceIds } },
            select: { id: true },
          });
          const chargeIds = charges.map((c) => c.id);

          if (chargeIds.length > 0) {
            // Delete payments on these charges
            await tx.payment.deleteMany({
              where: { chargeId: { in: chargeIds } },
            });
            // Delete the charges
            await tx.charge.deleteMany({
              where: { id: { in: chargeIds } },
            });
          }

          // Delete attendances
          await tx.attendance.deleteMany({
            where: { id: { in: attendanceIds } },
          });
        }

        // Delete lessons
        await tx.lesson.deleteMany({
          where: { id: { in: lessonIds } },
        });
      }

      // 4. Delete fees for these levels
      await tx.fee.deleteMany({
        where: { levelId: { in: levelIds } },
      });

      // 5. Delete combination histories for these levels
      await tx.studentCombinationHistory.deleteMany({
        where: { levelId: { in: levelIds } },
      });

      // 6. Delete payment groups that have no payments remaining
      await tx.paymentGroup.deleteMany({
        where: {
          payments: { none: {} },
        },
      });

      // 7. Delete levels
      await tx.level.deleteMany({
        where: { id: { in: levelIds } },
      });
    }

    // 8. Delete subject
    await tx.subject.delete({
      where: { id },
    });
  });

  return { deleted: true, subjectId: id };
}
