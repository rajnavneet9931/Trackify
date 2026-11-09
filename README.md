# Trackify

**A full-stack team collaboration and project management platform.**

Trackify helps teams organize work through workspaces, projects, tasks, assignments, deadlines, comments, and activity tracking. It provides role-based workspace management, in-app notifications, and project-level analytics through a modern web interface.

Built as a TypeScript monorepo with a React frontend and a modular-monolith REST API.

---

## Features

### Authentication & Account Management

- User registration and login.
- Secure server-side session management.
- Argon2id password hashing.
- Profile and account preference management.
- Password changes with session invalidation.

### Workspace Management

- Create and manage workspaces.
- Invite existing Trackify users.
- Workspace membership and role management.
- Owner and Member roles with authorization enforcement.
- Remove members and manage workspace settings.
- Workspace-level dashboard and analytics.

### Project Management

- Create and manage projects within workspaces.
- Project details and descriptions.
- Archive and restore projects.
- Controlled permanent project deletion.
- Cursor-based project pagination.

### Task Management

- Create, view, and update tasks from each project's **Tasks** section (open a project from its
  card on the workspace overview, then **Create task**).
- Set the status and assignee when creating a task (the assignee must be a workspace member),
  and change a task's status directly from the task list.
- Task statuses: `TODO`, `IN_PROGRESS`, `DONE`.
- Priority levels: `LOW`, `MEDIUM`, `HIGH`, `URGENT`.
- Assign, reassign, and unassign tasks.
- Due dates and reminders.
- Search, filtering, sorting, and pagination.
- Archived projects remain readable but are read-only.

### Collaboration

- Task-level comments and discussions.
- Comment editing and deletion with ownership rules.
- Automatic task activity history.
- Track status, priority, and assignment changes.
- In-app notifications for assignments, comments, and reminders.

### Dashboard & Notifications

- Workspace-level task and project statistics.
- Project completion overview.
- Personal task overview.
- Upcoming deadlines and overdue tasks.
- Recent workspace activity.
- Notification center with unread counts and read/unread management.

### User Preferences

- Display name management.
- Timezone and date format preferences.
- Notification preferences.

---

## Technology Stack

| Layer           | Technologies                   |
| --------------- | ------------------------------ |
| Frontend        | React 19, TypeScript, Vite     |
| Routing         | React Router                   |
| Styling         | Tailwind CSS 4                 |
| Backend         | Node.js, TypeScript, Express 5 |
| Database        | PostgreSQL                     |
| ORM             | Prisma ORM 7                   |
| Database Driver | `@prisma/adapter-pg`           |
| Validation      | Zod                            |
| Logging         | Pino                           |
| Testing         | Vitest, Supertest              |
| Code Quality    | ESLint, Prettier               |

---

## Architecture

Trackify follows a **modular monolith architecture** with clear separation of responsibilities.

### Backend request flow

```text
Client Request
     |
     v
   Routes
     |
     v
 Controller
     |
     v
   Service
     |
     v
 Repository
     |
     v
 PostgreSQL
```

Each backend feature is organized into independent modules.

- **Routes:** API endpoints and request validation.
- **Controllers:** Handle HTTP requests and responses.
- **Services:** Contain business logic and authorization rules.
- **Repositories:** Encapsulate database operations.
- **Module composition:** Connect dependencies through explicit dependency injection.

The application factory supports dependency injection, allowing API tests to run with isolated dependencies.

### Repository Structure

```text
trackify/
├── apps/
│   ├── api/
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   ├── src/
│   │   │   ├── config/
│   │   │   ├── core/
│   │   │   ├── infrastructure/
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── health/
│   │   │   │   ├── sessions/
│   │   │   │   ├── users/
│   │   │   │   └── workspaces/
│   │   │   ├── routes/
│   │   │   ├── app.ts
│   │   │   └── server.ts
│   │   └── tests/
│   └── web/
│       └── src/
│           ├── app/
│           ├── config/
│           ├── features/
│           ├── layouts/
│           ├── lib/
│           └── pages/
├── docker-compose.yml
├── eslint.config.js
└── package.json
```

---

## Getting Started

### Prerequisites

- Node.js 20.19 or later (Node.js 22 LTS recommended).
- npm.
- PostgreSQL 15 or later, or Docker with Docker Compose.

### 1. Clone the repository

```bash
git clone <your-repository-url>
cd Trackify
```

### 2. Install dependencies

```bash
npm install
```

This installs dependencies across all workspaces and generates the Prisma Client.

### 3. Configure environment variables

Create the API environment file:

```bash
cp apps/api/.env.example apps/api/.env
```

Create the frontend environment file:

```bash
cp apps/web/.env.example apps/web/.env
```

Update the environment values according to your local setup.

The API requires a valid PostgreSQL connection through `DATABASE_URL`. If using a pooled database connection, configure `DIRECT_DATABASE_URL` for Prisma CLI operations.

Refer to the example environment files for the complete configuration.

### 4. Start PostgreSQL

Using Docker Compose:

```bash
docker compose up -d
```

Check that the database is running:

```bash
docker compose ps
```

Alternatively, configure an existing PostgreSQL database.

### 5. Apply database migrations

```bash
npm run db:deploy
```

Check database connectivity and migration status:

```bash
npm run db:check
npm run db:status
```

### 6. Start the application

```bash
npm run dev
```

The application runs locally at:

