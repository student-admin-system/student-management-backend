import prisma from '../prisma';
import { AppError } from '../middleware/errorHandler';
import {
  getCairoToday,
  getCurrentMonth,
  getMonthFromDate,
  getPreviousMonth,
  compareDates,
  compareMonths,
  formatCairoDate,
} from '../utils/date';
import { getEffectiveFee } from './feeService';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types & Helpers
// ---------------------------------------------------------------------------

export type BillingAction = 'PAY_PER_LESSON' | 'ATTEND_UNPAID' | 'PAY_SUBSCRIPTION';

export interface RecordAttendanceInput {
  studentId: string;
  lessonDate: string; // YYYY-MM-DD
  levelId: string;
  billingAction?: BillingAction;
  paidForLesson?: boolean; // backwards compatibility alias for PAY_PER_LESSON
  recordedById: string;
}

/** Get a student's combination (levelId) for a given month. */
async function getStudentLevelForMonth(
  studentId: string,
  month: string
): Promise<string | null> {
  const history = await prisma.studentCombinationHistory.findFirst({
    where: {
      studentId,
      month: { lte: month },
    },
    orderBy: { month: 'desc' },
  });
  return history?.levelId ?? null;
}

/** Check if student was Active on a given date (YYYY-MM-DD). */
async function wasStudentActiveOnDate(studentId: string, date: string): Promise<boolean> {
  const statusEntry = await prisma.studentStatusHistory.findFirst({
    where: {
      studentId,
      effectiveDate: { lte: date },
    },
    orderBy: { effectiveDate: 'desc' },
  });

  if (!statusEntry) return false;
  return statusEntry.status === 'ACTIVE';
}

/** Compute dynamic sequential lesson number within the Gregorian month for a level */
export async function getMonthlyLessonNumber(levelId: string, date: string): Promise<number> {
  const month = getMonthFromDate(date);
  const count = await prisma.lesson.count({
    where: {
      levelId,
      date: {
        gte: `${month}-01`,
        lte: date,
      },
    },
  });
  return count;
}

// ---------------------------------------------------------------------------
// recordAttendance (BR-02 Streamlined Attendance & Billing in v2.0)
// ---------------------------------------------------------------------------

