import prisma from '../prisma';
import { AppError } from '../middleware/errorHandler';
import { getCurrentMonth, compareMonths, isMonthValid } from '../utils/date';

// ---------------------------------------------------------------------------
// Fee lookup helper: get the effective fee for a level+month
// (most recent fee from that month or earlier — BR-17.2)
// ---------------------------------------------------------------------------
export async function getEffectiveFee(levelId: string, month: string) {
  // Get the fee for the exact month or the most recent earlier one
  const fee = await prisma.fee.findFirst({
    where: {
      levelId,
      month: { lte: month },
    },
    orderBy: { month: 'desc' },
  });
  return fee ?? null;
}

// ---------------------------------------------------------------------------
// List fees for a level (optionally filtered by month range)
// ---------------------------------------------------------------------------
export async function listFees(levelId: string) {
  const level = await prisma.level.findUnique({ where: { id: levelId } });
  if (!level) throw new AppError(404, 'LEVEL_NOT_FOUND', 'Level not found');

  return prisma.fee.findMany({
    where: { levelId },
    orderBy: { month: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Upsert fee (set/update fee for a specific month)
// BR-17.3: Admin can set fees for current or future months only
// BR-17.4: Cannot edit a month that already has non-voided charges
// ---------------------------------------------------------------------------
export async function upsertFee(data: {
  levelId: string;
  month: string;
  subscriptionFee: number;
  perLessonFee: number;
}) {
  if (!isMonthValid(data.month)) {
    throw new AppError(400, 'INVALID_MONTH', 'Invalid month format (YYYY-MM)');
  }

  const level = await prisma.level.findUnique({ where: { id: data.levelId } });
  if (!level) throw new AppError(404, 'LEVEL_NOT_FOUND', 'Level not found');

  const currentMonth = getCurrentMonth();

  // BR-17.3: Cannot set fees for past months
  if (compareMonths(data.month, currentMonth) < 0) {
    throw new AppError(400, 'PAST_MONTH_FEES', 'Cannot set fees for past months');
  }

  // BR-17.4: Cannot edit if non-voided charges exist for this level+month
  // Resolve active student combinations for data.month
  const matchingStudents = await prisma.$queryRaw<{ studentId: string }[]>`
    SELECT "studentId"
    FROM (
      SELECT DISTINCT ON ("studentId") "studentId", "levelId"
      FROM "student_combination_history"
      WHERE "month" <= ${data.month}
      ORDER BY "studentId", "month" DESC
    ) sub
    WHERE "levelId" = ${data.levelId}
  `;
  const studentIds = matchingStudents.map((s) => s.studentId);

  const frozenChargeCount =
    studentIds.length > 0
      ? await prisma.charge.count({
          where: {
            billedMonth: data.month,
            status: { not: 'VOIDED' },
            studentId: { in: studentIds },
          },
        })
      : 0;

  if (frozenChargeCount > 0) {
    throw new AppError(
      400,
      'FEES_FROZEN',
      'Cannot edit fees for this month because charges already exist. Apply changes from a future month.'
    );
  }

  return prisma.fee.upsert({
    where: { levelId_month: { levelId: data.levelId, month: data.month } },
    update: {
      subscriptionFee: data.subscriptionFee,
      perLessonFee: data.perLessonFee,
    },
    create: {
      levelId: data.levelId,
      month: data.month,
      subscriptionFee: data.subscriptionFee,
      perLessonFee: data.perLessonFee,
    },
  });
}

// ---------------------------------------------------------------------------
// Get a specific fee record (or effective fee) for level+month
// ---------------------------------------------------------------------------
export async function getFeeForMonth(levelId: string, month: string) {
  if (!isMonthValid(month)) {
    throw new AppError(400, 'INVALID_MONTH', 'Invalid month format (YYYY-MM)');
  }

  const level = await prisma.level.findUnique({ where: { id: levelId } });
  if (!level) throw new AppError(404, 'LEVEL_NOT_FOUND', 'Level not found');

  const fee = await getEffectiveFee(levelId, month);
  return fee;
}
