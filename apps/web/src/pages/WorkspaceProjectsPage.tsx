import { useParams } from 'react-router';

import { PageHeader } from '../components/ui/PageHeader';
import { WorkspaceProjects } from '../features/projects/WorkspaceProjects';
import { RoleBadge } from '../features/workspaces/RoleBadge';
import { WorkspaceGate } from '../features/workspaces/WorkspaceGate';
import { WorkspaceNav } from '../features/workspaces/WorkspaceNav';

/** The workspace's projects: the full list for members, plus creation for owners. */
export function WorkspaceProjectsPage() {
  const { workspaceId = '' } = useParams();
  return (
    <WorkspaceGate workspaceId={workspaceId}>
      {({ workspace, membership }) => (
        <div className="mx-auto max-w-5xl">
          <PageHeader
            crumbs={[
              { label: 'Workspaces', to: '/workspaces' },
              { label: workspace.name, to: `/workspaces/${workspace.id}` },
              { label: 'Projects' },
            ]}
            title="Projects"
            documentTitle={`Projects · ${workspace.name}`}
            badge={<RoleBadge role={membership.role} prefix="Your role: " />}
            tabs={<WorkspaceNav workspaceId={workspace.id} />}
          />
          {/* Every member sees the projects; only owners get the create form (UX only). */}
          <WorkspaceProjects workspaceId={workspace.id} canCreate={membership.role === 'OWNER'} />
        </div>
      )}
    </WorkspaceGate>
  );
}
