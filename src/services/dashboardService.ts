import prisma from '../prisma';
import { getCairoToday, getCurrentMonth, getCairoDayBounds } from '../utils/date';
import { getUnconfirmedBillingList } from './billingService';
import { ChargeStatus, Prisma } from '@prisma/client';

export async function getAdminDashboard() {
  const today = getCairoToday();
  const currentMonth = getCurrentMonth();

  const { start: startOfDay, end: endOfDay } = getCairoDayBounds(today);

  const [attendanceCount, unconfirmedList, unpaidCharges, todayPayments, businessSetting, activeStudentsCount] = await Promise.all([
    // Attendance entered today
    prisma.attendance.count({
      where: {
        isVoided: false,
        entryTimestamp: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    }),

    // Students with unconfirmed billing (D5)
    getUnconfirmedBillingList(currentMonth),

    // Total outstanding balance across all students
    prisma.charge.findMany({
      where: {
        status: ChargeStatus.UNPAID,
      },
      select: {
        amount: true,
      },
    }),

    // Collections recorded today
    prisma.payment.findMany({
      where: {
        isVoided: false,
        entryTimestamp: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      select: {
        amount: true,
      },
    }),

    // Business Name setting
    prisma.setting.findUnique({
      where: { key: 'businessName' },
    }),

    // Active students count
    prisma.student.count({
      where: { status: 'ACTIVE' },
    }),
  ]);

  const businessName = businessSetting?.value || 'الأستاذ أحمد فوزي';

  const totalOutstanding = unpaidCharges.reduce(
    (sum, c) => sum.add(c.amount),
    new Prisma.Decimal(0)
  );

  const todayCollections = todayPayments.reduce(
    (sum, p) => sum.add(p.amount),
    new Prisma.Decimal(0)
  );

  return {
    today,
    businessName,
    activeStudentsCount,
    attendanceTodayCount: attendanceCount,
    todayAttendanceCount: attendanceCount,
    unconfirmedBillingCount: unconfirmedList.length,
    totalOutstanding: totalOutstanding.toString(),
    totalOutstandingBalance: totalOutstanding.toString(),
    todayCollections: todayCollections.toString(),
    todayCollectionsAmount: todayCollections.toString(),
  };
}

export async function getAssistantDashboard(userId: string) {
  const today = getCairoToday();
  const { start: startOfDay, end: endOfDay } = getCairoDayBounds(today);

  const [attendanceCount, todayPayments, businessSetting, activeStudentsCount] = await Promise.all([
    // Attendance they entered today
    prisma.attendance.count({
      where: {
        isVoided: false,
        recordedById: userId,
        entryTimestamp: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    }),

    // Collections they recorded today
    prisma.payment.findMany({
      where: {
        isVoided: false,
        recordedById: userId,
        entryTimestamp: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      select: {
        amount: true,
      },
    }),

    // Business Name setting
    prisma.setting.findUnique({
      where: { key: 'businessName' },
    }),

    // Active students count
    prisma.student.count({
      where: { status: 'ACTIVE' },
    }),
  ]);

  const businessName = businessSetting?.value || 'الأستاذ أحمد فوزي';

  const todayCollections = todayPayments.reduce(
    (sum, p) => sum.add(p.amount),
    new Prisma.Decimal(0)
  );

  return {
    today,
    businessName,
    activeStudentsCount,
    attendanceTodayCount: attendanceCount,
    todayAttendanceCount: attendanceCount,
    todayCollections: todayCollections.toString(),
    todayCollectionsAmount: todayCollections.toString(),
  };
}
