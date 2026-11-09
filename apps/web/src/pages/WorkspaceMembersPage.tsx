import { useParams } from 'react-router';

import { PageHeader } from '../components/ui/PageHeader';
import { useAuth } from '../features/auth/auth-context';
import { InviteMemberForm } from '../features/invitations/InviteMemberForm';
import { RoleBadge } from '../features/workspaces/RoleBadge';
import { WorkspaceGate } from '../features/workspaces/WorkspaceGate';
import { WorkspaceMembers } from '../features/workspaces/WorkspaceMembers';
import { WorkspaceNav } from '../features/workspaces/WorkspaceNav';

/** The workspace's members, with invitations and role management for owners. */
export function WorkspaceMembersPage() {
  const { workspaceId = '' } = useParams();
  const { session } = useAuth();
  const currentUserId = session.status === 'authenticated' ? session.user.id : '';
  return (
    <WorkspaceGate workspaceId={workspaceId}>
      {({ workspace, membership }) => {
        const isOwner = membership.role === 'OWNER';
        return (
          <div className="mx-auto max-w-5xl">
            <PageHeader
              crumbs={[
                { label: 'Workspaces', to: '/workspaces' },
                { label: workspace.name, to: `/workspaces/${workspace.id}` },
                { label: 'Members' },
              ]}
              title="Members"
              documentTitle={`Members · ${workspace.name}`}
              badge={<RoleBadge role={membership.role} prefix="Your role: " />}
              tabs={<WorkspaceNav workspaceId={workspace.id} />}
            />
            {/* UX only: the API independently refuses invitations from non-owners. */}
            {isOwner && <InviteMemberForm workspaceId={workspace.id} />}
            <WorkspaceMembers
              workspaceId={workspace.id}
              workspaceName={workspace.name}
              currentUserId={currentUserId}
              canManageMembers={isOwner}
            />
          </div>
        );
      }}
    </WorkspaceGate>
  );
}