| Service       | URL                                                                                    |
| ------------- | -------------------------------------------------------------------------------------- |
| Frontend      | [http://localhost:5173](http://localhost:5173)                                         |
| Backend API   | [http://localhost:4000](http://localhost:4000)                                         |
| API Liveness  | [http://localhost:4000/api/v1/health](http://localhost:4000/api/v1/health)             |
| API Readiness | [http://localhost:4000/api/v1/health/ready](http://localhost:4000/api/v1/health/ready) |

The Vite development server proxies `/api` requests to the backend.

---

## Available Scripts

Run commands from the repository root.

| Command                    | Description                                                |
| -------------------------- | ---------------------------------------------------------- |
| `npm run dev`              | Start frontend and backend in development mode             |
| `npm run dev:api`          | Start backend only                                         |
| `npm run dev:web`          | Start frontend only                                        |
| `npm run build`            | Build all workspaces                                       |
| `npm run typecheck`        | TypeScript type checking                                   |
| `npm run lint`             | Run ESLint                                                 |
| `npm run format`           | Format using Prettier                                      |
| `npm test`                 | Run test suites                                            |
| `npm run verify`           | Format check, lint, typecheck, tests, and production build |
| `npm run db:generate`      | Generate Prisma Client                                     |
| `npm run db:deploy`        | Apply pending database migrations                          |
| `npm run db:status`        | Check migration status                                     |
| `npm run db:drift`         | Check database schema drift                                |
| `npm run test:integration` | Run real PostgreSQL integration tests                      |

---

## Database & Migrations

Trackify uses PostgreSQL with Prisma ORM 7 and the `@prisma/adapter-pg` driver adapter.

### Database configuration

| Variable              | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| `DATABASE_URL`        | Runtime API database connection                      |
| `DIRECT_DATABASE_URL` | Direct database connection for Prisma CLI operations |
| `TEST_DATABASE_URL`   | Separate integration-test database                   |

### Creating a migration

Generate a migration without applying it:

```bash
npm run db:migrate -- --create-only --name <migration_name>
```

Review the generated SQL before applying it.

Apply migrations:

```bash
npm run db:deploy
npm run db:test:deploy
```

Check schema consistency:

```bash
npm run db:drift
```

**Important:** Never run development migrations against production. Use `prisma migrate deploy` to apply committed migrations without resetting the database.

### Integration test database safety

Real PostgreSQL integration tests require a separate test database.

The test setup includes database safety guards that prevent tests from writing to the development database.

Configure the test environment using:

```bash
cp apps/api/.env.test.example apps/api/.env.test
```

Then apply migrations and run:

```bash
npm run db:test:deploy
npm run test:integration
```

---

## Security

Security is incorporated into the API and application architecture.

Key protections include:

- Argon2id password hashing.
- Server-side sessions with hashed session tokens.
- HttpOnly and SameSite cookies.
- CSRF protection for state-changing requests.
- Origin and Fetch Metadata validation.
- Restrictive CORS configuration.
- Helmet security headers.
- API rate limiting.
- Request validation using strict Zod schemas.
- Request body size limits.
- Workspace-level authorization and resource isolation.
- Centralized error handling without exposing internal stack traces.
- Sensitive information redaction in application logs.
- Environment validation at startup.

### Authorization model

Trackify uses two workspace roles:

| Permission                | OWNER | MEMBER |
| ------------------------- | :---: | :----: |
| View workspace            |  Yes  |  Yes   |
| Manage workspace settings |  Yes  |   No   |
| Delete workspace          |  Yes  |   No   |
| Create projects           |  Yes  |   No   |
| Manage project lifecycle  |  Yes  |   No   |
| View projects             |  Yes  |  Yes   |
| Create and manage tasks   |  Yes  |  Yes   |
| Assign tasks              |  Yes  |  Yes   |
| Comment on tasks          |  Yes  |  Yes   |
| Manage workspace members  |  Yes  |   No   |
| Change member roles       |  Yes  |   No   |

All permissions are enforced by the backend, not just hidden in the frontend.

---

## API Conventions

Base URL:

```text
/api/v1
```

Successful responses follow a consistent structure:

```json
{
  "data": {
    "message": "Success"
  }
}
```

Paginated responses may also include metadata:

```json
{
  "data": {
    "items": []
  },
  "meta": {
    "limit": 20,
    "nextCursor": null
  }
}
```

Error responses follow a consistent structure:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "requestId": "request-id"
  }
}
```

Every API response includes an `X-Request-Id` header for request tracing.

---

## Current Limitations

The following functionality is not implemented yet:

- Email delivery for workspace invitations.
- Email and push notifications.
- Task deletion.
- Leaving a workspace.
- Invitation delivery to users in production.

Workspace invitations currently support existing Trackify users. Development invitation links can be shared manually; no email provider is configured.

Rate-limit counters are currently maintained in process memory. Production deployments with multiple API instances should add an appropriate shared rate-limit store or enforce additional limits at the edge.

---

## Development Principles

Trackify follows these engineering principles:

- Modular monolith rather than unnecessary microservices.
- Separation of business logic and database access.
- Strict request validation.
- Explicit authorization checks.
- Transactional database operations.
- Cursor-based pagination for scalable listing.
- Optimistic concurrency for supported updates.
- Automated unit, API, and integration tests.
- Safe database migration practices.
- No secrets committed to source control.

---

## Project Status

Trackify is under active development.

The repository contains the frontend application, REST API, database schema and migrations, authentication, workspace and project management, task collaboration, notifications, and account management functionality.

Production deployment and release readiness should be validated separately.
