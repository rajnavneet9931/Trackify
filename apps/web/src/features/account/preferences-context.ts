import { createContext, useContext, useMemo } from 'react';

import {
  DEFAULT_PREFS,
  formatDateTime,
  fromZonedInputValue,
  sameZonedDay,
  startOfZonedDay,
  toZonedInputValue,
  type DateStyle,
  type DateTimePrefs,
} from '../../lib/datetime';
import { DEFAULT_SETTINGS, type AccountSettings } from './account.api';

export interface PreferencesContextValue {
  /** The signed-in user's saved settings (defaults until loaded or when signed out). */
  settings: AccountSettings;
  /** Whether `settings` came from the server. */
  loaded: boolean;
  /** Shows freshly saved settings everywhere at once. */
  setSettings: (settings: AccountSettings) => void;
  /** The signed-in user's display name (null until set or loaded). */
  displayName: string | null;
  setDisplayName: (name: string | null) => void;
}

export const PreferencesContext = createContext<PreferencesContextValue>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  setSettings: () => undefined,
  displayName: null,
  setDisplayName: () => undefined,
});

export function usePreferences(): PreferencesContextValue {
  return useContext(PreferencesContext);
}

export function prefsFromSettings(settings: AccountSettings): DateTimePrefs {
  return {
    timeZone: settings.timeZone ?? DEFAULT_PREFS.timeZone,
    dateFormat: settings.dateFormat,
  };
}

/**
 * Date helpers bound to the user's time zone and date format, for every
 * timestamp the app shows (deadlines, reminders, comments, activity…) and for
 * the deadline pickers, so what you type and what you see always agree.
 */
export function useDateTime() {
  const { settings } = usePreferences();
  const { timeZone, dateFormat } = prefsFromSettings(settings);
  return useMemo(() => {
    const prefs = { timeZone, dateFormat };
    return {
      timeZone,
      format: (iso: string, style: DateStyle = 'dateTime') => formatDateTime(iso, style, prefs),
      toInput: (iso: string | null) => toZonedInputValue(iso, timeZone),
      fromInput: (value: string) => (value ? fromZonedInputValue(value, timeZone) : null),
      startOfDay: (date: Date, addDays = 0) => startOfZonedDay(date, timeZone, addDays),
      sameDay: (a: Date, b: Date) => sameZonedDay(a, b, timeZone),
    };
  }, [timeZone, dateFormat]);
}

export type DateTimeTools = ReturnType<typeof useDateTime>;
