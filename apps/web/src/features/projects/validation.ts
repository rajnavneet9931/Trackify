/**
 * Mirrors the API's project rules (apps/api project.validators.ts): values are
 * NFC-normalized and trimmed; the name is 1–120 characters with no control
 * characters; the optional description is at most 2000 characters and may
 * contain line breaks and tabs. The server stays authoritative.
 */
export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 2000;

const CONTROL_CHARACTERS = /\p{Cc}/u;
const DESCRIPTION_CONTROL_CHARACTERS = /[^\P{Cc}\t\n\r]/u;

export function normalizeProjectText(value: string): string {
  return value.normalize('NFC').trim();
}

export function validateProjectName(name: string): string | undefined {
  const normalized = normalizeProjectText(name);
  if (!normalized) return 'Name is required';
  if (normalized.length > PROJECT_NAME_MAX_LENGTH) {
    return `Name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`;
  }
  if (CONTROL_CHARACTERS.test(normalized)) return 'Name must not contain control characters';
  return undefined;
}

export function validateProjectDescription(description: string): string | undefined {
  const normalized = normalizeProjectText(description);
  if (normalized.length > PROJECT_DESCRIPTION_MAX_LENGTH) {
    return `Description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters`;
  }
  if (DESCRIPTION_CONTROL_CHARACTERS.test(normalized)) {
    return 'Description must not contain control characters';
  }
  return undefined;
}
