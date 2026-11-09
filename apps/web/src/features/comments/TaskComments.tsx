import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { FormAlert } from '../../components/form/FormAlert';
import { ApiError } from '../../lib/api-client';
import { usePaginatedList } from '../../lib/usePaginatedList';
import { useAuth } from '../auth/auth-context';
import {
  COMMENT_MAX_LENGTH,
  createComment,
  deleteComment,
  listComments,
  updateComment,
  type CommentTarget,
  type TaskComment,
} from './comments.api';
import { normalizeComment, validateComment } from './validation';
import { useDateTime } from '../account/preferences-context';
import { buttonClass } from '../../components/ui/styles';

const primaryButton = buttonClass('primary');
const secondaryButton = buttonClass('secondary');
const smallButton =
  'rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60';
const textareaClass = (invalid: boolean) =>
  `mt-1 block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:ring-2 focus:outline-none ${
    invalid
      ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-200'
      : 'border-slate-300 focus:border-brand-500 focus:ring-brand-100'
  }`;

const getKey = (comment: TaskComment) => comment.id;

type Action = 'post' | 'edit' | 'delete';

function describeError(error: unknown, action: Action): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  switch (error.status) {
    case 400:
      return error.message;
    case 403:
      return action === 'edit'
        ? 'You can only edit your own comments.'
        : 'You can only delete your own comments.';
    case 404:
      return 'This comment is no longer available. Reload the discussion.';
    case 409: // archived meanwhile, or changed meanwhile: API wording
      return error.message;
    case 0:
    case 503:
      return 'Trackify is temporarily unavailable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/**
 * A task's discussion, oldest first. Every member reads and posts; authors
 * edit their own comments; authors and workspace owners delete (after a
 * confirmation). Archived projects show the discussion read-only. The API
 * enforces every rule independently.
 */
export function TaskComments({
  target,
  currentUserId,
  isOwner,
  readOnly,
}: {
  target: CommentTarget;
  currentUserId: string;
  /** UX only: owners may delete anyone's comment (the API checks). */
  isOwner: boolean;
  /** UX only: archived projects (the API refuses changes). */
  readOnly: boolean;
}) {
  const dt = useDateTime();
  const { invalidateSession } = useAuth();
  const { workspaceId, projectId, taskId } = target;
  const fetchPage = useCallback(
    async (cursor: string | undefined, signal?: AbortSignal) => {
      const page = await listComments({ workspaceId, projectId, taskId }, { cursor }, signal);
      return { items: page.comments, nextCursor: page.nextCursor };
    },
    [workspaceId, projectId, taskId],
  );
  const { state, retry, loadMore, append, remove, update } = usePaginatedList({
    fetchPage,
    getKey,
    errorMessage: 'We couldn’t load the discussion. Please try again.',
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string }>();
  const inFlight = useRef(false);

  const handleSessionEnd = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      invalidateSession();
      return true;
    }
    return false;
  };

  async function confirmDelete(comment: TaskComment) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(comment.id);
    setNotice(undefined);
    try {
      await deleteComment(target, comment.id);
      remove(comment.id);
      setConfirmingDelete(null);
      setNotice({ tone: 'success', text: 'Comment deleted.' });
    } catch (error) {
      if (handleSessionEnd(error)) return;
      setConfirmingDelete(null);
      setNotice({ tone: 'error', text: describeError(error, 'delete') });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="comments-heading" className="mt-8">
      <h2 id="comments-heading" className="text-base font-semibold">
        Comments
      </h2>
      {readOnly && (
        <p className="mt-1 text-sm text-slate-600">
          This project is archived, so the discussion is read-only.
        </p>
      )}

      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            notice.tone === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          }`}
        >
          {notice.text}
        </p>
      )}

      {state.status === 'loading' && (
        <p role="status" className="mt-4 text-sm text-slate-500">
          Loading comments…
        </p>
      )}

      {state.status === 'error' && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
        >
          <p>{state.message}</p>
          <button type="button" onClick={retry} className={`mt-3 ${secondaryButton}`}>
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && state.items.length === 0 && (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
          No comments yet.{readOnly ? '' : ' Start the discussion below.'}
        </p>
      )}

      {state.status === 'ready' && state.items.length > 0 && (
        <>
          <ol
            aria-label="Comments"
            className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-panel"
          >
            {state.items.map((comment) => {
              const mine = comment.authorId === currentUserId;
              const canEdit = mine && !readOnly;
              const canDelete = (mine || isOwner) && !readOnly;
              const edited = comment.updatedAt !== comment.createdAt;
              return (
                <li
                  key={comment.id}
                  aria-label={mine ? 'Your comment' : undefined}
                  className={`px-5 py-4 ${mine ? 'bg-brand-50/50' : ''}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-medium break-words text-slate-900">
                      {comment.author ? comment.author.email : 'Former member'}
                      {mine && <span className="ml-1 font-normal text-slate-500">(you)</span>}
                    </p>
                    <p className="text-xs text-slate-500">
                      <time dateTime={comment.createdAt}>{dt.format(comment.createdAt)}</time>
                      {edited && <span> · edited</span>}
                    </p>
                  </div>

                  {editing === comment.id ? (
                    <EditCommentForm
                      target={target}
                      comment={comment}
                      onCancel={() => setEditing(null)}
                      onSaved={(saved) => {
                        update(saved.id, () => saved);
                        setEditing(null);
                        setNotice({ tone: 'success', text: 'Comment updated.' });
                      }}
                      onReload={() => {
                        setEditing(null);
                        setNotice(undefined);
                        retry();
                      }}
                    />
                  ) : (
                    <p className="mt-1 text-sm break-words whitespace-pre-line text-slate-700">
                      {comment.content}
                    </p>
                  )}

                  {editing !== comment.id && confirmingDelete === comment.id && (
                    <div
                      role="group"
                      aria-label="Confirm deleting this comment"
                      className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
                    >
                      <p>Delete this comment? This cannot be undone.</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void confirmDelete(comment)}
                          disabled={pending !== null}
                          className={`${smallButton} bg-rose-600 text-white hover:bg-rose-700 focus-visible:outline-rose-600`}
                        >
                          {pending === comment.id ? 'Deleting…' : 'Delete comment'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(null)}
                          disabled={pending !== null}
                          className={`${smallButton} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:outline-brand-600`}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {editing !== comment.id &&
                    confirmingDelete !== comment.id &&
                    (canEdit || canDelete) && (
                      <div className="mt-2 flex gap-2">
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => {
                              setNotice(undefined);
                              setConfirmingDelete(null);
                              setEditing(comment.id);
                            }}
                            disabled={pending !== null}
                            className={`${smallButton} text-brand-700 hover:bg-brand-50 focus-visible:outline-brand-600`}
                          >
                            Edit
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => {
                              setNotice(undefined);
                              setEditing(null);
                              setConfirmingDelete(comment.id);
                            }}
                            disabled={pending !== null}
                            aria-label={mine ? 'Delete your comment' : 'Delete this comment'}
                            className={`${smallButton} text-rose-700 hover:bg-rose-50 focus-visible:outline-rose-600`}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                </li>
              );
            })}
          </ol>

          {state.loadMoreError && (
            <p role="alert" className="mt-4 text-sm text-rose-700">
              {state.loadMoreError}
            </p>
          )}

          {state.nextCursor && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={state.loadingMore}
                className={secondaryButton}
              >
                {state.loadingMore ? 'Loading…' : 'Load more comments'}
              </button>
            </div>
          )}
        </>
      )}

      {!readOnly && state.status === 'ready' && (
        <NewCommentForm
          target={target}
          onPosted={(comment) => {
            const shown = append(comment);
            setNotice({
              tone: 'success',
              text: shown
                ? 'Comment posted.'
                : 'Comment posted. Load more comments to see it at the end of the discussion.',
            });
          }}
          onSessionEnd={handleSessionEnd}
        />
      )}
    </section>
  );
}

