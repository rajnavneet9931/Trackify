/**
 * Mirrors the API's task rules (apps/api task.validators.ts): values are
 * NFC-normalized and trimmed; the title is 1–200 characters with no control
 * characters; the optional description is at most 5000 characters and may
 * contain line breaks and tabs. The server stays authoritative.
 */
export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_DESCRIPTION_MAX_LENGTH = 5000;

const CONTROL_CHARACTERS = /\p{Cc}/u;
const DESCRIPTION_CONTROL_CHARACTERS = /[^\P{Cc}\t\n\r]/u;

export function normalizeTaskText(value: string): string {
  return value.normalize('NFC').trim();
}

export function validateTaskTitle(title: string): string | undefined {
  const normalized = normalizeTaskText(title);
  if (!normalized) return 'Title is required';
  if (normalized.length > TASK_TITLE_MAX_LENGTH) {
    return `Title must be at most ${TASK_TITLE_MAX_LENGTH} characters`;
  }
  if (CONTROL_CHARACTERS.test(normalized)) return 'Title must not contain control characters';
  return undefined;
}

export function validateTaskDescription(description: string): string | undefined {
  const normalized = normalizeTaskText(description);
  if (normalized.length > TASK_DESCRIPTION_MAX_LENGTH) {
    return `Description must be at most ${TASK_DESCRIPTION_MAX_LENGTH} characters`;
  }
  if (DESCRIPTION_CONTROL_CHARACTERS.test(normalized)) {
    return 'Description must not contain control characters';
  }
  return undefined;
}
