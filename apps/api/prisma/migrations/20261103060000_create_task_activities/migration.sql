-- CreateEnum
CREATE TYPE "task_activity_type" AS ENUM ('TASK_CREATED', 'TASK_UPDATED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'ASSIGNEE_CHANGED', 'COMMENT_ADDED', 'COMMENT_EDITED', 'COMMENT_DELETED');

-- CreateTable
CREATE TABLE "task_activities" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID,
    "type" "task_activity_type" NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_activities_task_id_created_at_id_idx" ON "task_activities"("task_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "task_activities_user_id_idx" ON "task_activities"("user_id");

-- AddForeignKey
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