function NewCommentForm({
  target,
  onPosted,
  onSessionEnd,
}: {
  target: CommentTarget;
  onPosted: (comment: TaskComment) => void;
  onSessionEnd: (error: unknown) => boolean;
}) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setFormError(undefined);
    const invalid = validateComment(content);
    setError(invalid);
    if (invalid) {
      ref.current?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      const { comment } = await createComment(target, normalizeComment(content));
      setContent('');
      onPosted(comment);
    } catch (err) {
      if (onSessionEnd(err)) return;
      setFormError(describeError(err, 'post'));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const errorId = error ? `${id}-error` : undefined;
  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      aria-busy={submitting}
      aria-label="Add a comment"
      className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      {formError && <FormAlert>{formError}</FormAlert>}
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-slate-800">
          Add a comment
        </label>
        <textarea
          ref={ref}
          id={id}
          name="content"
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          readOnly={submitting}
          aria-invalid={error ? true : undefined}
          aria-describedby={errorId}
          className={textareaClass(Boolean(error))}
        />
        {error ? (
          <p id={errorId} className="mt-1 text-sm text-rose-600">
            {error}
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-500">Up to {COMMENT_MAX_LENGTH} characters.</p>
        )}
      </div>
      <button type="submit" disabled={submitting} className={primaryButton}>
        {submitting ? 'Posting…' : 'Post comment'}
      </button>
    </form>
  );
}

function EditCommentForm({
  target,
  comment,
  onSaved,
  onCancel,
  onReload,
}: {
  target: CommentTarget;
  comment: TaskComment;
  onSaved: (comment: TaskComment) => void;
  onCancel: () => void;
  onReload: () => void;
}) {
  const { invalidateSession } = useAuth();
  const [content, setContent] = useState(comment.content);
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  useEffect(() => ref.current?.focus(), []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setFormError(undefined);
    setConflict(false);
    const invalid = validateComment(content);
    setError(invalid);
    if (invalid) {
      ref.current?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      const { comment: saved } = await updateComment(target, comment.id, {
        content: normalizeComment(content),
        expectedUpdatedAt: comment.updatedAt,
      });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession();
        return;
      }
      setFormError(describeError(err, 'edit'));
      setConflict(err instanceof ApiError && err.status === 409);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const errorId = error ? `${id}-error` : undefined;
  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      aria-busy={submitting}
      aria-label="Edit comment"
      className="mt-2 space-y-2"
    >
      {formError && (
        <FormAlert>
          <p>{formError}</p>
          {conflict && (
            <button
              type="button"
              onClick={onReload}
              className="mt-2 text-sm font-medium underline hover:no-underline"
            >
              Reload discussion
            </button>
          )}
        </FormAlert>
      )}
      <label htmlFor={id} className="sr-only">
        Edit comment
      </label>
      <textarea
        ref={ref}
        id={id}
        name="content"
        rows={3}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        readOnly={submitting}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={textareaClass(Boolean(error))}
      />
      {error && (
        <p id={errorId} className="text-sm text-rose-600">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={submitting} className={primaryButton}>
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}
