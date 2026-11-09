/**
 * Mirrors the API's workspace-name rules (apps/api workspace.validators.ts):
 * NFC-normalized and trimmed, 1–100 characters, no control characters. The
 * server stays authoritative; its field errors are shown as returned.
 */
export const WORKSPACE_NAME_MAX_LENGTH = 100;

const CONTROL_CHARACTERS = /\p{Cc}/u;

export function normalizeWorkspaceName(name: string): string {
  return name.normalize('NFC').trim();
}

export function validateWorkspaceName(name: string): string | undefined {
  const normalized = normalizeWorkspaceName(name);
  if (!normalized) return 'Name is required';
  if (normalized.length > WORKSPACE_NAME_MAX_LENGTH) {
    return `Name must be at most ${WORKSPACE_NAME_MAX_LENGTH} characters`;
  }
  if (CONTROL_CHARACTERS.test(normalized)) return 'Name must not contain control characters';
  return undefined;
}
