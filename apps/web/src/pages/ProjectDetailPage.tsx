import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { useAuth } from '../features/auth/auth-context';
import { EditProjectForm } from '../features/projects/EditProjectForm';
import { ProjectManagement } from '../features/projects/ProjectManagement';
import { ProjectStatusBadge } from '../features/projects/ProjectStatusBadge';
import type { Project } from '../features/projects/projects.api';
import { useProjectDetail } from '../features/projects/useProjectDetail';
import { ProjectTasks } from '../features/tasks/ProjectTasks';
import { useWorkspaceDetail } from '../features/workspaces/useWorkspaceDetail';
import { useDateTime } from '../features/account/preferences-context';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingState } from '../components/ui/States';
import { buttonClass, linkClass } from '../components/ui/styles';
import { WorkspaceNav } from '../features/workspaces/WorkspaceNav';

function BackLink({ workspaceId, name }: { workspaceId: string; name?: string }) {
  return (
    <Link to={`/workspaces/${workspaceId}`} className={linkClass}>
      ← {name ? `Back to ${name}` : 'Back to workspace'}
    </Link>
  );
}

function Notice({
  title,
  workspaceId,
  children,
}: {
  title: string;
  workspaceId: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <div className="mt-2 text-slate-600">{children}</div>
      <div className="mt-6">
        <BackLink workspaceId={workspaceId} />
      </div>
    </div>
  );
}

/**
 * One project (only reachable through <RequireAuth>). Every member sees it,
 * archived or not; owners also get edit/archive/restore/delete controls. The
 * workspace is loaded alongside for its name and the viewer's role.
 */
export function ProjectDetailPage() {
  const dt = useDateTime();
  const { workspaceId = '', projectId = '' } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const workspace = useWorkspaceDetail(workspaceId);
  const project = useProjectDetail(workspaceId, projectId);
  const [editing, setEditing] = useState<string | null>(null); // id of the project being edited
  const [notice, setNotice] = useState<{ projectId: string; text: string }>();

  const retry = () => {
    if (workspace.state.status !== 'ready') workspace.retry();
    project.retry();
  };

  const states = [workspace.state.status, project.state.status];
  if (states.includes('loading')) {
    return (
      <div className="mx-auto max-w-5xl">
        <LoadingState label="Loading project…" rows={3} />
      </div>
    );
  }

  // A workspace the user cannot open looks exactly like a missing project.
  if (states.includes('not-found')) {
    return (
      <Notice title="Project not found" workspaceId={workspaceId}>
        <p>This project doesn’t exist, or you don’t have access to it.</p>
      </Notice>
    );
  }

  if (states.includes('forbidden')) {
    return (
      <Notice title="No access" workspaceId={workspaceId}>
        <p>You don’t have permission to view this project.</p>
      </Notice>
    );
  }

  if (workspace.state.status !== 'ready' || project.state.status !== 'ready') {
    const message =
      project.state.status === 'error'
        ? project.state.message
        : workspace.state.status === 'error'
          ? workspace.state.message
          : 'Something went wrong. Please try again.';
    return (
      <div role="alert" className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Can’t load this project</h1>
        <p className="mt-2 text-slate-600">{message}</p>
        <button
          type="button"
          onClick={retry}
          className="mt-6 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Try again
        </button>
        <div className="mt-4">
          <BackLink workspaceId={workspaceId} />
        </div>
      </div>
    );
  }

  const { workspace: ws, membership } = workspace.state.detail;
  const { project: current, creator } = project.state.detail;
  const isOwner = membership.role === 'OWNER';
  const archived = current.status === 'ARCHIVED';
  const isEditing = isOwner && !archived && editing === current.id;
  const currentUserId = session.status === 'authenticated' ? session.user.id : '';
  const showNotice = notice?.projectId === current.id ? notice.text : undefined;

  const applyChange = (updated: Project, text: string) => {
    project.replaceProject(updated);
    setNotice({ projectId: updated.id, text });
  };

  const startEditing = () => {
    setNotice(undefined);
    setEditing(current.id);
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        crumbs={[
          { label: 'Workspaces', to: '/workspaces' },
          { label: ws.name, to: `/workspaces/${ws.id}` },
          { label: 'Projects', to: `/workspaces/${ws.id}/projects` },
          { label: current.name },
        ]}
        title={current.name}
        documentTitle={`${current.name} · ${ws.name}`}
        badge={<ProjectStatusBadge status={current.status} />}
        actions={
          // UX only: the API independently refuses every mutation from non-owners.
          isOwner && !archived && !isEditing ? (
            <button type="button" onClick={startEditing} className={buttonClass('secondary')}>
              Edit project
            </button>
          ) : undefined
        }
        tabs={<WorkspaceNav workspaceId={ws.id} />}
      />

      {showNotice && (
        <p
          role="status"
          className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {showNotice}
        </p>
      )}

      {archived && (
        <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          This project is archived and read-only.
          {isOwner ? ' Restore it in Project settings below to make changes.' : ''}
        </p>
      )}

      {isEditing ? (
        <EditProjectForm
          workspaceId={ws.id}
          project={current}
          onCancel={() => setEditing(null)}
          onReload={() => {
            setEditing(null);
            project.retry();
          }}
          onSaved={(updated) => {
            setEditing(null);
            applyChange(updated, 'Project updated.');
          }}
        />
      ) : (
        <section aria-label="Project details" className="mt-4">
          {current.description ? (
            <p className="text-sm break-words whitespace-pre-line text-slate-700">
              {current.description}
            </p>
          ) : (
            <p className="text-sm text-slate-500 italic">No description.</p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            Created by{' '}
            {creator
              ? creator.id === currentUserId
                ? `${creator.email} (you)`
                : creator.email
              : 'A former member'}{' '}
            · Created <time dateTime={current.createdAt}>{dt.format(current.createdAt)}</time> ·
            Last updated <time dateTime={current.updatedAt}>{dt.format(current.updatedAt)}</time>
          </p>
        </section>
      )}

      {/* The main content: tasks come straight after the header. Keyed by project. */}
      <ProjectTasks
        key={current.id}
        workspaceId={ws.id}
        projectId={current.id}
        archived={archived}
        currentUserId={currentUserId}
      />

      {/* Archive / restore / delete live below the work, in their own section (owners only). */}
      {isOwner && (
        <section
          aria-labelledby="project-settings-heading"
          className="mt-12 border-t border-slate-200 pt-6"
        >
          <h2 id="project-settings-heading" className="text-base font-semibold text-slate-900">
            Project settings
          </h2>
          <ProjectManagement
            workspaceId={ws.id}
            project={current}
            onChanged={applyChange}
            onDeleted={() => navigate(`/workspaces/${ws.id}/projects`, { replace: true })}
          />
        </section>
      )}
    </div>
  );
}
