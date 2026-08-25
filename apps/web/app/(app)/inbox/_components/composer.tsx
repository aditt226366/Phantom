"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { sendMessageAction, type SendState } from "../actions";

/**
 * The composer, which closes with the window.
 *
 * Three controls are deliberately visible and disabled rather than absent, each
 * naming when it arrives. A missing control reads as a product that cannot do
 * something; a disabled one with a date reads as a product that will.
 *
 *   the template picker    disabled whether the window is open or closed, and
 *                          the amendment that closed-window shows a disabled
 *                          picker rather than nothing is the reason it renders
 *                          at all - it is what somebody reaches for when the
 *                          24 hours have run out
 *   attach                 P4: outbound media is Phase 5, because a browser
 *                          upload is a different trust boundary from reading
 *                          a URL Meta gave us with our own token
 *   send                   disabled with the textarea when the window is shut
 */
export function Composer({
  conversationId,
  closedReason,
  csrf,
}: {
  conversationId: string;
  /** The sentence explaining why sending is refused, or null if it is not. */
  closedReason: string | null;
  /**
   * `<CsrfField />`, rendered by the page and passed in.
   *
   * Not imported here: it is a Server Component because `cookies()` is
   * server-only, and importing it from a client module drags lib/auth/csrf.ts
   * into the browser graph, which fails the build on `server-only`. Server
   * components pass through client components as props, which is the same
   * arrangement the app shell already uses for this exact field.
   */
  csrf: ReactNode;
}) {
  const [state, formAction, pending] = useActionState<SendState, FormData>(
    sendMessageAction,
    {},
  );

  const disabled = closedReason !== null;

  return (
    <form action={formAction} className="flex flex-col gap-sm">
      {csrf}
      <input type="hidden" name="conversationId" value={conversationId} />

      {closedReason ? (
        <p className="rounded-md border border-hairline-strong bg-surface-strong px-sm py-xs text-caption text-body-strong">
          {closedReason}
        </p>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-caption text-error">
          {state.error}
        </p>
      ) : null}

      <textarea
        name="body"
        rows={3}
        disabled={disabled}
        defaultValue={state.draft ?? ""}
        aria-label="Message"
        placeholder={
          disabled ? "The window is closed" : "Write a reply…"
        }
        className="w-full rounded-md border border-hairline-strong bg-surface-card px-sm py-xs text-body-sm text-ink placeholder:text-muted-soft disabled:bg-surface-strong disabled:text-muted"
      />

      <div className="flex flex-wrap items-center gap-xs">
        <Button type="submit" disabled={disabled || pending}>
          {pending ? "Sending…" : "Send"}
        </Button>

        {/* Disabled, present, and each says when. See the note above. */}
        <Button type="button" variant="outline" disabled>
          Templates arrive in 4b
        </Button>
        <Button type="button" variant="ghost" disabled>
          Sending files arrives in Phase 5
        </Button>
      </div>
    </form>
  );
}
