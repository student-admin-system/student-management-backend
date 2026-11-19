-- Step 1: Create student number sequence and configure default
CREATE SEQUENCE IF NOT EXISTS student_number_seq;
SELECT setval('student_number_seq', COALESCE((SELECT MAX("studentNumber") FROM "students"), 0) + 1, false);
ALTER TABLE "students" ALTER COLUMN "studentNumber" SET DEFAULT nextval('student_number_seq'::regclass);

-- Step 2: Add normalizedName column to students, backfill and index
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "normalizedName" TEXT NOT NULL DEFAULT '';

UPDATE "students" SET "normalizedName" = regexp_replace(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          "fullName",
          '[\u064B-\u065F\u0670]', '', 'g'
        ),
        '[أإآ]', 'ا', 'g'
      ),
      'ة', 'ه', 'g'
    ),
    'ى', 'ي', 'g'
  ),
  '\s+', ' ', 'g'
);

CREATE INDEX IF NOT EXISTS "students_normalizedName_idx" ON "students"("normalizedName");

-- Step 3: Remove Groups (BR-16 in v2.0)
ALTER TABLE "attendances" DROP CONSTRAINT IF EXISTS "attendances_groupId_fkey";
ALTER TABLE "attendances" DROP COLUMN IF EXISTS "groupId";
DROP TABLE IF EXISTS "groups";

-- Step 4: Payments partial unique index (allow re-paying voided charges while preventing active double-payment)
DROP INDEX IF EXISTS "payments_chargeId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "payments_chargeId_active_key" ON "payments"("chargeId") WHERE "isVoided" = false;
CREATE INDEX IF NOT EXISTS "payments_chargeId_idx" ON "payments"("chargeId");

-- Step 5: Attendances partial unique index (prevent double-clicks while allowing re-entry after void)
CREATE UNIQUE INDEX IF NOT EXISTS "attendances_studentId_lessonId_active_key" ON "attendances"("studentId", "lessonId") WHERE "isVoided" = false;
CREATE INDEX IF NOT EXISTS "attendances_studentId_lessonId_idx" ON "attendances"("studentId", "lessonId");
