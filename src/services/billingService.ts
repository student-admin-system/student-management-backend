import prisma from '../prisma';
import { AppError } from '../middleware/errorHandler';
import {
  getCurrentMonth,
  getPreviousMonth,
  compareMonths,
  isMonthValid,
} from '../utils/date';
import { getEffectiveFee } from './feeService';
import { BillingMethod, ChargeSource, ChargeType, Prisma, StudentStatus } from '@prisma/client';

export interface StudentBillingSelectionItem {
  studentId: string;
  studentNumber: number;
  fullName: string;
  levelId: string;
  levelName: string;
  subjectName: string;
  suggestedMethod: BillingMethod;
  isConfirmed: boolean;
  confirmedMethod?: BillingMethod | null;
  unchargedAttendancesCount: number;
}

/**
 * Get monthly billing selection list for a given month (BR-10).
 * Lists all Active students except those enrolled in the target month (BR-10.1).
 * Includes suggestion from previous month (BR-10.2).
 */
export async function getBillingSelectionList(month: string): Promise<StudentBillingSelectionItem[]> {
  if (!isMonthValid(month)) {
    throw new AppError(400, 'INVALID_MONTH', 'Invalid month format (YYYY-MM)');
  }

  const prevMonth = getPreviousMonth(month);

  // Active students whose enrollment month is not the target month
  const students = await prisma.student.findMany({
    where: {
      status: StudentStatus.ACTIVE,
      enrollmentDate: {
        not: {
          startsWith: month,
        },
      },
    },
    include: {
      combinationHistories: {
        where: { month: { lte: month } },
        orderBy: { month: 'desc' },
        take: 1,
        include: {
          level: {
            include: { subject: true },
          },
        },
      },
      billingStates: {
        where: {
          month: { in: [month, prevMonth] },
        },
      },
      attendances: {
        where: {
          isVoided: false,
          lesson: {
            date: { startsWith: month },
          },
          charges: {
            none: {
              status: { not: 'VOIDED' },
            },
          },
        },
        select: { id: true },
      },
    },
    orderBy: { studentNumber: 'asc' },
  });

  return students.map((s) => {
    const currentBilling = s.billingStates.find((b) => b.month === month);
    const prevBilling = s.billingStates.find((b) => b.month === prevMonth);
    const combo = s.combinationHistories[0];

    // BR-10.2: Last month's method is pre-filled as suggestion, default PER_LESSON
    const suggestedMethod = prevBilling?.method ?? BillingMethod.PER_LESSON;

    return {
      studentId: s.id,
      studentNumber: s.studentNumber,
      fullName: s.fullName,
      levelId: combo?.levelId ?? '',
      levelName: combo?.level.name ?? '',
      subjectName: combo?.level.subject.name ?? '',
      suggestedMethod,
      isConfirmed: currentBilling?.isConfirmed ?? false,
      confirmedMethod: currentBilling?.isConfirmed ? currentBilling.method : null,
      unchargedAttendancesCount: s.attendances.length,
      unchargedAttendanceCount: s.attendances.length,
    };
  });
}

/**
 * Get unconfirmed billing list for a month (BR-10.6, FR-RPT-06).
 */
export async function getUnconfirmedBillingList(month: string) {
  const selectionList = await getBillingSelectionList(month);
  return selectionList.filter((item) => !item.isConfirmed);
}

/**
 * Confirm monthly billing for one or multiple students (BR-02, BR-04, BR-10, BR-25).
 */