export async function recordAttendance(data: RecordAttendanceInput) {
  const today = getCairoToday();
  const currentMonth = getCurrentMonth();
  const previousMonth = getPreviousMonth(currentMonth);

  // BR-18.1: No future dates
  if (compareDates(data.lessonDate, today) > 0) {
    throw new AppError(400, 'FUTURE_DATE', 'Attendance cannot be recorded for future dates');
  }

  // BR-18.2: Date must be within current or previous month
  const lessonMonth = getMonthFromDate(data.lessonDate);
  if (compareMonths(lessonMonth, previousMonth) < 0) {
    throw new AppError(
      400,
      'DATE_TOO_OLD',
      'Attendance can only be recorded for the current or previous month'
    );
  }

  // Load student
  const student = await prisma.student.findUnique({
    where: { id: data.studentId },
    select: { id: true, fullName: true, status: true, enrollmentDate: true },
  });
  if (!student) throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student not found');

  // BR-18.4 / BR-11.3: Student must be Active when attendance is recorded
  if (student.status !== 'ACTIVE') {
    throw new AppError(400, 'STUDENT_INACTIVE', 'Student is not Active. Reactivate before recording attendance.');
  }

  // BR-20: Must have been enrolled on or before the lesson date
  if (compareDates(student.enrollmentDate, data.lessonDate) > 0) {
    throw new AppError(
      400,
      'BEFORE_ENROLLMENT',
      `Attendance date is before the student's enrollment date (${student.enrollmentDate})`
    );
  }

  // BR-20: Must have been Active on the lesson date
  const wasActive = await wasStudentActiveOnDate(student.id, data.lessonDate);
  if (!wasActive) {
    throw new AppError(
      400,
      'INACTIVE_ON_DATE',
      'The student was Inactive on the specified date. Attendance is not allowed for inactive periods.'
    );
  }

  // BR-13: Combination must match student's combination for the lesson month
  const studentLevelId = await getStudentLevelForMonth(student.id, lessonMonth);
  if (!studentLevelId) {
    throw new AppError(
      400,
      'NO_COMBINATION',
      'Student has no combination assigned for this month'
    );
  }

  if (studentLevelId !== data.levelId) {
    const [studentLevel, lessonLevel] = await Promise.all([
      prisma.level.findUnique({ where: { id: studentLevelId }, include: { subject: true } }),
      prisma.level.findUnique({ where: { id: data.levelId }, include: { subject: true } }),
    ]);
    const studentCombo = studentLevel
      ? `${studentLevel.subject.name} - ${studentLevel.name}`
      : studentLevelId;
    const lessonCombo = lessonLevel
      ? `${lessonLevel.subject.name} - ${lessonLevel.name}`
      : data.levelId;
    throw new AppError(
      400,
      'COMBINATION_MISMATCH',
      `Student's combination (${studentCombo}) does not match the lesson's combination (${lessonCombo})`
    );
  }

  // Find or create lesson (BR-15: unique by levelId + date)
  const lesson = await prisma.lesson.upsert({
    where: { levelId_date: { levelId: data.levelId, date: data.lessonDate } },
    update: {},
    create: { levelId: data.levelId, date: data.lessonDate },
  });

  // BR-15: At most one attendance per student per lesson
  const existingAttendance = await prisma.attendance.findFirst({
    where: {
      studentId: student.id,
      lessonId: lesson.id,
      isVoided: false,
    },
  });

  if (existingAttendance) {
    throw new AppError(
      409,
      'DUPLICATE_ATTENDANCE',
      'Student is already recorded for this lesson'
    );
  }

  // Determine effective billing action (BR-02 in v2.0)
  // Default is 'PAY_PER_LESSON' unless specified
  let resolvedAction: BillingAction = 'PAY_PER_LESSON';
  if (data.billingAction) {
    resolvedAction = data.billingAction;
  } else if (data.paidForLesson === false) {
    resolvedAction = 'ATTEND_UNPAID';
  }

  // Atomic transaction: Attendance + Billing/Payment
  const result = await prisma.$transaction(async (tx) => {
    // 1. Create Attendance record
    const att = await tx.attendance.create({
      data: {
        studentId: student.id,
        lessonId: lesson.id,
        recordedById: data.recordedById,
      },
    });

    // 2. Fetch fees for combination and month
    const fee = await getEffectiveFee(data.levelId, lessonMonth);
    const perLessonFee = fee ? fee.perLessonFee : new Prisma.Decimal(0);
    const subscriptionFee = fee ? fee.subscriptionFee : new Prisma.Decimal(0);

    // 3. Check monthly billing state
    let billingState = await tx.monthlyBillingState.findUnique({
      where: { studentId_month: { studentId: student.id, month: lessonMonth } },
    });

    let billingResult:
      | 'CHARGE_CREATED'
      | 'CHARGE_CREATED_AND_PAID'
      | 'SUBSCRIPTION_COVERED'
      | 'SUBSCRIPTION_PAID' = 'CHARGE_CREATED_AND_PAID';

    let chargeRecord: any = null;
    let paymentGroupRecord: any = null;
    let paymentRecord: any = null;
    let note: string | null = null;
    const entryTimestamp = new Date();

    if (!billingState || !billingState.isConfirmed) {
      // ---------------------------------------------------------------------
      // Case 1: First attendance in month (BR-02.1)
      // ---------------------------------------------------------------------
      if (resolvedAction === 'PAY_SUBSCRIPTION') {
        // Lock to SUBSCRIPTION
        await tx.monthlyBillingState.upsert({
          where: { studentId_month: { studentId: student.id, month: lessonMonth } },
          update: { method: 'SUBSCRIPTION', isConfirmed: true, confirmedAt: entryTimestamp },
          create: {
            studentId: student.id,
            month: lessonMonth,
            method: 'SUBSCRIPTION',
            isConfirmed: true,
            confirmedAt: entryTimestamp,
          },
        });

        // Create PAID Subscription charge
        chargeRecord = await tx.charge.create({
          data: {
            studentId: student.id,
            billedMonth: lessonMonth,
            type: 'SUBSCRIPTION',
            amount: subscriptionFee,
            source: 'MONTHLY_CONFIRMATION',
            status: 'PAID',
          },
        });

        // Create PaymentGroup & Payment atomically
        paymentGroupRecord = await tx.paymentGroup.create({
          data: {
            studentId: student.id,
            receivedOn: data.lessonDate,
            entryTimestamp,
            recordedById: data.recordedById,
            totalAmount: subscriptionFee,
          },
        });

        paymentRecord = await tx.payment.create({
          data: {
            paymentGroupId: paymentGroupRecord.id,
            studentId: student.id,
            chargeId: chargeRecord.id,
            amount: subscriptionFee,
            receivedOn: data.lessonDate,
            entryTimestamp,
            recordedById: data.recordedById,
          },
        });

        billingResult = 'SUBSCRIPTION_PAID';
        note = 'تم قفل الشهر بنظام الاشتراك الشهري وسداد الاشتراك مع تسجيل الحضور بنجاح.';
      } else if (resolvedAction === 'ATTEND_UNPAID') {
        // Lock to PER_LESSON
        await tx.monthlyBillingState.upsert({
          where: { studentId_month: { studentId: student.id, month: lessonMonth } },
          update: { method: 'PER_LESSON', isConfirmed: true, confirmedAt: entryTimestamp },
          create: {
            studentId: student.id,
            month: lessonMonth,
            method: 'PER_LESSON',
            isConfirmed: true,
            confirmedAt: entryTimestamp,
          },
        });

        // Create UNPAID Per-Lesson charge
        chargeRecord = await tx.charge.create({
          data: {
            studentId: student.id,
            billedMonth: lessonMonth,
            type: 'PER_LESSON',
            amount: perLessonFee,
            source: 'ATTENDANCE',
            attendanceId: att.id,
            status: 'UNPAID',
          },
        });

        billingResult = 'CHARGE_CREATED';
        note = 'تم قفل الشهر بنظام الحصة الواحدة وتسجيل الحضور، ورسم الحصة مستحق للدفع لاحقاً.';
      } else {
        // Default: PAY_PER_LESSON
        // Lock to PER_LESSON
        await tx.monthlyBillingState.upsert({
          where: { studentId_month: { studentId: student.id, month: lessonMonth } },
          update: { method: 'PER_LESSON', isConfirmed: true, confirmedAt: entryTimestamp },
          create: {
            studentId: student.id,
            month: lessonMonth,
            method: 'PER_LESSON',
            isConfirmed: true,
            confirmedAt: entryTimestamp,
          },
        });

        // Create PAID Per-Lesson charge
        chargeRecord = await tx.charge.create({
          data: {
            studentId: student.id,
            billedMonth: lessonMonth,
            type: 'PER_LESSON',
            amount: perLessonFee,
            source: 'ATTENDANCE',
            attendanceId: att.id,
            status: 'PAID',
          },
        });

        paymentGroupRecord = await tx.paymentGroup.create({
          data: {
            studentId: student.id,
            receivedOn: data.lessonDate,
            entryTimestamp,
            recordedById: data.recordedById,
            totalAmount: perLessonFee,
          },
        });

        paymentRecord = await tx.payment.create({
          data: {
            paymentGroupId: paymentGroupRecord.id,
            studentId: student.id,
            chargeId: chargeRecord.id,
            amount: perLessonFee,
            receivedOn: data.lessonDate,
            entryTimestamp,
            recordedById: data.recordedById,
          },
        });

        billingResult = 'CHARGE_CREATED_AND_PAID';
        note = 'تم تسجيل الحضور وسداد رسوم الحصة فورياً بنجاح.';
      }
    } else {
      // ---------------------------------------------------------------------
      // Case 2: Subsequent attendance in already locked month (BR-02.2)
      // ---------------------------------------------------------------------
      if (billingState.method === 'SUBSCRIPTION') {
        billingResult = 'SUBSCRIPTION_COVERED';
        note = 'الحصة مشمولة ضمن الاشتراك الشهري المسجل.';
      } else {
        // Method is PER_LESSON
        if (resolvedAction === 'ATTEND_UNPAID') {
          chargeRecord = await tx.charge.create({
            data: {
              studentId: student.id,
              billedMonth: lessonMonth,
              type: 'PER_LESSON',
              amount: perLessonFee,
              source: 'ATTENDANCE',
              attendanceId: att.id,
              status: 'UNPAID',
            },
          });
          billingResult = 'CHARGE_CREATED';
          note = 'تم تسجيل الحضور، ورسم الحصة مستحق للدفع لاحقاً.';
        } else {
          // Default: PAY_PER_LESSON
          chargeRecord = await tx.charge.create({
            data: {
              studentId: student.id,
              billedMonth: lessonMonth,
              type: 'PER_LESSON',
              amount: perLessonFee,
              source: 'ATTENDANCE',
              attendanceId: att.id,
              status: 'PAID',
            },
          });

          paymentGroupRecord = await tx.paymentGroup.create({
            data: {
              studentId: student.id,
              receivedOn: data.lessonDate,
              entryTimestamp,
              recordedById: data.recordedById,
              totalAmount: perLessonFee,
            },
          });

          paymentRecord = await tx.payment.create({
            data: {
              paymentGroupId: paymentGroupRecord.id,
              studentId: student.id,
              chargeId: chargeRecord.id,
              amount: perLessonFee,
              receivedOn: data.lessonDate,
              entryTimestamp,
              recordedById: data.recordedById,
            },
          });

          billingResult = 'CHARGE_CREATED_AND_PAID';
          note = 'تم تسجيل الحضور وسداد رسوم الحصة فورياً بنجاح.';
        }
      }
    }

    return {
      attendance: att,
      billingResult,
      charge: chargeRecord,
      paymentGroup: paymentGroupRecord,
      payment: paymentRecord,
      note,
    };
  });

  const level = await prisma.level.findUnique({
    where: { id: data.levelId },
    include: { subject: true },
  });

  const lessonNumber = await getMonthlyLessonNumber(data.levelId, data.lessonDate);

  return {
    attendance: result.attendance,
    billingResult: result.billingResult,
    charge: result.charge,
    paymentGroup: result.paymentGroup,
    payment: result.payment,
    note: result.note,
    studentName: student.fullName,
    combination: level ? `${level.subject.name} - ${level.name}` : data.levelId,
    lessonDate: data.lessonDate,
    lessonNumber,
  };
}

