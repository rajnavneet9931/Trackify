import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';

import { useAuth } from '../features/auth/auth-context';
import { DeleteWorkspace } from '../features/workspaces/DeleteWorkspace';
import { RoleBadge } from '../features/workspaces/RoleBadge';
import { WorkspaceGeneralSettings } from '../features/workspaces/WorkspaceGeneralSettings';
import { PageHeader } from '../components/ui/PageHeader';
import {
  getWorkspaceSettings,
  type WorkspaceSettingsDetail,
} from '../features/workspaces/workspaces.api';
import { ApiError } from '../lib/api-client';
import { WorkspaceNav } from '../features/workspaces/WorkspaceNav';
import { linkClass } from '../components/ui/styles';

type State =
  | { status: 'loading' }
  | { status: 'ready'; detail: WorkspaceSettingsDetail }
  | { status: 'not-found' }
  | { status: 'error' };

/**
 * Workspace settings for every member: owners edit the name and description,
 * manage members and can delete the workspace; members see it read-only.
 */
export function WorkspaceSettingsPage() {
  const { workspaceId = '' } = useParams();
  const { invalidateSession } = useAuth();
  const [state, setState] = useState<{ id: string; value: State }>({
    id: workspaceId,
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const settle = (value: State) => setState({ id: workspaceId, value });
    getWorkspaceSettings(workspaceId, controller.signal)
      .then((detail) => settle({ status: 'ready', detail }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) invalidateSession();
        else if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
          settle({ status: 'not-found' });
        } else settle({ status: 'error' });
      });
    return () => controller.abort();
  }, [workspaceId, attempt, invalidateSession]);

  const reload = () => {
    setState({ id: workspaceId, value: { status: 'loading' } });
    setAttempt((n) => n + 1);
  };
  const current: State = state.id === workspaceId ? state.value : { status: 'loading' };

  if (current.status === 'loading') {
    return (
      <p role="status" className="py-16 text-center text-sm text-slate-500">
        Loading settings…
      </p>
    );
  }
  if (current.status === 'not-found') {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Workspace not found</h1>
        <p className="mt-2 text-slate-600">
          This workspace doesn’t exist, or you don’t have access to it.
        </p>
        <div className="mt-6">
          <Link to="/workspaces" className={linkClass}>
            ← All workspaces
          </Link>
        </div>
      </div>
    );
  }
  if (current.status === 'error') {
    return (
      <div role="alert" className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Can’t load the settings</h1>
        <p className="mt-2 text-slate-600">Something went wrong. Please try again.</p>
        <button
          type="button"
          onClick={reload}
          className="mt-6 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Try again
        </button>
      </div>
    );
  }

  const { settings, membership } = current.detail;
  const isOwner = membership.role === 'OWNER';

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        crumbs={[
          { label: 'Workspaces', to: '/workspaces' },
          { label: settings.name, to: `/workspaces/${settings.id}` },
          { label: 'Settings' },
        ]}
        title="Workspace settings"
        documentTitle={`Settings · ${settings.name}`}
        badge={<RoleBadge role={membership.role} prefix="Your role: " />}
        tabs={<WorkspaceNav workspaceId={settings.id} />}
      />

      <section
        aria-labelledby="general-heading"
        className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-panel"
      >
        <h2 id="general-heading" className="text-base font-semibold">
          General
        </h2>
        {/* Keyed by load: a reload starts the form from the server's values; a save keeps it. */}
        <WorkspaceGeneralSettings
          key={attempt}
          workspaceId={settings.id}
          settings={settings}
          canEdit={isOwner}
          onSaved={(updated) =>
            setState({
              id: workspaceId,
              value: { status: 'ready', detail: { settings: updated, membership } },
            })
          }
          onReload={reload}
        />
      </section>

      <p className="mt-6 text-sm text-slate-600">
        Members, invitations and roles are on the{' '}
        <Link to={`/workspaces/${settings.id}/members`} className={linkClass}>
          Members
        </Link>{' '}
        page.
      </p>

      {isOwner && <DeleteWorkspace workspaceId={settings.id} name={settings.name} />}
    </div>
  );
}
