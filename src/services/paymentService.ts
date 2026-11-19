import prisma from '../prisma';
import { AppError } from '../middleware/errorHandler';
import {
  getCairoToday,
  getCurrentMonth,
  getMonthFromDate,
  getPreviousMonth,
  compareDates,
  compareMonths,
  isDateValid,
  isMonthValid,
} from '../utils/date';
import { getEffectiveFee } from './feeService';
import { ChargeStatus, Prisma } from '@prisma/client';

export interface CreatePaymentGroupInput {
  studentId: string;
  chargeIds: string[];
  receivedOn?: string; // YYYY-MM-DD, default today (BR-24)
  recordedById: string;
}

export interface CreateSubscriptionPaymentInput {
  studentId: string;
  month: string; // YYYY-MM
  receivedOn?: string; // YYYY-MM-DD
  recordedById: string;
}

/**
 * Record a payment group settling one or more Unpaid charges (BR-03, BR-24, FR-PAY-01).
 */
export async function createPaymentGroup(input: CreatePaymentGroupInput) {
  const { studentId, chargeIds, recordedById } = input;
  const receivedOn = input.receivedOn ?? getCairoToday();

  // Validate receivedOn date format
  if (!isDateValid(receivedOn)) {
    throw new AppError(400, 'INVALID_DATE', 'Invalid receivedOn date format (YYYY-MM-DD)');
  }

  // BR-24: Never in future
  const today = getCairoToday();
  if (compareDates(receivedOn, today) > 0) {
    throw new AppError(400, 'FUTURE_PAYMENT_DATE', 'Received On cannot be in the future');
  }

  // BR-24: Current or previous month only
  const receivedMonth = getMonthFromDate(receivedOn);
  const currentMonth = getCurrentMonth();
  const previousMonth = getPreviousMonth(currentMonth);
  if (compareMonths(receivedMonth, previousMonth) < 0) {
    throw new AppError(
      400,
      'PAYMENT_DATE_TOO_OLD',
      'Received On can only be in the current or previous month'
    );
  }

  if (!chargeIds || chargeIds.length === 0) {
    throw new AppError(400, 'NO_CHARGES_SELECTED', 'At least one charge must be selected');
  }

  // Verify student exists
  const student = await prisma.student.findUnique({
    where: { id: studentId },
  });
  if (!student) {
    throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student not found');
  }

  // Fetch all selected charges
  const charges = await prisma.charge.findMany({
    where: {
      id: { in: chargeIds },
    },
    include: {
      payments: {
        where: { isVoided: false },
      },
    },
  });

  if (charges.length !== chargeIds.length) {
    throw new AppError(400, 'INVALID_CHARGES', 'One or more charge IDs are invalid');
  }

  // BR-03: All charges must belong to the same student
  for (const c of charges) {
    if (c.studentId !== studentId) {
      throw new AppError(400, 'CHARGE_STUDENT_MISMATCH', 'All charges must belong to the specified student');
    }

    // FR-PAY-02: Only Unpaid charges are selectable
    if (c.status !== ChargeStatus.UNPAID) {
      throw new AppError(
        400,
        'CHARGE_NOT_UNPAID',
        `Charge ${c.id} is ${c.status} and cannot be paid`
      );
    }

    // Double check no active payment exists
    if (c.payments && c.payments.length > 0) {
      throw new AppError(400, 'CHARGE_ALREADY_PAID', `Charge ${c.id} already has an active payment`);
    }
  }

  const totalAmount = charges.reduce(
    (sum, c) => sum.add(c.amount),
    new Prisma.Decimal(0)
  );

  const entryTimestamp = new Date();

  return prisma.$transaction(async (tx) => {
    // Create PaymentGroup
    const group = await tx.paymentGroup.create({
      data: {
        studentId,
        receivedOn,
        entryTimestamp,
        recordedById,
        totalAmount,
      },
    });

    // Create individual Payments and update Charge status to PAID
    const payments = [];
    for (const c of charges) {
      const payment = await tx.payment.create({
        data: {
          paymentGroupId: group.id,
          studentId,
          chargeId: c.id,
          amount: c.amount,
          receivedOn,
          entryTimestamp,
          recordedById,
        },
      });

      await tx.charge.update({
        where: { id: c.id },
        data: { status: ChargeStatus.PAID },
      });

      payments.push(payment);
    }

    return {
      paymentGroup: group,
      payments,
      totalAmount: totalAmount.toString(),
    };
  });
}

/**
 * Record a standalone Monthly Subscription payment (BR-02.3 in v2.0).
 * Locks billing state for that month to SUBSCRIPTION and creates a PAID Subscription charge.
 */
