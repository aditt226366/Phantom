"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { sendMessageAction, sendTemplateAction, type SendState } from "../actions";
import { TemplatePicker, type PickableTemplate } from "./template-picker";

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
  templateCsrf,
  templates,
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
  /** A second field for the picker's own form. Server-rendered, like the first. */
  templateCsrf: ReactNode;
  /** Approved templates, which are the only ones that may be sent. */
  templates: PickableTemplate[];
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

        {/* Still disabled, still saying when. Outbound media is Phase 5 (P4):
            a browser upload is a different trust boundary from reading a URL
            Meta gave us with our own token. */}
        <Button type="button" variant="ghost" disabled>
          Sending files arrives in Phase 5
        </Button>
      </div>
    </form>
  );
}

/**
 * The composer and the template picker, together.
 *
 * They are two forms rather than one, because they post to different actions
 * and a single form would have to decide which - and the decision is the
 * tenant's, made by which button they press.
 *
 * The picker renders whether the window is open or closed. Closed is the case
 * it exists for; open is when somebody wants a consistent message rather than a
 * typed one. What changes with the window is only which of the two is
 * disabled - and 4a's disabled placeholder is gone, replaced by the thing it
 * was promising.
 */
export function ComposerBlock({
  conversationId,
  closedReason,
  csrf,
  templateCsrf,
  templates,
}: {
  conversationId: string;
  closedReason: string | null;
  csrf: ReactNode;
  templateCsrf: ReactNode;
  templates: PickableTemplate[];
}) {
  return (
    <div className="flex flex-col gap-lg">
      <Composer
        conversationId={conversationId}
        closedReason={closedReason}
        csrf={csrf}
        templateCsrf={templateCsrf}
        templates={templates}
      />

      <div className="border-t border-hairline pt-base">
        <p className="mb-sm text-caption-uppercase uppercase text-muted">
          Or send a template
        </p>
        <TemplatePicker
          templates={templates}
          conversationId={conversationId}
          action={sendTemplateAction}
          csrf={templateCsrf}
        />
      </div>
    </div>
  );
}
