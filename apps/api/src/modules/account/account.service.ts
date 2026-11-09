import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors/app-error.js';
import type { PasswordHasher } from '../auth/index.js';
import type { AccountSettings, Profile, SettingsChanges } from './account.model.js';
import type { AccountRepository } from './account.repository.js';

const fieldError = (path: string, message: string) =>
  new BadRequestError(message, [{ location: 'body', path, message }]);

/**
 * The signed-in user's own profile, password and preferences. The user is
 * always the session's; nothing here touches workspaces, roles or email.
 */
export class AccountService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly passwords: PasswordHasher,
  ) {}

  async getProfile(userId: string): Promise<Profile> {
    const profile = await this.accounts.findProfile(userId);
    if (!profile) throw new NotFoundError('Account not found');
    return profile;
  }

  async updateProfile(userId: string, changes: { name: string | null }): Promise<Profile> {
    const profile = await this.accounts.updateProfile(userId, changes);
    if (!profile) throw new NotFoundError('Account not found');
    return profile;
  }

  /**
   * Verifies the current password, hashes the new one with the same Argon2id
   * settings as registration, then replaces it and ends **every** session of
   * the user (this one included) in one transaction. A wrong current password
   * is a 400 (not 401: the session itself is still valid).
   */
  async changePassword(
    userId: string,
    email: string,
    { currentPassword, newPassword }: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    if (newPassword.trim().toLowerCase() === email) {
      throw fieldError('newPassword', 'Password must not be the same as your email address');
    }
    const hash = await this.accounts.findPasswordHash(userId);
    if (!hash) throw new NotFoundError('Account not found');
    if (!(await this.passwords.verify(hash, currentPassword))) {
      throw fieldError('currentPassword', 'Current password is incorrect');
    }
    const newHash = await this.passwords.hash(newPassword);
    if (!(await this.accounts.replacePassword(userId, hash, newHash))) {
      throw new ConflictError('Your password was just changed elsewhere. Please sign in again.');
    }
  }

  getSettings(userId: string): Promise<AccountSettings> {
    return this.accounts.findSettings(userId);
  }

  updateSettings(userId: string, changes: SettingsChanges): Promise<AccountSettings> {
    return this.accounts.updateSettings(userId, changes);
  }
}
