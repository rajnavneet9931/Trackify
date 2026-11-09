import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  formatDateTime,
  fromZonedInputValue,
  startOfZonedDay,
  toZonedInputValue,
} from '../../lib/datetime';
import { apiError, mockApi, renderApp, session, USER, type MockReply } from '../../test/mock-api';
import { dueState } from '../tasks/dates';
import type { AccountSettings } from './account.api';

const PROFILE = 'GET /api/v1/users/me';
const PATCH_PROFILE = 'PATCH /api/v1/users/me';
const PASSWORD = 'PATCH /api/v1/users/me/password';
const SETTINGS = 'GET /api/v1/users/me/settings';
const PATCH_SETTINGS = 'PATCH /api/v1/users/me/settings';

const defaults: AccountSettings = {
  timeZone: null,
  dateFormat: 'LOCALE',
  notifications: { taskAssigned: true, taskCommented: true, taskReminder: true },
};
const settingsReply = (s: Partial<AccountSettings> = {}): MockReply => ({
  status: 200,
  body: { data: { settings: { ...defaults, ...s } } },
});
const profileReply = (name: string | null = null): MockReply => ({
  status: 200,
  body: { data: { user: { ...USER, name } } },
});

const section = (name: string) => within(screen.getByRole('region', { name }) as HTMLElement);
const openAccount = async (handlers: Parameters<typeof mockApi>[0] = {}) => {
  const api = mockApi({ 'GET /api/v1/auth/me': session('csrf-1'), ...handlers });
  const view = renderApp('/account');
  await screen.findByRole('heading', { name: 'Your account' }, { timeout: 5000 });
  return { api, ...view };
};

describe('date and time preferences (lib/datetime)', () => {
  const instant = '2026-11-04T20:00:00.000Z'; // 01:30 on Nov 5 in Kolkata

  it('writes dates in the chosen format and time zone', () => {
    const zone = 'Asia/Kolkata';
    expect(formatDateTime(instant, 'date', { timeZone: zone, dateFormat: 'ISO' })).toBe(
      '2026-11-05',
    );
    expect(formatDateTime(instant, 'date', { timeZone: zone, dateFormat: 'DMY' })).toBe(
      '05/11/2026',
    );
    expect(formatDateTime(instant, 'date', { timeZone: 'UTC', dateFormat: 'MDY' })).toBe(
      '11/04/2026',
    );
    expect(formatDateTime(instant, 'dateTime', { timeZone: zone, dateFormat: 'ISO' })).toMatch(
      /^2026-11-05, 1:30/,
    );
    // LOCALE with the device zone is exactly Intl's default output.
    expect(formatDateTime(instant, 'dateTime', { timeZone: undefined, dateFormat: 'LOCALE' })).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(instant),
      ),
    );
  });

  it('converts deadline inputs in the chosen zone, across DST changes', () => {
    expect(fromZonedInputValue('2026-12-01T17:30', 'Asia/Kolkata')).toBe(
      '2026-12-01T12:00:00.000Z',
    );
    expect(toZonedInputValue('2026-12-01T12:00:00.000Z', 'Asia/Kolkata')).toBe('2026-12-01T17:30');
    // New York: EDT (UTC−4) in July, EST (UTC−5) in December.
    expect(fromZonedInputValue('2026-07-01T09:00', 'America/New_York')).toBe(
      '2026-07-01T13:00:00.000Z',
    );
    expect(fromZonedInputValue('2026-12-01T09:00', 'America/New_York')).toBe(
      '2026-12-01T14:00:00.000Z',
    );
    expect(fromZonedInputValue('', 'UTC')).toBeNull();
    expect(fromZonedInputValue('not a date', 'UTC')).toBeNull();
  });

  it('computes "today" and "due today" in the chosen zone', () => {
    const now = new Date('2026-11-04T20:00:00.000Z');
    expect(startOfZonedDay(now, 'Asia/Kolkata').toISOString()).toBe('2026-11-04T18:30:00.000Z');
    expect(startOfZonedDay(now, 'UTC', 1).toISOString()).toBe('2026-11-05T00:00:00.000Z');
    // 23:00 UTC on Nov 4: still "today" in UTC, already tomorrow in Kolkata.
    const due = '2026-11-04T23:00:00.000Z';
    expect(dueState(due, 'TODO', now, 'UTC')).toBe('today');
    expect(dueState(due, 'TODO', now, 'Asia/Kolkata')).toBe('today');
    expect(dueState('2026-11-05T19:00:00.000Z', 'TODO', now, 'Asia/Kolkata')).toBe('soon');
    expect(dueState('2026-11-05T19:00:00.000Z', 'TODO', now, 'UTC')).toBe('soon');
  });
});

