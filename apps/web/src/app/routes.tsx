import { Navigate, type RouteObject } from 'react-router';

import { ToastProvider } from '../components/ui/ToastProvider';
import { PreferencesProvider } from '../features/account/PreferencesProvider';
import { AuthProvider } from '../features/auth/AuthProvider';
import { GuestOnly, RequireAuth } from '../features/auth/route-guards';
import { NotificationsProvider } from '../features/notifications/NotificationsProvider';
import { RootLayout } from '../layouts/RootLayout';
import { AcceptInvitationPage } from '../pages/AcceptInvitationPage';
import { AccountPage } from '../pages/AccountPage';
import { HomePage } from '../pages/HomePage';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { NotificationsPage } from '../pages/NotificationsPage';
import { ProjectDetailPage } from '../pages/ProjectDetailPage';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import { RegisterPage } from '../pages/RegisterPage';
import { WorkspaceDashboardPage } from '../pages/WorkspaceDashboardPage';
import { WorkspaceDetailPage } from '../pages/WorkspaceDetailPage';
import { WorkspaceMembersPage } from '../pages/WorkspaceMembersPage';
import { WorkspaceProjectsPage } from '../pages/WorkspaceProjectsPage';
import { WorkspaceSettingsPage } from '../pages/WorkspaceSettingsPage';
import { WorkspacesPage } from '../pages/WorkspacesPage';
import { RouteErrorPage } from '../pages/RouteErrorPage';

/**
 * Application route tree. Kept separate from router creation so tests can
 * mount it in a memory router. AuthProvider sits at the root so every route
 * shares one session state (and one /auth/me request).
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: (
      <AuthProvider>
        <PreferencesProvider>
          <NotificationsProvider>
            <ToastProvider>
              <RootLayout />
            </ToastProvider>
          </NotificationsProvider>
        </PreferencesProvider>
      </AuthProvider>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      {
        element: <GuestOnly />,
        children: [
          { path: 'login', element: <LoginPage /> },
          { path: 'register', element: <RegisterPage /> },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          { path: 'account', element: <AccountPage /> },
          { path: 'workspaces', element: <WorkspacesPage /> },
          { path: 'workspaces/:workspaceId', element: <WorkspaceDetailPage /> },
          { path: 'workspaces/:workspaceId/dashboard', element: <WorkspaceDashboardPage /> },
          { path: 'workspaces/:workspaceId/projects', element: <WorkspaceProjectsPage /> },
          { path: 'workspaces/:workspaceId/members', element: <WorkspaceMembersPage /> },
          { path: 'workspaces/:workspaceId/settings', element: <WorkspaceSettingsPage /> },
          {
            path: 'workspaces/:workspaceId/projects/:projectId',
            element: <ProjectDetailPage />,
          },
          {
            path: 'workspaces/:workspaceId/projects/:projectId/tasks/:taskId',
            element: <TaskDetailPage />,
          },
          { path: 'invitations/accept', element: <AcceptInvitationPage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          // Step 18's reminders page now lives in the notification center.
          { path: 'reminders', element: <Navigate to="/notifications" replace /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
