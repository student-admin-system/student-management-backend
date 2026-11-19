import prisma from '../prisma';
import { AppError } from '../middleware/errorHandler';
import { getStudentProfile } from './studentService';
import { getLessonAttendance, getStudentAttendanceReport } from './attendanceService';
import { getUnconfirmedBillingList } from './billingService';
import { ChargeStatus, Prisma } from '@prisma/client';
import { getCurrentMonth, isMonthValid, getCairoDayBounds } from '../utils/date';

export { getStudentAttendanceReport };

/**
 * FR-RPT-01: Student Statement
 */
export async function getStudentStatement(studentId: string) {
  return getStudentProfile(studentId);
}

/**
 * FR-RPT-02: Debtors List (Admin only)
 * Filter by subjectId and levelId
 */
export async function getDebtorsList(filters?: { subjectId?: string; levelId?: string }) {
  // Find all unpaid charges
  const whereStudent: Prisma.StudentWhereInput = {
    charges: {
      some: {
        status: ChargeStatus.UNPAID,
      },
    },
  };

  const currentMonth = getCurrentMonth();

  // If level or subject filter provided, resolve exact current combination
  if (filters?.levelId) {
    const rows = await prisma.$queryRaw<{ studentId: string }[]>`
      SELECT "studentId"
      FROM (
        SELECT DISTINCT ON ("studentId") "studentId", "levelId"
        FROM "student_combination_history"
        WHERE "month" <= ${currentMonth}
        ORDER BY "studentId", "month" DESC
      ) sub
      WHERE "levelId" = ${filters.levelId}
    `;
    whereStudent.id = { in: rows.map((r) => r.studentId) };
  } else if (filters?.subjectId) {
    const rows = await prisma.$queryRaw<{ studentId: string }[]>`
      SELECT "studentId"
      FROM (
        SELECT DISTINCT ON (sch."studentId") sch."studentId", l."subjectId"
        FROM "student_combination_history" sch
        JOIN "levels" l ON l."id" = sch."levelId"
        WHERE sch."month" <= ${currentMonth}
        ORDER BY sch."studentId", sch."month" DESC
      ) sub
      WHERE "subjectId" = ${filters.subjectId}
    `;
    whereStudent.id = { in: rows.map((r) => r.studentId) };
  }

  const students = await prisma.student.findMany({
    where: whereStudent,
    include: {
      combinationHistories: {
        where: { month: { lte: currentMonth } },
        orderBy: { month: 'desc' },
        take: 1,
        include: {
          level: {
            include: { subject: true },
          },
        },
      },
      charges: {
        where: { status: ChargeStatus.UNPAID },
        orderBy: { billedMonth: 'asc' },
      },
    },
    orderBy: { studentNumber: 'asc' },
  });

  return students.map((s) => {
    const combo = s.combinationHistories[0];
    const totalUnpaid = s.charges.reduce(
      (sum, c) => sum.add(c.amount),
      new Prisma.Decimal(0)
    );
    const oldestUnpaidMonth = s.charges[0]?.billedMonth ?? null;

    return {
      studentId: s.id,
      studentNumber: s.studentNumber,
      fullName: s.fullName,
      guardianPhone: s.guardianPhone,
      studentPhone: s.studentPhone,
      levelId: combo?.levelId ?? null,
      levelName: combo ? `${combo.level.subject.name} - ${combo.level.name}` : null,
      totalUnpaid: totalUnpaid.toString(),
      oldestUnpaidMonth,
      unpaidChargesCount: s.charges.length,
    };
  });
}

/**
 * FR-RPT-03: Attendance Report (Lesson attendance view)
 */
export async function getAttendanceReport(levelId: string, date: string) {
  return getLessonAttendance(levelId, date);
}

/**
 * FR-RPT-04: Monthly Financial Summary (Admin only)
 * By subject and level for a given billed month (D2).
 * Accurately maps each student to their exact active combination in the month, preventing multi-counting.
 */
