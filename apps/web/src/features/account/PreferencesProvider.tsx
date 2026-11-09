import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { ApiError } from '../../lib/api-client';
import { useAuth } from '../auth/auth-context';
import { DEFAULT_SETTINGS, getProfile, getSettings, type AccountSettings } from './account.api';
import { PreferencesContext } from './preferences-context';

/**
 * Loads the signed-in user's settings once per sign-in and shares them with
 * the whole app. Until they arrive (or if loading fails) the defaults apply:
 * the device's time zone and the browser's date format.
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { session, invalidateSession } = useAuth();
  const userId = session.status === 'authenticated' ? session.user.id : null;
  const [state, setState] = useState<{ userId: string; settings: AccountSettings } | null>(null);
  const [name, setName] = useState<{ userId: string; value: string | null } | null>(null);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    getSettings(controller.signal)
      .then((settings) => setState({ userId, settings }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) invalidateSession();
      });
    // The display name, for the header and greetings (in parallel; failures keep the email).
    getProfile(controller.signal)
      .then((profile) => setName({ userId, value: profile.name }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [userId, invalidateSession]);

  // Never another user's settings after switching accounts.
  const current = userId && state?.userId === userId ? state.settings : null;
  const displayName = userId && name?.userId === userId ? name.value : null;
  const value = useMemo(
    () => ({
      settings: current ?? DEFAULT_SETTINGS,
      loaded: current !== null,
      setSettings: (settings: AccountSettings) => {
        if (userId) setState({ userId, settings });
      },
      displayName,
      setDisplayName: (value: string | null) => {
        if (userId) setName({ userId, value });
      },
    }),
    [current, userId, displayName],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}
