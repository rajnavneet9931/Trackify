import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import {
  DEFAULT_SETTINGS,
  profileSelect,
  type AccountSettings,
  type Profile,
  type SettingsChanges,
} from './account.model.js';

/** The signed-in user's own account. Every method is keyed by the session's user id. */
export interface AccountRepository {
  findProfile(userId: string): Promise<Profile | null>;
  /** Updates only the display name; null if the user no longer exists. */
  updateProfile(userId: string, changes: { name: string | null }): Promise<Profile | null>;
  /** For verifying the current password only; never serialized. */
  findPasswordHash(userId: string): Promise<string | null>;
  /**
   * In one transaction: replaces the hash **only if it is still `expectedHash`**
   * (the one just verified) and deletes every session of the user, the current
   * one included. False (nothing changed) if the password changed meanwhile.
   */
  replacePassword(userId: string, expectedHash: string, newHash: string): Promise<boolean>;
  /** The user's settings, with defaults for anything never saved. */
  findSettings(userId: string): Promise<AccountSettings>;
  /** Creates the settings row on first save; only the given fields change. */
  updateSettings(userId: string, changes: SettingsChanges): Promise<AccountSettings>;
}

const settingsSelect = {
  timeZone: true,
  dateFormat: true,
  notifyTaskAssigned: true,
  notifyTaskCommented: true,
  notifyTaskReminder: true,
} as const;

type SettingsRow = {
  timeZone: string | null;
  dateFormat: AccountSettings['dateFormat'];
  notifyTaskAssigned: boolean;
  notifyTaskCommented: boolean;
  notifyTaskReminder: boolean;
};

const toSettings = (row: SettingsRow): AccountSettings => ({
  timeZone: row.timeZone,
  dateFormat: row.dateFormat,
  notifications: {
    taskAssigned: row.notifyTaskAssigned,
    taskCommented: row.notifyTaskCommented,
    taskReminder: row.notifyTaskReminder,
  },
});

export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly db: DatabaseClient) {}

  findProfile(userId: string) {
    return this.db.user.findUnique({ where: { id: userId }, select: profileSelect });
  }

  async updateProfile(userId: string, { name }: { name: string | null }) {
    // Only `name` is written: email, password, memberships and roles are untouchable here.
    const { count } = await this.db.user.updateMany({ where: { id: userId }, data: { name } });
    return count === 1 ? this.findProfile(userId) : null;
  }

  async findPasswordHash(userId: string) {
    const row = await this.db.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    return row?.passwordHash ?? null;
  }

  replacePassword(userId: string, expectedHash: string, newHash: string) {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: userId, passwordHash: expectedHash },
        data: { passwordHash: newHash },
      });
      if (count !== 1) return false;
      // Every existing session ends with the old password: sign in again everywhere.
      await tx.session.deleteMany({ where: { userId } });
      return true;
    });
  }

  async findSettings(userId: string) {
    const row = await this.db.userSettings.findUnique({
      where: { userId },
      select: settingsSelect,
    });
    return row ? toSettings(row) : structuredClone(DEFAULT_SETTINGS);
  }

  async updateSettings(userId: string, { timeZone, dateFormat, notifications }: SettingsChanges) {
    const data = {
      ...(timeZone !== undefined && { timeZone }),
      ...(dateFormat !== undefined && { dateFormat }),
      ...(notifications?.taskAssigned !== undefined && {
        notifyTaskAssigned: notifications.taskAssigned,
      }),
      ...(notifications?.taskCommented !== undefined && {
        notifyTaskCommented: notifications.taskCommented,
      }),
      ...(notifications?.taskReminder !== undefined && {
        notifyTaskReminder: notifications.taskReminder,
      }),
    };
    // One statement (INSERT … ON CONFLICT DO UPDATE): safe under concurrent first saves.
    const row = await this.db.userSettings.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
      select: settingsSelect,
    });
    return toSettings(row);
  }
}