export async function getMonthlyFinancialSummary(month: string) {
  if (!isMonthValid(month)) {
    throw new AppError(400, 'INVALID_MONTH', 'Invalid month format (YYYY-MM)');
  }

  // Get all levels with subjects
  const levels = await prisma.level.findMany({
    include: { subject: true },
    orderBy: [{ subject: { name: 'asc' } }, { name: 'asc' }],
  });

  // 1. Resolve exact student combinations for this month
  const studentLevelRows = await prisma.$queryRaw<{ studentId: string; levelId: string }[]>`
    SELECT "studentId", "levelId"
    FROM (
      SELECT DISTINCT ON ("studentId") "studentId", "levelId"
      FROM "student_combination_history"
      WHERE "month" <= ${month}
      ORDER BY "studentId", "month" DESC
    ) sub
  `;

  const levelStudentsMap = new Map<string, string[]>();
  for (const row of studentLevelRows) {
    if (!levelStudentsMap.has(row.levelId)) {
      levelStudentsMap.set(row.levelId, []);
    }
    levelStudentsMap.get(row.levelId)!.push(row.studentId);
  }

  const summary = [];

  for (const level of levels) {
    const studentIds = levelStudentsMap.get(level.id) || [];

    if (studentIds.length === 0) {
      summary.push({
        subjectId: level.subjectId,
        subjectName: level.subject.name,
        levelId: level.id,
        levelName: level.name,
        charged: '0',
        collected: '0',
        waived: '0',
        outstanding: '0',
      });
      continue;
    }

    // 1. Non-voided charges billed in the month for students active in this level
    const charges = await prisma.charge.findMany({
      where: {
        billedMonth: month,
        status: { not: ChargeStatus.VOIDED },
        studentId: { in: studentIds },
      },
    });

    const chargedTotal = charges.reduce(
      (sum, c) => sum.add(c.amount),
      new Prisma.Decimal(0)
    );

    const waivedTotal = charges
      .filter((c) => c.status === ChargeStatus.WAIVED)
      .reduce((sum, c) => sum.add(c.amount), new Prisma.Decimal(0));

    const outstandingTotal = charges
      .filter((c) => c.status === ChargeStatus.UNPAID)
      .reduce((sum, c) => sum.add(c.amount), new Prisma.Decimal(0));

    // 2. Collected = payments whose Received On falls in the month (D2)
    const payments = await prisma.payment.findMany({
      where: {
        receivedOn: { startsWith: month },
        isVoided: false,
        studentId: { in: studentIds },
      },
    });

    const collectedTotal = payments.reduce(
      (sum, p) => sum.add(p.amount),
      new Prisma.Decimal(0)
    );

    summary.push({
      subjectId: level.subjectId,
      subjectName: level.subject.name,
      levelId: level.id,
      levelName: level.name,
      charged: chargedTotal.toString(),
      collected: collectedTotal.toString(),
      waived: waivedTotal.toString(),
      outstanding: outstandingTotal.toString(),
    });
  }

  return { month, summary };
}

/**
 * FR-RPT-05: Daily Collections
 * Payments recorded on a specific date (based on entryTimestamp, D2).
 * Assistant can see only own entries. Admin can see all.
 */
export async function getDailyCollections(
  date: string, // YYYY-MM-DD
  userId?: string,
  userRole?: 'ADMIN' | 'ASSISTANT'
) {
  const { start: startOfDay, end: endOfDay } = getCairoDayBounds(date);

  const where: Prisma.PaymentWhereInput = {
    isVoided: false,
    entryTimestamp: {
      gte: startOfDay,
      lte: endOfDay,
    },
  };

  // D1: Assistant can only view their own collections
  if (userRole === 'ASSISTANT' && userId) {
    where.recordedById = userId;
  }

  const payments = await prisma.payment.findMany({
    where,
    include: {
      student: {
        select: {
          id: true,
          studentNumber: true,
          fullName: true,
        },
      },
      charge: true,
      recordedBy: {
        select: {
          id: true,
          name: true,
          username: true,
        },
      },
    },
    orderBy: { entryTimestamp: 'asc' },
  });

  const totalAmount = payments.reduce(
    (sum, p) => sum.add(p.amount),
    new Prisma.Decimal(0)
  );

  return {
    date,
    totalAmount: totalAmount.toString(),
    paymentsCount: payments.length,
    payments,
  };
}

/**
 * FR-RPT-06: Unconfirmed Billing List
 */
export async function getUnconfirmedReport(month: string) {
  return getUnconfirmedBillingList(month);
}