describe('account page', () => {
  it('is reachable from the navigation and shows the profile, email read-only', async () => {
    mockApi({ 'GET /api/v1/auth/me': session('csrf-1'), [PROFILE]: profileReply('Ada L.') });
    const { router } = renderApp('/workspaces');
    fireEvent.click(
      await screen.findByRole('link', { name: /ada@example.com/ }, { timeout: 5000 }),
    );
    expect(router.state.location.pathname).toBe('/account');

    const profile = section('Profile');
    expect(await profile.findByLabelText('Display name')).toHaveValue('Ada L.');
    expect(profile.getByText('ada@example.com')).toBeInTheDocument();
    expect(profile.getByText('Your email can’t be changed.')).toBeInTheDocument();
    expect(profile.queryByRole('textbox', { name: /email/i })).not.toBeInTheDocument();
  });

  it('saves the display name with the CSRF token', async () => {
    const { api } = await openAccount({
      [PATCH_PROFILE]: profileReply('Ada Lovelace'),
    });
    const profile = section('Profile');
    fireEvent.change(await profile.findByLabelText('Display name'), {
      target: { value: '  Ada Lovelace ' },
    });
    fireEvent.click(profile.getByRole('button', { name: 'Save profile' }));

    expect(await profile.findByText('Profile saved.')).toBeInTheDocument();
    const [req] = api.to(PATCH_PROFILE);
    expect(req!.body).toEqual({ name: 'Ada Lovelace' });
    expect(req!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(profile.getByLabelText('Display name')).toHaveValue('Ada Lovelace');
  });

  it('validates the name and shows server errors', async () => {
    const { api } = await openAccount({
      [PATCH_PROFILE]: apiError(503, 'SERVICE_UNAVAILABLE', 'x'),
    });
    const profile = section('Profile');
    const input = await profile.findByLabelText('Display name');
    fireEvent.change(input, { target: { value: 'x'.repeat(101) } });
    fireEvent.click(profile.getByRole('button', { name: 'Save profile' }));
    expect(await profile.findByText('Name must be at most 100 characters')).toBeInTheDocument();
    expect(api.to(PATCH_PROFILE)).toEqual([]);

    fireEvent.change(input, { target: { value: 'Ada' } });
    fireEvent.click(profile.getByRole('button', { name: 'Save profile' }));
    expect(await profile.findByRole('alert')).toHaveTextContent(
      'We couldn’t save your profile. Please try again.',
    );
  });

  it('shows a profile load error with retry', async () => {
    let healthy = false;
    await openAccount({
      [PROFILE]: () => (healthy ? profileReply() : apiError(503, 'SERVICE_UNAVAILABLE', 'x')),
    });
    const alert = await section('Profile').findByRole('alert');
    healthy = true;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await section('Profile').findByLabelText('Display name')).toBeInTheDocument();
  });

  describe('password change', () => {
    const fill = (current: string, next: string, confirm = next) => {
      const security = section('Security');
      fireEvent.change(security.getByLabelText('Current password'), { target: { value: current } });
      fireEvent.change(security.getByLabelText('New password'), { target: { value: next } });
      fireEvent.change(security.getByLabelText('Confirm new password'), {
        target: { value: confirm },
      });
      fireEvent.click(security.getByRole('button', { name: 'Change password' }));
    };

    it('validates before sending', async () => {
      const { api } = await openAccount();
      fill('old password here', 'short', 'shorter');
      const security = section('Security');
      expect(
        await security.findByText('Password must be at least 12 characters'),
      ).toBeInTheDocument();
      expect(security.getByText('Passwords do not match')).toBeInTheDocument();
      fill('same passphrase!', 'same passphrase!');
      expect(
        await security.findByText('New password must be different from the current one'),
      ).toBeInTheDocument();
      fill('', 'ada@example.com');
      expect(await security.findByText('Current password is required')).toBeInTheDocument();
      expect(
        security.getByText('Password must not be the same as your email address'),
      ).toBeInTheDocument();
      expect(api.to(PASSWORD)).toEqual([]);
    });

    it('shows a wrong current password next to the field and stays signed in', async () => {
      const { router } = await openAccount({
        [PASSWORD]: apiError(400, 'BAD_REQUEST', 'Current password is incorrect', [
          { location: 'body', path: 'currentPassword', message: 'Current password is incorrect' },
        ]),
      });
      fill('wrong password!!', 'a brand new passphrase');
      const security = section('Security');
      expect(await security.findByText('Current password is incorrect')).toBeInTheDocument();
      expect(security.getByLabelText('Current password')).toHaveValue('');
      expect(router.state.location.pathname).toBe('/account');
    });

    it('signs out everywhere after a change and explains it on the login page', async () => {
      const { api, router } = await openAccount({
        [PASSWORD]: { status: 200, body: { data: { passwordChanged: true, signedOut: true } } },
      });
      fill('correct horse battery staple', 'a brand new passphrase');

      await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
      expect(
        await screen.findByText(/Your password was changed and you were signed out everywhere/),
      ).toBeInTheDocument();
      const [req] = api.to(PASSWORD);
      expect(req!.body).toEqual({
        currentPassword: 'correct horse battery staple',
        newPassword: 'a brand new passphrase',
      });
      expect(req!.headers.get('X-CSRF-Token')).toBe('csrf-1');
    });

    it('explains rate limiting', async () => {
      await openAccount({ [PASSWORD]: apiError(429, 'TOO_MANY_REQUESTS', 'x') });
      fill('wrong password!!', 'a brand new passphrase');
      expect(await section('Security').findByRole('alert')).toHaveTextContent('Too many attempts');
    });
  });

  describe('preferences', () => {
    it('shows saved preferences and saves changes', async () => {
      const { api } = await openAccount({
        [SETTINGS]: settingsReply({ timeZone: 'Asia/Kolkata' }),
        [PATCH_SETTINGS]: (r) => ({
          status: 200,
          body: { data: { settings: { ...defaults, ...(r.body as object) } } },
        }),
      });
      const prefs = section('Preferences');
      await waitFor(() => expect(prefs.getByLabelText('Time zone')).toHaveValue('Asia/Kolkata'));
      expect(prefs.getByLabelText('Date format')).toHaveValue('LOCALE');
      expect(prefs.getByRole('button', { name: 'Save preferences' })).toBeDisabled();

      fireEvent.change(prefs.getByLabelText('Date format'), { target: { value: 'ISO' } });
      fireEvent.click(prefs.getByLabelText('Someone comments on my tasks'));
      expect(prefs.getByText(/^2026-11-04, /)).toBeInTheDocument(); // live preview
      fireEvent.click(prefs.getByRole('button', { name: 'Save preferences' }));

      expect(await prefs.findByText('Preferences saved.')).toBeInTheDocument();
      expect(api.to(PATCH_SETTINGS)[0]!.body).toEqual({
        timeZone: 'Asia/Kolkata',
        dateFormat: 'ISO',
        notifications: { taskAssigned: true, taskCommented: false, taskReminder: true },
      });
    });

    it('applies the time zone and date format to timestamps across the app', async () => {
      mockApi({
        'GET /api/v1/auth/me': session('csrf-1'),
        [SETTINGS]: settingsReply({ timeZone: 'Asia/Kolkata', dateFormat: 'ISO' }),
        'GET /api/v1/notifications': {
          status: 200,
          body: {
            data: {
              notifications: [
                {
                  id: '01a14e7b-cea3-700d-aeda-000000000001',
                  type: 'TASK_REMINDER',
                  title: 'Task due soon',
                  message: 'Due',
                  workspaceId: '01a14e7b-cea3-700d-aeda-085cd44166ed',
                  resourceType: 'TASK',
                  resourceId: '01a14e7b-cea3-700d-aeda-0000000000c1',
                  actorId: null,
                  actor: null,
                  isRead: true,
                  readAt: null,
                  createdAt: '2026-11-04T20:00:00.000Z',
                  target: null,
                },
              ],
            },
            meta: { limit: 20, nextCursor: null },
          },
        },
      });
      renderApp('/notifications');
      const list = await screen.findByRole('list', { name: 'Notifications' }, { timeout: 5000 });
      // 20:00 UTC on Nov 4 is 01:30 on Nov 5 in Kolkata.
      expect(await within(list).findByText(/2026-11-05, 1:30/)).toBeInTheDocument();
    });

    it('shows a save error', async () => {
      await openAccount({ [PATCH_SETTINGS]: apiError(503, 'SERVICE_UNAVAILABLE', 'x') });
      const prefs = section('Preferences');
      fireEvent.change(prefs.getByLabelText('Date format'), { target: { value: 'DMY' } });
      fireEvent.click(prefs.getByRole('button', { name: 'Save preferences' }));
      expect(await prefs.findByRole('alert')).toHaveTextContent(
        'We couldn’t save your preferences.',
      );
    });
  });
});
