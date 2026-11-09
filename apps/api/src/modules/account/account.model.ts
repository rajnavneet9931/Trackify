import { DateFormat } from '../../generated/prisma/enums.js';

export { DateFormat };

/** The signed-in user's own profile. Never includes the password hash or sessions. */
export interface Profile {
  id: string;
  email: string;
  /** Optional display name; null until the user sets one. */
  name: string | null;
  createdAt: Date;
}

export const profileSelect = { id: true, email: true, name: true, createdAt: true } as const;

export interface NotificationPreferences {
  taskAssigned: boolean;
  taskCommented: boolean;
  taskReminder: boolean;
}

export interface AccountSettings {
  /** IANA time zone, or null for "use my device's time zone". */
  timeZone: string | null;
  dateFormat: DateFormat;
  notifications: NotificationPreferences;
}

/** What applies when the user never saved a preference (there is no settings row yet). */
export const DEFAULT_SETTINGS: AccountSettings = Object.freeze({
  timeZone: null,
  dateFormat: DateFormat.LOCALE,
  notifications: Object.freeze({ taskAssigned: true, taskCommented: true, taskReminder: true }),
});

export interface SettingsChanges {
  timeZone?: string | null | undefined;
  dateFormat?: DateFormat | undefined;
  notifications?: Partial<NotificationPreferences> | undefined;
}

export const NAME_MAX_LENGTH = 100;
