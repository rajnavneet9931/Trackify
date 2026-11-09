/**
 * Recently opened workspaces, for the Home page. A per-browser convenience
 * only: workspace IDs (no names or other data) kept in localStorage per user.
 * The Home page shows them only if they are still in the user's workspace
 * list from the API, so a deleted or left workspace simply disappears. Every
 * access is guarded: blocked storage just means "no recent workspaces".
 */

const MAX = 5;
const key = (userId: string) => `trackify:recent-workspaces:${userId}`;

export function readRecentWorkspaces(userId: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberWorkspace(userId: string, workspaceId: string): void {
  try {
    const next = [workspaceId, ...readRecentWorkspaces(userId).filter((id) => id !== workspaceId)];
    localStorage.setItem(key(userId), JSON.stringify(next.slice(0, MAX)));
  } catch {
    // Storage unavailable (private mode, blocked): nothing to remember.
  }
}
