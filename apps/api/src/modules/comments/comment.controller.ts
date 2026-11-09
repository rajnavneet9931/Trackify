import type { Request, Response } from 'express';

import { sendSuccess } from '../../core/http/api-response.js';
import { getAuth } from '../sessions/index.js';
import type { CommentView } from './comment.model.js';
import type { CommentService } from './comment.service.js';
import type {
  CommentParams,
  CreateCommentBody,
  ListCommentsQuery,
  TaskCommentsParams,
  UpdateCommentBody,
} from './comment.validators.js';

/** Response shape for a comment. Built field by field so nothing else can leak. */
function toCommentResponse(comment: CommentView) {
  return {
    id: comment.id,
    taskId: comment.taskId,
    authorId: comment.authorId,
    // Only id and email, and only while the author is a member of this workspace.
    author: comment.author && { id: comment.author.id, email: comment.author.email },
    content: comment.content,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}

const targetOf = ({ workspaceId, projectId, taskId }: TaskCommentsParams) => ({
  workspaceId,
  projectId,
  taskId,
});

export class CommentController {
  constructor(private readonly service: CommentService) {}

  /** Author from the session; task (and its hierarchy) only from the URL. */
  create = async (req: Request, res: Response): Promise<void> => {
    const params = req.params as TaskCommentsParams;
    const { content } = req.body as CreateCommentBody;
    const comment = await this.service.create(targetOf(params), getAuth(req).user.id, content);
    sendSuccess(res, { comment: toCommentResponse(comment) }, 201);
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const params = req.params as TaskCommentsParams;
    const { limit, cursor } = req.query as unknown as ListCommentsQuery;
    const page = await this.service.list(targetOf(params), {
      userId: getAuth(req).user.id,
      limit,
      cursor,
    });

    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { comments: page.items.map(toCommentResponse) }, 200, {
      limit,
      nextCursor: page.nextCursor,
    });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const params = req.params as CommentParams;
    const body = req.body as UpdateCommentBody;
    const comment = await this.service.update(
      targetOf(params),
      params.commentId,
      getAuth(req).user.id,
      body,
    );
    sendSuccess(res, { comment: toCommentResponse(comment) });
  };

  delete = async (req: Request, res: Response): Promise<void> => {
    const params = req.params as CommentParams;
    await this.service.delete(targetOf(params), params.commentId, getAuth(req).user.id);
    sendSuccess(res, { deleted: true });
  };
}
