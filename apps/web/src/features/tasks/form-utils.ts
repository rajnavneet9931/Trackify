export interface TaskFieldErrors {
  title?: string | undefined;
  description?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  /** Due date / reminder problems (the API reports them on reminderAt or dueDate). */
  schedule?: string | undefined;
}

/** Maps the API's 400 `details` (`[{ path, message }]`) to per-field messages. */
export function taskFieldErrorsFrom(details: unknown): TaskFieldErrors {
  if (!Array.isArray(details)) return {};
  const messageFor = (field: string) => {
    const match = details.find((d) => (d as { path?: unknown })?.path === field) as
      { message?: unknown } | undefined;
    return typeof match?.message === 'string' ? match.message : undefined;
  };
  return {
    title: messageFor('title'),
    description: messageFor('description'),
    status: messageFor('status'),
    priority: messageFor('priority'),
    schedule: messageFor('reminderAt') ?? messageFor('dueDate'),
  };
}

export const selectClass =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none disabled:bg-slate-50';
