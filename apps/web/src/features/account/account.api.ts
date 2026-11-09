import { apiRequest } from '../../lib/api-client';
import type { DateFormat } from '../../lib/datetime';

export interface Profile {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

export interface NotificationPreferences {
  taskAssigned: boolean;
  taskCommented: boolean;
  taskReminder: boolean;
}

export interface AccountSettings {
  /** IANA zone, or null for the device's zone. */
  timeZone: string | null;
  dateFormat: DateFormat;
  notifications: NotificationPreferences;
}

export const DEFAULT_SETTINGS: AccountSettings = {
  timeZone: null,
  dateFormat: 'LOCALE',
  notifications: { taskAssigned: true, taskCommented: true, taskReminder: true },
};

export async function getProfile(signal?: AbortSignal): Promise<Profile> {
  return (await apiRequest<{ user: Profile }>('/users/me', signal ? { signal } : {})).user;
}

export async function updateProfile(changes: { name: string | null }): Promise<Profile> {
  return (await apiRequest<{ user: Profile }>('/users/me', { method: 'PATCH', body: changes }))
    .user;
}

/** On success the API has ended every session, this one included. */
export async function changePassword(body: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await apiRequest('/users/me/password', { method: 'PATCH', body });
}

export async function getSettings(signal?: AbortSignal): Promise<AccountSettings> {
  return (
    await apiRequest<{ settings: AccountSettings }>('/users/me/settings', signal ? { signal } : {})
  ).settings;
}

export async function updateSettings(
  changes: Partial<Omit<AccountSettings, 'notifications'>> & {
    notifications?: Partial<NotificationPreferences>;
  },
): Promise<AccountSettings> {
  return (
    await apiRequest<{ settings: AccountSettings }>('/users/me/settings', {
      method: 'PATCH',
      body: changes,
    })
  ).settings;
}
