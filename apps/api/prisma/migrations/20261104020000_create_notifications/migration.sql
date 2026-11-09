-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('TASK_ASSIGNED', 'TASK_COMMENTED', 'TASK_REMINDER');

-- CreateEnum
CREATE TYPE "notification_resource_type" AS ENUM ('TASK', 'PROJECT', 'WORKSPACE');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_id" UUID,
    "type" "notification_type" NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "resource_type" "notification_resource_type" NOT NULL,
    "resource_id" UUID NOT NULL,
    "event_key" VARCHAR(200) NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_inbox_idx" ON "notifications"("recipient_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "notifications_unread_idx" ON "notifications"("recipient_id", "created_at" DESC, "id" DESC) WHERE ("is_read" = false);

-- CreateIndex
CREATE INDEX "notifications_workspace_id_created_at_idx" ON "notifications"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_actor_id_idx" ON "notifications"("actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_recipient_event_key" ON "notifications"("recipient_id", "event_key");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: reminders already delivered before this table existed (Step 18's
-- inbox read them from task_reminders) become notifications, keeping their read
-- state. Insert-only; task_reminders is not modified. Same wording as the API
-- (notification-messages.ts) and the same event key, so it can never duplicate.
INSERT INTO "notifications" ("id", "recipient_id", "workspace_id", "type", "title", "message",
                             "resource_type", "resource_id", "event_key", "is_read", "created_at", "read_at")
SELECT r."id", r."recipient_id", p."workspace_id", 'TASK_REMINDER', 'Task due soon',
       CASE WHEN t."due_date" IS NULL THEN 'Reminder for “' || t."title" || '”.'
            ELSE '“' || t."title" || '” is due ' ||
                 to_char(t."due_date" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC.' END,
       'TASK', t."id", 'reminder:' || r."id", r."read_at" IS NOT NULL,
       COALESCE(r."sent_at", r."created_at"), r."read_at"
FROM "task_reminders" r
JOIN "tasks" t ON t."id" = r."task_id"
JOIN "projects" p ON p."id" = t."project_id"
WHERE r."status" = 'SENT' AND r."recipient_id" IS NOT NULL
ON CONFLICT DO NOTHING;
