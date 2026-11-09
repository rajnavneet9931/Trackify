export const COMMENT_CONTENT_MAX_LENGTH = 5000;
export const COMMENT_PAGE_SIZE_DEFAULT = 20;
export const COMMENT_PAGE_SIZE_MAX = 50;

/** Minimal author info; null once the author is no longer a member of the workspace. */
export interface CommentAuthor {
  id: string;
  email: string;
}

/** Fields returned by the API for a comment. */
export interface CommentView {
  id: string;
  taskId: string;
  /** The author's user ID: always the authenticated user who created it. */
  authorId: string;
  author: CommentAuthor | null;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Prisma select for a comment in one workspace. The author's email is
 * included only while they are a member of that workspace (the same people
 * the member list shows); never password hashes or sessions.
 */
export const commentSelect = (workspaceId: string) =>
  ({
    id: true,
    taskId: true,
    userId: true,
    content: true,
    createdAt: true,
    updatedAt: true,
    user: {
      select: {
        id: true,
        email: true,
        memberships: { where: { workspaceId }, select: { id: true }, take: 1 },
      },
    },
  }) as const;

interface CommentRow {
  id: string;
  taskId: string;
  userId: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  user: { id: string; email: string; memberships: { id: string }[] };
}

export function toCommentView({ user, userId, ...comment }: CommentRow): CommentView {
  return {
    ...comment,
    authorId: userId,
    author: user.memberships.length > 0 ? { id: user.id, email: user.email } : null,
  };
}
