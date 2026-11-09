// Public API of the users module. Other modules import from here only.
export { emailSchema } from './email-schema.js';
export { EMAIL_MAX_LENGTH, normalizeEmail, type PublicUser } from './user.model.js';
export {
  EmailAlreadyRegisteredError,
  PrismaUserRepository,
  type NewUser,
  type UserCredentials,
  type UserDirectory,
  type UserRepository,
} from './user.repository.js';
