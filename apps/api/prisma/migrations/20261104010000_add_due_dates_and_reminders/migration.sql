-- CreateEnum
CREATE TYPE "reminder_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "due_date" TIMESTAMPTZ(3),
ADD COLUMN     "reminder_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "task_reminders" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "recipient_id" UUID,
    "remind_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "reminder_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "sent_at" TIMESTAMPTZ(3),
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_reminders_pending_due_idx" ON "task_reminders"("remind_at") WHERE ("status" = 'PENDING');

-- CreateIndex
CREATE INDEX "task_reminders_inbox_idx" ON "task_reminders"("recipient_id", "sent_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "task_reminders_task_id_created_at_idx" ON "task_reminders"("task_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "task_reminders_one_pending_key" ON "task_reminders"("task_id") WHERE ("status" = 'PENDING');

-- CreateIndex
CREATE INDEX "tasks_due_date_idx" ON "tasks"("due_date");

-- AddForeignKey
ALTER TABLE "task_reminders" ADD CONSTRAINT "task_reminders_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reminders" ADD CONSTRAINT "task_reminders_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
