import { PreferencesSection } from '../features/account/PreferencesSection';
import { ProfileSection } from '../features/account/ProfileSection';
import { SecuritySection } from '../features/account/SecuritySection';
import { useAuth } from '../features/auth/auth-context';
import { SignOutButton } from '../features/auth/SignOut';

/** Profile, security and preferences of the signed-in user (only reachable through <RequireAuth>). */
export function AccountPage() {
  const { session } = useAuth();
  if (session.status !== 'authenticated') return null;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Your account</h1>
        <SignOutButton className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60" />
      </div>
      <ProfileSection />
      <SecuritySection email={session.user.email} />
      <PreferencesSection />
    </div>
  );
}
