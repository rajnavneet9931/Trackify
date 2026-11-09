-- CreateEnum
CREATE TYPE "date_format" AS ENUM ('LOCALE', 'ISO', 'DMY', 'MDY');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "name" VARCHAR(100);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "time_zone" VARCHAR(64),
    "date_format" "date_format" NOT NULL DEFAULT 'LOCALE',
    "notify_task_assigned" BOOLEAN NOT NULL DEFAULT true,
    "notify_task_commented" BOOLEAN NOT NULL DEFAULT true,
    "notify_task_reminder" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