export async function createSubscriptionPayment(input: CreateSubscriptionPaymentInput) {
  const { studentId, month, recordedById } = input;
  const receivedOn = input.receivedOn ?? getCairoToday();

  if (!isMonthValid(month)) {
    throw new AppError(400, 'INVALID_MONTH', 'Invalid month format (YYYY-MM)');
  }
  if (!isDateValid(receivedOn)) {
    throw new AppError(400, 'INVALID_DATE', 'Invalid receivedOn date format (YYYY-MM-DD)');
  }

  const today = getCairoToday();
  if (compareDates(receivedOn, today) > 0) {
    throw new AppError(400, 'FUTURE_PAYMENT_DATE', 'Received On cannot be in the future');
  }

  const receivedMonth = getMonthFromDate(receivedOn);
  const currentMonth = getCurrentMonth();
  const previousMonth = getPreviousMonth(currentMonth);
  if (compareMonths(receivedMonth, previousMonth) < 0) {
    throw new AppError(400, 'PAYMENT_DATE_TOO_OLD', 'Received On can only be in the current or previous month');
  }

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      combinationHistories: {
        where: { month: { lte: month } },
        orderBy: { month: 'desc' },
        take: 1,
      },
    },
  });
  if (!student) {
    throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student not found');
  }

  const levelId = student.combinationHistories[0]?.levelId;
  if (!levelId) {
    throw new AppError(400, 'NO_COMBINATION', 'Student has no combination assigned for this month');
  }

  const fee = await getEffectiveFee(levelId, month);
  const subscriptionFee = fee ? fee.subscriptionFee : new Prisma.Decimal(0);

  return prisma.$transaction(async (tx) => {
    // 1. Lock/update billing state to SUBSCRIPTION
    await tx.monthlyBillingState.upsert({
      where: { studentId_month: { studentId, month } },
      update: {
        method: 'SUBSCRIPTION',
        isConfirmed: true,
        confirmedAt: new Date(),
      },
      create: {
        studentId,
        month,
        method: 'SUBSCRIPTION',
        isConfirmed: true,
        confirmedAt: new Date(),
      },
    });

    // 2. Check for existing subscription charge in that month
    const existingSubCharge = await tx.charge.findFirst({
      where: {
        studentId,
        billedMonth: month,
        type: 'SUBSCRIPTION',
        status: { not: 'VOIDED' },
      },
      include: {
        payments: {
          where: { isVoided: false },
        },
      },
    });

    let chargeRecord: any;

    if (existingSubCharge) {
      if (existingSubCharge.status === 'PAID' || (existingSubCharge.payments && existingSubCharge.payments.length > 0)) {
        throw new AppError(400, 'CHARGE_ALREADY_PAID', 'Subscription for this month is already paid');
      }
      chargeRecord = await tx.charge.update({
        where: { id: existingSubCharge.id },
        data: { status: 'PAID' },
      });
    } else {
      chargeRecord = await tx.charge.create({
        data: {
          studentId,
          billedMonth: month,
          type: 'SUBSCRIPTION',
          amount: subscriptionFee,
          source: 'MONTHLY_CONFIRMATION',
          status: 'PAID',
        },
      });
    }

    // 3. Create PaymentGroup and Payment atomically
    const entryTimestamp = new Date();
    const group = await tx.paymentGroup.create({
      data: {
        studentId,
        receivedOn,
        entryTimestamp,
        recordedById,
        totalAmount: chargeRecord.amount,
      },
    });

    const payment = await tx.payment.create({
      data: {
        paymentGroupId: group.id,
        studentId,
        chargeId: chargeRecord.id,
        amount: chargeRecord.amount,
        receivedOn,
        entryTimestamp,
        recordedById,
      },
    });

    return {
      paymentGroup: group,
      payment,
      charge: chargeRecord,
      totalAmount: chargeRecord.amount.toString(),
    };
  });
}

/**
 * Void a payment group (BR-07, PERM-10).
 * Admin only. Voids all payments in the group and returns charges to UNPAID.
 */
export async function voidPaymentGroup(paymentGroupId: string) {
  const group = await prisma.paymentGroup.findUnique({
    where: { id: paymentGroupId },
    include: {
      payments: {
        include: { charge: true },
      },
    },
  });

  if (!group) {
    throw new AppError(404, 'PAYMENT_GROUP_NOT_FOUND', 'Payment group not found');
  }

  if (group.isVoided) {
    throw new AppError(400, 'ALREADY_VOIDED', 'Payment group is already voided');
  }

  const voidedAt = new Date();

  return prisma.$transaction(async (tx) => {
    // 1. Mark PaymentGroup voided
    const updatedGroup = await tx.paymentGroup.update({
      where: { id: paymentGroupId },
      data: {
        isVoided: true,
        voidedAt,
      },
    });

    // 2. Mark each payment voided and return each charge to UNPAID
    for (const p of group.payments) {
      await tx.payment.update({
        where: { id: p.id },
        data: {
          isVoided: true,
          voidedAt,
        },
      });

      await tx.charge.update({
        where: { id: p.chargeId },
        data: {
          status: ChargeStatus.UNPAID,
        },
      });
    }

    return updatedGroup;
  });
}

/**
 * List payment groups for a student or with filters
 */
export async function listPaymentGroups(studentId?: string) {
  return prisma.paymentGroup.findMany({
    where: studentId ? { studentId } : undefined,
    include: {
      student: {
        select: {
          id: true,
          studentNumber: true,
          fullName: true,
        },
      },
      recordedBy: {
        select: { id: true, name: true, username: true },
      },
      payments: {
        include: {
          charge: true,
        },
      },
    },
    orderBy: { entryTimestamp: 'desc' },
  });
}

export async function getPaymentGroupById(id: string) {
  const group = await prisma.paymentGroup.findUnique({
    where: { id },
    include: {
      student: true,
      recordedBy: {
        select: { id: true, name: true, username: true },
      },
      payments: {
        include: {
          charge: true,
        },
      },
    },
  });

  if (!group) {
    throw new AppError(404, 'PAYMENT_GROUP_NOT_FOUND', 'Payment group not found');
  }

  return group;
}