// ---------------------------------------------------------------------------
// voidAttendance (BR-06, BR-07, PERM-08 with Africa/Cairo timezone check)
// ---------------------------------------------------------------------------

export async function voidAttendance(
  attendanceId: string,
  requestingUserId: string,
  requestingUserRole: 'ADMIN' | 'ASSISTANT'
) {
  const attendance = await prisma.attendance.findUnique({
    where: { id: attendanceId },
    include: {
      lesson: true,
      student: true,
      charges: {
        where: { status: { not: 'VOIDED' } },
        include: {
          payments: {
            where: { isVoided: false },
          },
        },
      },
    },
  });

  if (!attendance) throw new AppError(404, 'ATTENDANCE_NOT_FOUND', 'Attendance not found');
  if (attendance.isVoided) throw new AppError(400, 'ALREADY_VOIDED', 'Attendance is already voided');

  // PERM-08: Assistant can only void own entries, same day (Africa/Cairo), charge not Paid
  if (requestingUserRole === 'ASSISTANT') {
    if (attendance.recordedById !== requestingUserId) {
      throw new AppError(403, 'FORBIDDEN', 'Assistants can only void their own attendance entries');
    }
    const entryDateCairo = formatCairoDate(attendance.entryTimestamp);
    const todayCairo = getCairoToday();
    if (entryDateCairo !== todayCairo) {
      throw new AppError(403, 'FORBIDDEN', 'Assistants can only void attendance recorded today');
    }
  }

  // Check for Per-Lesson charges
  const perLessonCharges = attendance.charges.filter((c) => c.type === 'PER_LESSON');

  // BR-07: If any charge is Paid, cannot void attendance without voiding payment group first
  for (const charge of perLessonCharges) {
    if (charge.status === 'PAID' || (charge.payments && charge.payments.length > 0)) {
      throw new AppError(
        400,
        'CHARGE_PAID',
        'Cannot void attendance because the Per-Lesson charge is Paid. Void the payment group first.'
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    // Void attendance
    await tx.attendance.update({
      where: { id: attendanceId },
      data: { isVoided: true, voidedAt: new Date() },
    });

    // BR-06: Void Per-Lesson charges that are Unpaid or Waived
    for (const charge of perLessonCharges) {
      if (charge.status === 'UNPAID' || charge.status === 'WAIVED') {
        await tx.charge.update({
          where: { id: charge.id },
          data: { status: 'VOIDED', voidedAt: new Date() },
        });
      }
    }
  });

  return { voided: true };
}

// ---------------------------------------------------------------------------
// getLessonAttendance — get attendees and absent list for a specific lesson
// ---------------------------------------------------------------------------

export async function getLessonAttendance(levelId: string, date: string) {
  const lesson = await prisma.lesson.findUnique({
    where: { levelId_date: { levelId, date } },
    include: {
      level: { include: { subject: true } },
      attendances: {
        where: { isVoided: false },
        include: {
          student: true,
          recordedBy: { select: { id: true, name: true } },
        },
        orderBy: { entryTimestamp: 'asc' },
      },
    },
  });

  const lessonNumber = await getMonthlyLessonNumber(levelId, date);

  if (!lesson) {
    return {
      lesson: null,
      lessonNumber,
      attendances: [],
      informationalAbsentList: [],
      levelId,
      date,
    };
  }

  // D7: Informational list — students Active on that date in that combination,
  // enrolled on or before it, with no non-voided attendance in that lesson
  const lessonMonth = getMonthFromDate(date);
  const studentsWithCombo = await prisma.student.findMany({
    where: {
      combinationHistories: {
        some: { levelId, month: { lte: lessonMonth } },
      },
    },
    include: {
      combinationHistories: {
        where: { month: { lte: lessonMonth } },
        orderBy: { month: 'desc' },
        take: 1,
      },
      statusHistories: {
        where: { effectiveDate: { lte: date } },
        orderBy: { effectiveDate: 'desc' },
        take: 1,
      },
    },
  });

  const attendedStudentIds = new Set(lesson.attendances.map((a) => a.studentId));

  const absentStudents = studentsWithCombo.filter((s) => {
    const latestCombo = s.combinationHistories[0];
    if (!latestCombo || latestCombo.levelId !== levelId) return false;
    const latestStatus = s.statusHistories[0];
    if (!latestStatus || latestStatus.status !== 'ACTIVE') return false;
    if (compareDates(s.enrollmentDate, date) > 0) return false;
    return !attendedStudentIds.has(s.id);
  });

  return {
    lesson,
    lessonNumber,
    attendances: lesson.attendances,
    informationalAbsentList: absentStudents.map((s) => ({
      id: s.id,
      studentNumber: s.studentNumber,
      fullName: s.fullName,
    })),
  };
}

// ---------------------------------------------------------------------------
// getStudentAttendanceReport — FR-RPT-03 in v2.0
// Shows all lessons held for student's combination while enrolled and Active,
// marked as Present or Absent, with dynamic sequential lesson numbering (1, 2, 3...)
// and summary counts (totalAttended, totalAbsent, totalHeld)
// ---------------------------------------------------------------------------

export async function getStudentAttendanceReport(studentId: string) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      combinationHistories: {
        include: { level: { include: { subject: true } } },
        orderBy: { month: 'asc' },
      },
      statusHistories: {
        orderBy: { effectiveDate: 'asc' },
      },
      attendances: {
        where: { isVoided: false },
        include: {
          lesson: {
            include: { level: { include: { subject: true } } },
          },
          recordedBy: { select: { id: true, name: true } },
        },
        orderBy: { entryTimestamp: 'asc' },
      },
    },
  });

  if (!student) {
    throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student not found');
  }

  // Find all lessons for all combinations the student had on/after enrollmentDate
  const allCombinations = student.combinationHistories;
  if (allCombinations.length === 0) {
    return {
      student: {
        id: student.id,
        studentNumber: student.studentNumber,
        fullName: student.fullName,
        enrollmentDate: student.enrollmentDate,
        status: student.status,
      },
      summary: {
        totalHeld: 0,
        totalAttended: 0,
        totalAbsent: 0,
      },
      lessons: [],
    };
  }

  // Load all lessons held on or after student's enrollmentDate up to Cairo today
  const today = getCairoToday();
  const allHeldLessons = await prisma.lesson.findMany({
    where: {
      date: {
        gte: student.enrollmentDate,
        lte: today,
      },
    },
    include: {
      level: { include: { subject: true } },
    },
    orderBy: { date: 'asc' },
  });

  const attendedLessonMap = new Map<string, any>();
  for (const att of student.attendances) {
    attendedLessonMap.set(att.lessonId, att);
  }

  // Helper to resolve student level for a given month
  const getLevelIdForMonth = (month: string): string | null => {
    let resolved: string | null = null;
    for (const ch of student.combinationHistories) {
      if (ch.month <= month) {
        resolved = ch.levelId;
      }
    }
    return resolved;
  };

  // Helper to check if student was active on a date
  const isActiveOnDate = (date: string): boolean => {
    let status = 'INACTIVE';
    for (const sh of student.statusHistories) {
      if (sh.effectiveDate <= date) {
        status = sh.status;
      }
    }
    return status === 'ACTIVE';
  };

  // Group lessons by level and month to compute dynamic lesson numbers (1, 2, 3...)
  const lessonsWithStatus = [];
  let totalAttended = 0;
  let totalAbsent = 0;

  for (const lesson of allHeldLessons) {
    const lessonMonth = getMonthFromDate(lesson.date);
    const applicableLevelId = getLevelIdForMonth(lessonMonth);

    // Only consider lessons of the student's applicable combination in that month
    if (applicableLevelId !== lesson.levelId) {
      continue;
    }

    // Must have been Active on that date and enrolled on or before that date
    if (compareDates(student.enrollmentDate, lesson.date) > 0 || !isActiveOnDate(lesson.date)) {
      continue;
    }

    // Dynamic lesson numbering: count distinct lessons for this level in this month on or before this date
    const monthlyLessonNumber = await prisma.lesson.count({
      where: {
        levelId: lesson.levelId,
        date: {
          gte: `${lessonMonth}-01`,
          lte: lesson.date,
        },
      },
    });

    const attendedEntry = attendedLessonMap.get(lesson.id);
    const isPresent = !!attendedEntry;

    if (isPresent) {
      totalAttended++;
    } else {
      totalAbsent++;
    }

    lessonsWithStatus.push({
      lessonId: lesson.id,
      date: lesson.date,
      month: lessonMonth,
      monthlyLessonNumber,
      combination: `${lesson.level.subject.name} - ${lesson.level.name}`,
      levelId: lesson.levelId,
      status: isPresent ? ('PRESENT' as const) : ('ABSENT' as const),
      statusLabel: isPresent ? 'حاضر' : 'غائب',
      attendanceId: attendedEntry?.id ?? null,
      recordedBy: attendedEntry?.recordedBy?.name ?? null,
      entryTimestamp: attendedEntry?.entryTimestamp ?? null,
    });
  }

  return {
    student: {
      id: student.id,
      studentNumber: student.studentNumber,
      fullName: student.fullName,
      enrollmentDate: student.enrollmentDate,
      status: student.status,
    },
    summary: {
      totalHeld: totalAttended + totalAbsent,
      totalAttended,
      totalAbsent,
    },
    lessons: lessonsWithStatus,
  };
}
