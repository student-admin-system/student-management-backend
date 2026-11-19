import prisma from '../prisma';
import { AppError } from '../middleware/errorHandler';
import { normalizeArabic } from '../utils/arabic';
import {
  getCairoToday,
  getCurrentMonth,
  getMonthFromDate,
  getPreviousMonth,
} from '../utils/date';
import { parsePagination, buildPaginatedResponse } from '../utils/pagination';
import { PaginationParams, PaginatedResponse } from '../types';
import { Prisma, StudentStatus, ChargeStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegisterStudentData {
  fullName: string;
  enrollmentDate: string; // YYYY-MM-DD
  levelId: string;
  studentPhone?: string;
  guardianName?: string;
  guardianPhone?: string;
  school?: string;
  notes?: string;
}

interface UpdateStudentData {
  fullName?: string;
  enrollmentDate?: string;
  studentPhone?: string | null;
  guardianName?: string | null;
  guardianPhone?: string | null;
  school?: string | null;
  notes?: string | null;
}

interface SearchStudentsQuery extends PaginationParams {
  q?: string;
  forAttendance?: boolean;
  status?: StudentStatus;
  subjectId?: string;
  levelId?: string;
  hasDebt?: boolean;
  month?: string; // YYYY-MM
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check for existing students with similar names (FR-STU-05). */
async function checkDuplicatesByName(fullName: string): Promise<string[]> {
  const normalized = normalizeArabic(fullName);
  const students = await prisma.student.findMany({
    select: { id: true, fullName: true, studentNumber: true },
  });

  const duplicates: string[] = [];
  for (const s of students) {
    if (normalizeArabic(s.fullName) === normalized) {
      duplicates.push(`#${s.studentNumber} ${s.fullName}`);
    }
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// registerStudent
// ---------------------------------------------------------------------------

export async function registerStudent(data: RegisterStudentData, _userId: string) {
  // Validate level exists and is active
  const level = await prisma.level.findUnique({
    where: { id: data.levelId },
    include: { subject: true },
  });
  if (!level) {
    throw new AppError(404, 'LEVEL_NOT_FOUND', 'Level not found');
  }
  if (!level.isActive) {
    throw new AppError(400, 'LEVEL_INACTIVE', 'Level is not active');
  }

  // FR-STU-05: Duplicate warning (non-blocking)
  const duplicates = await checkDuplicatesByName(data.fullName);

  // FR-STU-02: Phone warning
  const missingPhone = !data.studentPhone && !data.guardianPhone;

  const enrollmentMonth = getMonthFromDate(data.enrollmentDate);

  const normalized = normalizeArabic(data.fullName);

  // Transaction: create student + combination + status (v2.0: billing chosen at attendance or payment)
  const student = await prisma.$transaction(async (tx) => {
    const created = await tx.student.create({
      data: {
        fullName: data.fullName,
        normalizedName: normalized,
        enrollmentDate: data.enrollmentDate,
        studentPhone: data.studentPhone ?? null,
        guardianName: data.guardianName ?? null,
        guardianPhone: data.guardianPhone ?? null,
        school: data.school ?? null,
        notes: data.notes ?? null,
        status: StudentStatus.ACTIVE,
      },
    });

    // Combination history for enrollment month
    await tx.studentCombinationHistory.create({
      data: {
        studentId: created.id,
        levelId: data.levelId,
        month: enrollmentMonth,
      },
    });

    // Status history
    await tx.studentStatusHistory.create({
      data: {
        studentId: created.id,
        status: StudentStatus.ACTIVE,
        effectiveDate: data.enrollmentDate,
      },
    });

    return created;
  });

  const warnings: string[] = [];
  if (duplicates.length > 0) {
    warnings.push(`Possible duplicate(s): ${duplicates.join(', ')}`);
  }
  if (missingPhone) {
    warnings.push('No phone number provided for student or guardian');
  }

  return { student, warnings };
}

// ---------------------------------------------------------------------------
// searchStudents
// ---------------------------------------------------------------------------

export async function searchStudents(query: SearchStudentsQuery) {
  const { page, pageSize } = parsePagination(query);
  const { q, forAttendance, status, subjectId, levelId, hasDebt, month } = query;

  const targetMonth = month ?? getCurrentMonth();

  // Build base where clause
  const where: Prisma.StudentWhereInput = {};

  // Status filter
  if (forAttendance) {
    where.status = StudentStatus.ACTIVE;
  } else if (status) {
    where.status = status;
  }

  // Level or Subject filter (v2.0: resolve latest combination on or before targetMonth)
  if (levelId) {
    const rows = await prisma.$queryRaw<{ studentId: string }[]>`
      SELECT "studentId"
      FROM (
        SELECT DISTINCT ON ("studentId") "studentId", "levelId"
        FROM "student_combination_history"
        WHERE "month" <= ${targetMonth}
        ORDER BY "studentId", "month" DESC
      ) sub
      WHERE "levelId" = ${levelId}
    `;
    const ids = rows.map((r) => r.studentId);
    where.id = { in: ids };
  } else if (subjectId) {
    const rows = await prisma.$queryRaw<{ studentId: string }[]>`
      SELECT "studentId"
      FROM (
        SELECT DISTINCT ON (sch."studentId") sch."studentId", l."subjectId"
        FROM "student_combination_history" sch
        JOIN "levels" l ON l."id" = sch."levelId"
        WHERE sch."month" <= ${targetMonth}
        ORDER BY sch."studentId", sch."month" DESC
      ) sub
      WHERE "subjectId" = ${subjectId}
    `;
    const ids = rows.map((r) => r.studentId);
    where.id = { in: ids };
  }

  // Debt filter
  if (hasDebt === true) {
    where.charges = {
      some: {
        status: ChargeStatus.UNPAID,
      },
    };
  } else if (hasDebt === false) {
    where.charges = {
      none: {
        status: ChargeStatus.UNPAID,
      },
    };
  }

  // Search term with normalizedName indexing
  if (q) {
    const trimmed = q.trim();

    // Try parsing as a student number
    const asNumber = parseInt(trimmed, 10);
    if (!isNaN(asNumber) && String(asNumber) === trimmed) {
      where.studentNumber = asNumber;
    } else {
      // Try phone search
      const isPhone = /^\d{6,}$/.test(trimmed.replace(/[\s\-+]/g, ''));
      if (isPhone) {
        const phoneDigits = trimmed.replace(/[\s\-+]/g, '');
        where.OR = [
          { studentPhone: { contains: phoneDigits } },
          { guardianPhone: { contains: phoneDigits } },
        ];
      } else {
        // Name search with indexed normalizedName (FR-STU-04)
        const normalized = normalizeArabic(trimmed);
        where.OR = [
          { normalizedName: { contains: normalized, mode: 'insensitive' } },
          { fullName: { contains: trimmed, mode: 'insensitive' } },
        ];
      }
    }
  }

  const [total, students] = await Promise.all([
    prisma.student.count({ where }),
    prisma.student.findMany({
      where,
      include: {
        combinationHistories: {
          where: { month: { lte: targetMonth } },
          orderBy: { month: 'desc' },
          include: {
            level: {
              include: { subject: true },
            },
          },
          take: 1,
        },
        billingStates: {
          where: { month: targetMonth },
          take: 1,
        },
      },
      orderBy: { studentNumber: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // Aggregate outstanding balances in one query
  const studentIds = students.map((s) => s.id);
  const unpaidCharges =
    studentIds.length > 0
      ? await prisma.charge.groupBy({
          by: ['studentId'],
          where: {
            studentId: { in: studentIds },
            status: ChargeStatus.UNPAID,
          },
          _sum: {
            amount: true,
          },
        })
      : [];

  const balanceMap = new Map<string, number>();
  unpaidCharges.forEach((item) => {
    balanceMap.set(item.studentId, Number(item._sum.amount ?? 0));
  });

  const data = students.map((s) => {
    const combo = s.combinationHistories[0];
    return {
      id: s.id,
      studentNumber: s.studentNumber,
      fullName: s.fullName,
      combination: combo
        ? `${combo.level.subject.name} - ${combo.level.name}`
        : null,
      levelId: combo?.levelId ?? null,
      currentLevel: combo?.level ?? null,
      levelName: combo?.level?.name ?? null,
      subjectName: combo?.level?.subject?.name ?? null,
      subjectId: combo?.level?.subjectId ?? null,
      status: s.status,
      studentPhone: s.studentPhone,
      guardianName: s.guardianName,
      guardianPhone: s.guardianPhone,
      school: s.school,
      enrollmentDate: s.enrollmentDate,
      monthlyBillingState: s.billingStates[0] ?? null,
      outstandingBalance: balanceMap.get(s.id) ?? 0,
    };
  });

  return buildPaginatedResponse(data, total, { page, pageSize });
}

// ---------------------------------------------------------------------------
// getStudentProfile
// ---------------------------------------------------------------------------

export async function getStudentProfile(id: string) {
  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      combinationHistories: {
        include: {
          level: {
            include: { subject: true },
          },
        },
        orderBy: { month: 'desc' },
      },
      statusHistories: {
        orderBy: { effectiveDate: 'desc' },
      },
      attendances: {
        include: {
          lesson: {
            include: {
              level: {
                include: { subject: true },
              },
            },
          },
        },
        orderBy: { entryTimestamp: 'desc' },
      },
      charges: {
        orderBy: { createdAt: 'desc' },
      },
      paymentGroups: {
        include: {
          payments: {
            include: { charge: true },
          },
          recordedBy: {
            select: { id: true, name: true, username: true },
          },
        },
        orderBy: { entryTimestamp: 'desc' },
      },
      billingStates: {
        orderBy: { month: 'desc' },
      },
    },
  });

  if (!student) {
    throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student not found');
  }

  // BR-21.5:
  // - Total charged = sum of non-voided charges (PAID + UNPAID + WAIVED)
  // - Total paid = sum of non-voided payments
  // - Total waived = sum of WAIVED charges
  // - Outstanding balance = sum of UNPAID charges (Waived charges excluded per BR-21.5)
  const nonVoidedCharges = student.charges.filter((c) => c.status !== 'VOIDED');
  const totalCharged = nonVoidedCharges.reduce((sum, c) => sum.add(c.amount), new Prisma.Decimal(0));

  const unpaidCharges = student.charges.filter((c) => c.status === 'UNPAID');
  const outstandingBalance = unpaidCharges.reduce((sum, c) => sum.add(c.amount), new Prisma.Decimal(0));

  const waivedCharges = student.charges.filter((c) => c.status === 'WAIVED');
  const totalWaived = waivedCharges.reduce((sum, c) => sum.add(c.amount), new Prisma.Decimal(0));

  const totalPaid = student.paymentGroups
    .filter((pg) => !pg.isVoided)
    .reduce((sum, pg) => sum.add(pg.totalAmount), new Prisma.Decimal(0));

  const latestCombo = student.combinationHistories[0];
  const currentLevel = latestCombo?.level ?? null;
  const currentCombination = currentLevel
    ? `${currentLevel.subject.name} - ${currentLevel.name}`
    : null;

  const formattedPaymentGroups = student.paymentGroups.map((pg) => ({
    ...pg,
    user: pg.recordedBy,
  }));

  return {
    ...student,
    paymentGroups: formattedPaymentGroups,
    currentLevel,
    currentCombination,
    totalCharged: totalCharged.toString(),
    totalPaid: totalPaid.toString(),
    totalWaived: totalWaived.toString(),
    outstandingBalance: outstandingBalance.toString(),
    totals: {
      charged: totalCharged.toString(),
      paid: totalPaid.toString(),
      waived: totalWaived.toString(),
      outstanding: outstandingBalance.toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// updateStudent
// ---------------------------------------------------------------------------

export async function updateStudent(id: string, data: UpdateStudentData, _userId: string) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) {
    throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student not found');
  }

  // If enrollment date is being changed, validate (D4)
  if (data.enrollmentDate && data.enrollmentDate !== student.enrollmentDate) {
    // Check for non-voided attendance
    const hasAttendance = await prisma.attendance.count({
      where: { studentId: id, isVoided: false },
    });
    // Check for non-voided charges
    const hasCharges = await prisma.charge.count({
      where: {
        studentId: id,
        status: { notIn: ['VOIDED'] },
      },
    });

    if (hasAttendance > 0 || hasCharges > 0) {
      throw new AppError(
        400,
        'ENROLLMENT_DATE_LOCKED',
        'Enrollment date cannot be changed because the student has non-voided attendance or charges'
      );
    }

    const oldMonth = getMonthFromDate(student.enrollmentDate);
    const newMonth = getMonthFromDate(data.enrollmentDate);

    if (oldMonth !== newMonth) {
      // Move auto Per-Lesson confirmation to new month
      await prisma.$transaction(async (tx) => {
        // Delete old billing state for enrollment month
        await tx.monthlyBillingState.deleteMany({
          where: { studentId: id, month: oldMonth },
        });

        // Create new one for new enrollment month
        await tx.monthlyBillingState.upsert({
          where: {
            studentId_month: { studentId: id, month: newMonth },
          },
          update: {
            method: 'PER_LESSON',
            isConfirmed: true,
            confirmedAt: new Date(),
          },
          create: {
            studentId: id,
            month: newMonth,
            method: 'PER_LESSON',
            isConfirmed: true,
            confirmedAt: new Date(),
          },
        });

        // Move combination history
        await tx.studentCombinationHistory.updateMany({
          where: { studentId: id, month: oldMonth },
          data: { month: newMonth },
        });

        // Update status history effective date
        await tx.studentStatusHistory.updateMany({
          where: {
            studentId: id,
            effectiveDate: student.enrollmentDate,
          },
          data: { effectiveDate: data.enrollmentDate },
        });
      });
    }
  }

  const updated = await prisma.student.update({
    where: { id },
    data: {
      ...(data.fullName !== undefined && {
        fullName: data.fullName,
        normalizedName: normalizeArabic(data.fullName),
      }),
      ...(data.enrollmentDate !== undefined && { enrollmentDate: data.enrollmentDate }),
      ...(data.studentPhone !== undefined && { studentPhone: data.studentPhone }),
      ...(data.guardianName !== undefined && { guardianName: data.guardianName }),
      ...(data.guardianPhone !== undefined && { guardianPhone: data.guardianPhone }),
      ...(data.school !== undefined && { school: data.school }),
      ...(data.notes !== undefined && { notes: data.notes }),
    },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// changeStudentStatus
// ---------------------------------------------------------------------------

export async function changeStudentStatus(
  id: string,
  newStatus: StudentStatus,
  _userId: string
) {
  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      statusHistories: {
        orderBy: { effectiveDate: 'desc' },
      },
    },
  });

  if (!student) {
    throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student not found');
  }

  if (student.status === newStatus) {
    throw new AppError(400, 'STATUS_UNCHANGED', `Student is already ${newStatus}`);
  }

  const today = getCairoToday(); // YYYY-MM-DD
  const currentMonth = getCurrentMonth(); // YYYY-MM

  await prisma.$transaction(async (tx) => {
    // BR-11, BR-20: Create status history entry
    await tx.studentStatusHistory.create({
      data: {
        studentId: id,
        status: newStatus,
        effectiveDate: today,
      },
    });

    // BR-12: If reactivating (INACTIVE → ACTIVE)
    if (student.status === StudentStatus.INACTIVE && newStatus === StudentStatus.ACTIVE) {
      // Check if student was inactive at the start of the current month
      // by looking at the status at start of month (before any changes this month)
      const monthStart = `${currentMonth}-01`;

      // Find the latest status history entry before the start of this month
      const statusAtMonthStart = await tx.studentStatusHistory.findFirst({
        where: {
          studentId: id,
          effectiveDate: { lt: monthStart },
        },
        orderBy: { effectiveDate: 'desc' },
      });

      const wasInactiveAtMonthStart =
        !statusAtMonthStart || statusAtMonthStart.status === StudentStatus.INACTIVE;

      if (wasInactiveAtMonthStart) {
        // Auto-confirm Per-Lesson for current month
        const existing = await tx.monthlyBillingState.findUnique({
          where: { studentId_month: { studentId: id, month: currentMonth } },
        });

        if (!existing) {
          await tx.monthlyBillingState.create({
            data: {
              studentId: id,
              month: currentMonth,
              method: 'PER_LESSON',
              isConfirmed: true,
              confirmedAt: new Date(),
            },
          });
        }
      }
      // If was active at start of month (deactivated and reactivated same month),
      // leave billing unchanged — no action needed.
    }

    // Update student status
    await tx.student.update({
      where: { id },
      data: { status: newStatus },
    });
  });

  return prisma.student.findUnique({ where: { id } });
}

// ---------------------------------------------------------------------------
// changeStudentCombination
// ---------------------------------------------------------------------------

export async function changeStudentCombination(
  id: string,
  newLevelId: string,
  _userId: string
) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) {
    throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student not found');
  }

  // Validate new level
  const level = await prisma.level.findUnique({
    where: { id: newLevelId },
    include: { subject: true },
  });
  if (!level) {
    throw new AppError(404, 'LEVEL_NOT_FOUND', 'Level not found');
  }
  if (!level.isActive) {
    throw new AppError(400, 'LEVEL_INACTIVE', 'Level is not active');
  }

  const currentMonth = getCurrentMonth();

  // BR-14: Check for non-voided attendance or charges in current month
  const [attendanceCount, chargeCount] = await Promise.all([
    prisma.attendance.count({
      where: {
        studentId: id,
        isVoided: false,
        lesson: {
          date: { startsWith: currentMonth },
        },
      },
    }),
    prisma.charge.count({
      where: {
        studentId: id,
        billedMonth: currentMonth,
        status: { notIn: ['VOIDED'] },
      },
    }),
  ]);

  const hasActivity = attendanceCount > 0 || chargeCount > 0;
  const effectiveMonth = hasActivity ? getNextMonth(currentMonth) : currentMonth;

  // Create or update combination history for the effective month
  await prisma.studentCombinationHistory.upsert({
    where: {
      studentId_month: { studentId: id, month: effectiveMonth },
    },
    update: { levelId: newLevelId },
    create: {
      studentId: id,
      levelId: newLevelId,
      month: effectiveMonth,
    },
  });

  return {
    effectiveMonth,
    deferred: hasActivity,
    level: `${level.subject.name} - ${level.name}`,
  };
}

/** Compute the next month from YYYY-MM. */
function getNextMonth(month: string): string {
  const [yearStr, monthStr] = month.split('-');
  let y = parseInt(yearStr, 10);
  let m = parseInt(monthStr, 10) + 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// deleteStudent
// ---------------------------------------------------------------------------

export async function deleteStudent(id: string) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) {
    throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student not found');
  }

  // Get lesson IDs associated with this student's attendance before deletion
  const attendances = await prisma.attendance.findMany({
    where: { studentId: id },
    select: { lessonId: true },
  });
  const lessonIds = [...new Set(attendances.map((a) => a.lessonId))];

  // BR-23: Permanently delete student — cascades handle most relations
  await prisma.student.delete({ where: { id } });

  // Delete lessons left without any attendance
  if (lessonIds.length > 0) {
    for (const lessonId of lessonIds) {
      const remaining = await prisma.attendance.count({
        where: { lessonId },
      });
      if (remaining === 0) {
        await prisma.lesson.delete({ where: { id: lessonId } });
      }
    }
  }

  // D3: Recalculate fee freezing — remove frozen status for fees
  // that no longer have any non-voided charges
  // (Fee freezing is tracked by whether charges exist for a level+month;
  //  after deleting the student's charges via cascade, some fees may now be unfrozen.)
  // This is a no-op if no fee-freeze mechanism is tracked via a flag;
  // the absence of charges is itself the unfreezing.

  return { deleted: true };
}
