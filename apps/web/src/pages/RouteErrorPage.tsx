import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

import { env } from '../config/env';

/** Rendered by the router when a route throws while loading or rendering. */
export function RouteErrorPage() {
  const error = useRouteError();

  const title = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : 'Error';
  // Only reveal internal error details during development.
  const detail = env.isDev && error instanceof Error ? error.message : undefined;

  return (
    <div role="alert" className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-3xl font-bold tracking-tight">Something went wrong</h1>
      <p className="mt-3 text-slate-600">{title}</p>
      {detail && (
        <pre className="mt-4 overflow-auto rounded bg-slate-100 p-3 text-left text-xs">
          {detail}
        </pre>
      )}
      <Link to="/" className="mt-6 inline-block text-sm font-medium text-brand-600">
        Back to home
      </Link>
    </div>
  );
}