export async function confirmMonthlyBilling(
  month: string,
  confirmations: Array<{ studentId: string; method: BillingMethod }>
) {
  if (!isMonthValid(month)) {
    throw new AppError(400, 'INVALID_MONTH', 'Invalid month format (YYYY-MM)');
  }

  const currentMonth = getCurrentMonth();
  // BR-25: Billing can be confirmed for current or previous month, never future month
  if (compareMonths(month, currentMonth) > 0) {
    throw new AppError(400, 'FUTURE_MONTH_BILLING', 'Cannot confirm billing for future months');
  }

  const results = [];

  for (const item of confirmations) {
    const student = await prisma.student.findUnique({
      where: { id: item.studentId },
      include: {
        combinationHistories: {
          where: { month: { lte: month } },
          orderBy: { month: 'desc' },
          take: 1,
        },
      },
    });

    if (!student) {
      throw new AppError(404, 'STUDENT_NOT_FOUND', `Student ${item.studentId} not found`);
    }

    const levelId = student.combinationHistories[0]?.levelId;
    if (!levelId) {
      throw new AppError(400, 'NO_COMBINATION', `Student ${student.fullName} has no combination for month ${month}`);
    }

    const fee = await getEffectiveFee(levelId, month);
    const subscriptionFee = fee?.subscriptionFee ?? new Prisma.Decimal(0);
    const perLessonFee = fee?.perLessonFee ?? new Prisma.Decimal(0);

    await prisma.$transaction(async (tx) => {
      // 1. Upsert MonthlyBillingState
      await tx.monthlyBillingState.upsert({
        where: {
          studentId_month: { studentId: item.studentId, month },
        },
        update: {
          method: item.method,
          isConfirmed: true,
          confirmedAt: new Date(),
        },
        create: {
          studentId: item.studentId,
          month,
          method: item.method,
          isConfirmed: true,
          confirmedAt: new Date(),
        },
      });

      if (item.method === BillingMethod.SUBSCRIPTION) {
        // BR-01, BR-02: Check if non-voided subscription charge already exists
        const existingSubCharge = await tx.charge.findFirst({
          where: {
            studentId: item.studentId,
            billedMonth: month,
            type: ChargeType.SUBSCRIPTION,
            status: { not: 'VOIDED' },
          },
        });

        if (!existingSubCharge) {
          await tx.charge.create({
            data: {
              studentId: item.studentId,
              billedMonth: month,
              type: ChargeType.SUBSCRIPTION,
              amount: subscriptionFee,
              source: ChargeSource.MONTHLY_CONFIRMATION,
              status: 'UNPAID',
            },
          });
        }
      } else if (item.method === BillingMethod.PER_LESSON) {
        // BR-02: Retroactively create Per-Lesson charge for all non-voided attendances in month
        const attendances = await tx.attendance.findMany({
          where: {
            studentId: item.studentId,
            isVoided: false,
            lesson: {
              date: { startsWith: month },
            },
            charges: {
              none: {
                status: { not: 'VOIDED' },
              },
            },
          },
        });

        for (const att of attendances) {
          await tx.charge.create({
            data: {
              studentId: item.studentId,
              billedMonth: month,
              type: ChargeType.PER_LESSON,
              amount: perLessonFee,
              source: ChargeSource.ATTENDANCE,
              attendanceId: att.id,
              status: 'UNPAID',
            },
          });
        }
      }
    });

    results.push({ studentId: item.studentId, status: 'CONFIRMED', method: item.method });
  }

  return { month, confirmedCount: results.length, results };
}

/**
 * Reopen a confirmed month for a student (BR-08).
 * Voids all charges generated by previous confirmation (unless Paid).
 * If any charge is Paid, payment group must be voided first (BR-07).
 * Waived charges are voided as well (BR-08, OQ1).
 * Attendance is untouched.
 */
export async function reopenMonthlyBilling(studentId: string, month: string) {
  if (!isMonthValid(month)) {
    throw new AppError(400, 'INVALID_MONTH', 'Invalid month format (YYYY-MM)');
  }

  const billingState = await prisma.monthlyBillingState.findUnique({
    where: { studentId_month: { studentId, month } },
  });

  if (!billingState || !billingState.isConfirmed) {
    throw new AppError(400, 'MONTH_NOT_CONFIRMED', 'Month is not confirmed for this student');
  }

  // Find all non-voided charges for this student in this billedMonth
  const charges = await prisma.charge.findMany({
    where: {
      studentId,
      billedMonth: month,
      status: { not: 'VOIDED' },
    },
    include: {
      payments: {
        where: { isVoided: false },
      },
    },
  });

  // BR-07 & BR-08: Check if any charge is Paid
  const paidCharges = charges.filter((c) => c.status === 'PAID' && c.payments.length > 0);
  if (paidCharges.length > 0) {
    throw new AppError(
      400,
      'CHARGE_PAID',
      'Cannot reopen month because one or more charges are Paid. Void the corresponding payment group(s) first.'
    );
  }

  await prisma.$transaction(async (tx) => {
    // Void all charges for this month
    for (const c of charges) {
      await tx.charge.update({
        where: { id: c.id },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
        },
      });
    }

    // Set billing state to unconfirmed
    await tx.monthlyBillingState.update({
      where: { id: billingState.id },
      data: {
        isConfirmed: false,
        confirmedAt: null,
      },
    });
  });

  return { studentId, month, status: 'REOPENED' };
}
