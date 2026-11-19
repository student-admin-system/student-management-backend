import prisma from '../prisma';
import { AppError } from '../middleware/errorHandler';
import { ChargeStatus, ChargeType } from '@prisma/client';

export interface ListChargesParams {
  studentId?: string;
  billedMonth?: string;
  status?: ChargeStatus;
  type?: ChargeType;
}

export async function listCharges(params: ListChargesParams) {
  const where: any = {};
  if (params.studentId) where.studentId = params.studentId;
  if (params.billedMonth) where.billedMonth = params.billedMonth;
  if (params.status) where.status = params.status;
  if (params.type) where.type = params.type;

  const charges = await prisma.charge.findMany({
    where,
    include: {
      student: {
        select: {
          id: true,
          studentNumber: true,
          fullName: true,
        },
      },
      attendance: {
        include: {
          lesson: {
            include: {
              level: {
                include: { subject: true },
              },
            },
          },
        },
      },
      payments: {
        where: { isVoided: false },
        take: 1,
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return charges.map((c) => ({
    ...c,
    payment: c.payments[0] ?? null,
  }));
}

export async function getChargeById(id: string) {
  const charge = await prisma.charge.findUnique({
    where: { id },
    include: {
      student: true,
      attendance: {
        include: {
          lesson: {
            include: {
              level: {
                include: { subject: true },
              },
            },
          },
        },
      },
      payments: {
        where: { isVoided: false },
        take: 1,
      },
    },
  });

  if (!charge) {
    throw new AppError(404, 'CHARGE_NOT_FOUND', 'Charge not found');
  }

  return {
    ...charge,
    payment: charge.payments[0] ?? null,
  };
}

/**
 * Waive an unpaid charge (BR-22).
 * Admin can waive an entire Unpaid charge.
 * State becomes WAIVED.
 */
export async function waiveCharge(chargeId: string) {
  const charge = await prisma.charge.findUnique({
    where: { id: chargeId },
  });

  if (!charge) {
    throw new AppError(404, 'CHARGE_NOT_FOUND', 'Charge not found');
  }

  if (charge.status === ChargeStatus.VOIDED) {
    throw new AppError(400, 'CHARGE_VOIDED', 'Cannot waive a voided charge');
  }

  if (charge.status === ChargeStatus.PAID) {
    throw new AppError(400, 'CHARGE_PAID', 'Cannot waive a paid charge');
  }

  if (charge.status === ChargeStatus.WAIVED) {
    throw new AppError(400, 'CHARGE_ALREADY_WAIVED', 'Charge is already waived');
  }

  return prisma.charge.update({
    where: { id: chargeId },
    data: {
      status: ChargeStatus.WAIVED,
      waivedAt: new Date(),
    },
  });
}
