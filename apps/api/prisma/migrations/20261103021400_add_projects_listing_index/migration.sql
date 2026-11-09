-- CreateIndex
CREATE INDEX "projects_workspace_id_created_at_id_idx" ON "projects"("workspace_id", "created_at" DESC, "id" DESC);

