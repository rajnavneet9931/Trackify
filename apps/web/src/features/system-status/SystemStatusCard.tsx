import { useSystemStatus } from './useSystemStatus';

type Tone = 'neutral' | 'ok' | 'warn' | 'error';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-slate-300',
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-rose-500',
};

function Row({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-center justify-between py-2">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="flex items-center gap-2 text-sm font-medium">
        <span aria-hidden="true" className={`size-2 rounded-full ${TONE_CLASSES[tone]}`} />
        {value}
      </dd>
    </div>
  );
}

export function SystemStatusCard() {
  const { status, refresh } = useSystemStatus();

  return (
    <section
      aria-labelledby="system-status-heading"
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-panel"
    >
      <div className="flex items-center justify-between">
        <h2 id="system-status-heading" className="text-base font-semibold">
          System status
        </h2>
        <button
          type="button"
          onClick={refresh}
          disabled={status.state === 'loading'}
          className="rounded-md px-2.5 py-1 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      <dl className="mt-4 divide-y divide-slate-100" aria-live="polite">
        {status.state === 'loading' && <Row label="API" value="Checking…" tone="neutral" />}

        {status.state === 'error' && <Row label="API" value={status.message} tone="error" />}

        {status.state === 'success' && (
          <>
            <Row label="API" value="Online" tone="ok" />
            <Row
              label="Database"
              value={status.report.checks.database === 'up' ? 'Connected' : 'Unavailable'}
              tone={status.report.checks.database === 'up' ? 'ok' : 'warn'}
            />
          </>
        )}
      </dl>
    </section>
  );
}
