import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JOB_NAMES, markReadJobId } from "@whatsapp-os/core/queues";
import { describeWindow } from "@whatsapp-os/core/whatsapp";
import { canSend, readReceiptTarget, withCompany } from "@whatsapp-os/db";
import { Badge } from "@/components/ui/badge";
import { CsrfField } from "@/components/ui/csrf-field";
import { requireSession } from "@/lib/auth/session";
import { formatTimestamp } from "@/lib/format";
import { contactLabel, windowLabel, windowVariant } from "@/lib/inbox-display";
import { systemQueue } from "@/lib/queue";
import {
  refusalSentence,
  retryOffer,
  statusDisplay,
} from "@/lib/thread-display";
import { Button } from "@/components/ui/button";
import { SectionShell } from "../../_components/section";
import {
  releaseConversationAction,
  takeConversationAction,
} from "../actions";
import { ComposerBlock } from "../_components/composer";
import { RetryButton } from "../_components/retry-button";
import { ThreadRefresh } from "../_components/thread-refresh";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";

export const metadata: Metadata = { title: "Conversation" };

/* A thread moves. Never prerendered, never served from a cached render. */
export const dynamic = "force-dynamic";

/**
 * One conversation, and a composer that closes with the window.
 *
 * ---------------------------------------------------------------------------
 * Opening a thread tells Meta it was read
 * ---------------------------------------------------------------------------
 *
 * One of the phase's five amendments. Two things stop it becoming a POST per
 * render: readReceiptTarget answers null when nothing is unread, which is the
 * ordinary case because people re-open read threads constantly; and the job id
 * names the conversation AND the newest inbound message, so three opens inside
 * an hour collapse into one job.
 *
 * The enqueue is wrapped, and that is not defensive habit. Redis being down
 * must not turn a thread into a 500 — a read receipt is a courtesy to the
 * customer, and the messages are the point of the page.
 *
 * Worth knowing when a baseline moves: running the screenshot suite with a
 * worker consuming this queue lets a read receipt clear the unread badge
 * between the inbox shot and this one. The suite is not run with a worker.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();
  /*
   * A4's gate, here rather than in the layout. A layout is cached per
   * segment and is not guaranteed to re-execute, so a check there is one
   * a tenant can navigate around. Rule 4.
   */
  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="The inbox" />;
  }

  const { conversationId } = await params;

  const now = new Date();

  const loaded = await withCompany(session.companyId, async (db, companyId) => {
    const conversation = await db.conversation.findFirst({
      where: { id: conversationId },
      select: {
        id: true,
        windowExpiresAt: true,
        needsHumanAt: true,
        needsHumanReason: true,
        assignedUserId: true,
        assignedUser: { select: { fullName: true } },
        contact: {
          select: {
            displayName: true,
            profileName: true,
            phoneE164: true,
            waId: true,
          },
        },
        whatsappNumber: { select: { displayNumber: true } },
      },
    });

    if (!conversation) return null;

    const messages = await db.message.findMany({
      where: { conversationId },
      /* Reading order, tie-broken on id: Meta's granularity is one second, so
         two messages sharing a timestamp is ordinary rather than exotic. */
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: 200,
      select: {
        id: true,
        direction: true,
        status: true,
        type: true,
        body: true,
        errorSource: true,
        errorCode: true,
        errorTitle: true,
        /* Only to decide whether a retry may be offered - never rendered.
           Meta names a message when it accepts it, and the send worker refuses
           to post one that already carries a name. */
        wamid: true,
        occurredAt: true,
        media: {
          select: { id: true, mimeType: true, fileName: true, state: true },
        },
      },
    });

    const sendability = await canSend(
      db,
      companyId,
      conversationId,
      { kind: "freeform" },
      now,
    );

    return {
      conversation,
      messages,
      sendability,
      receipt: await readReceiptTarget(db, companyId, conversationId),
      /* Approved only. The picker must not offer something Meta will refuse -
         an unapproved template posted anyway counts against the number's
         quality rating, which is the thing a tenant cannot get back. */
      templates: await db.whatsAppTemplate.findMany({
        where: { status: "APPROVED" },
        orderBy: [{ name: "asc" }],
        take: 50,
        select: { id: true, name: true, language: true, components: true },
      }),
    };
  });

  /* Rule 6: not yours means it does not exist. Same answer as never having. */
  if (!loaded) notFound();

  const { conversation, messages, sendability, receipt, templates } = loaded;

  if (receipt) {
    try {
      await systemQueue.add(
        JOB_NAMES.WHATSAPP_MARK_READ,
        { companyId: session.companyId, conversationId },
        { jobId: markReadJobId(conversationId, receipt.messageId) },
      );
    } catch {
      /* See the note above: a read receipt is not worth a 500. */
    }
  }

  const window = describeWindow(conversation.windowExpiresAt, now);

  /*
   * Whether a flow is standing in this conversation.
   *
   * -------------------------------------------------------------------------
   * Why the thread has to say so, and especially when the run is paused
   * -------------------------------------------------------------------------
   *
   * A flow's messages are ordinary message rows, which is the phase's whole
   * claim and the reason this page needed no changes to render them. The cost
   * of that is invisibility: an operator reading a thread sees questions their
   * team did not write, with no indication that anything is still running.
   *
   * For a PAUSED run that is worse than untidy. The picture is a closed window,
   * a disabled composer and a template picker - which reads as an ordinary
   * lapsed conversation, when what is actually true is that a customer is
   * halfway down a tree and sending the flow's opening template puts them back
   * exactly where they stopped. Without this line the operator either does
   * nothing, or sends a different template and quietly ends the run.
   */
  const flowRun = await withCompany(session.companyId, (db) =>
    db.flowRun.findFirst({
      where: { activeConversationId: conversationId },
      select: {
        id: true,
        status: true,
        flow: { select: { name: true } },
        flowVersion: { select: { template: { select: { name: true } } } },
      },
    }),
  );

  const closedReason =
    sendability && !sendability.decision.allowed
      ? refusalSentence(sendability.decision.reason)
      : null;

  return (
    <SectionShell>
      <ThreadRefresh />

      <header className="mb-lg">
        <Link
          href="/inbox"
          className="text-caption text-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Back to inbox
        </Link>

        <div className="mt-xs flex flex-wrap items-center gap-sm">
          <h1 className="min-w-0 break-words text-display-md text-ink">
            {contactLabel(conversation.contact)}
          </h1>
          <Badge variant={windowVariant(window)}>{windowLabel(window)}</Badge>
        </div>

        <p className="mt-xxs text-body-sm text-muted">
          On {conversation.whatsappNumber.displayNumber}
        </p>

        {conversation.needsHumanAt ? (
          <div className="mt-sm flex flex-wrap items-center justify-between gap-sm rounded-lg border border-hairline-strong bg-surface-card px-base py-sm">
            <p className="min-w-0 text-body-sm text-body">
              <span className="text-body-strong text-ink">
                Somebody asked for a person here.
              </span>{" "}
              {conversation.needsHumanReason}
            </p>
            {/*
              * Taking it is a decision, so it is a button.
              *
              * Deliberately not cleared by rendering this page. Opening a
              * thread is how somebody decides whether they want it, and a
              * queue that emptied on being looked at is the exact bug the
              * needs_human_at column replaced.
              *
              * One action, two labels. A thread can legitimately be flagged
              * AND assigned - the flag is stored state and assignment is what
              * clears it, so anything that sets one without the other leaves
              * both true - but offering "Take this" to the person who already
              * has it is nonsense. The action is idempotent, so pressing it
              * from that state simply clears the flag, which is what the
              * second label says.
              */}
            <form action={takeConversationAction}>
              <CsrfField />
              <input type="hidden" name="conversationId" value={conversationId} />
              <Button type="submit">
                {conversation.assignedUserId === session.userId
                  ? "Mark as handled"
                  : "Take this"}
              </Button>
            </form>
          </div>
        ) : null}

        {conversation.assignedUser && !conversation.needsHumanAt ? (
          <p className="mt-sm text-caption text-muted">
            {conversation.assignedUserId === session.userId ? (
              <>
                You have this conversation.{" "}
                <span className="inline-block align-middle">
                  <form action={releaseConversationAction}>
                    <CsrfField />
                    <input
                      type="hidden"
                      name="conversationId"
                      value={conversationId}
                    />
                    <Button type="submit" variant="ghost">
                      Put it back
                    </Button>
                  </form>
                </span>
              </>
            ) : (
              `${conversation.assignedUser.fullName} has this conversation.`
            )}
          </p>
        ) : null}

        {flowRun ? (
          <p className="mt-sm rounded-lg border border-hairline bg-surface-card px-base py-sm text-body-sm text-body">
            {flowRun.status === "PAUSED" ? (
              <>
                <span className="text-body-strong text-ink">
                  {flowRun.flow.name}
                </span>{" "}
                is waiting to resume. The 24-hour window closed before this
                customer answered, so the flow kept their place. Sending{" "}
                <span className="text-body-strong text-ink">
                  {flowRun.flowVersion.template.name}
                </span>{" "}
                picks them up where they stopped rather than starting again.
              </>
            ) : (
              <>
                <span className="text-body-strong text-ink">
                  {flowRun.flow.name}
                </span>{" "}
                is running in this conversation. Replying yourself hands it to
                you and stops the flow.
              </>
            )}
          </p>
        ) : null}
      </header>

      <ol className="flex flex-col gap-sm">
        {messages.map((message) => (
            <MessageBubble
            key={message.id}
            message={message}
            csrf={<CsrfField />}
          />
        ))}
      </ol>

      <div className="mt-lg">
        <ComposerBlock
          conversationId={conversation.id}
          closedReason={closedReason}
          csrf={<CsrfField />}
          templateCsrf={<CsrfField />}
          templates={templates.map((template) => ({
            id: template.id,
            name: template.name,
            language: template.language,
            body: templateBody(template.components),
          }))}
        />
      </div>
    </SectionShell>
  );
}

interface ThreadMessage {
  id: string;
  direction: string;
  status: string;
  type: string;
  body: string | null;
  errorSource: string | null;
  errorCode: number | null;
  errorTitle: string | null;
  wamid: string | null;
  occurredAt: Date;
  media: {
    id: string;
    mimeType: string;
    fileName: string | null;
    state: string;
  } | null;
}

const TONE_CLASS = {
  muted: "text-muted",
  success: "text-success",
  error: "text-error",
  /* No warning token exists in globals.css and inventing one at a call site
     would be a literal outside it. The sentence carries the weight instead. */
  warning: "text-body-strong",
} as const;

function MessageBubble({
  message,
  csrf,
}: {
  message: ThreadMessage;
  csrf: ReactNode;
}) {
  const outbound = message.direction === "OUTBOUND";
  const status = statusDisplay(message.status);
  const retry = outbound ? retryOffer(message.status, message.wamid !== null) : null;
  const explanation = message.errorTitle ?? status.detail ?? null;

  return (
    <li className={outbound ? "flex justify-end" : "flex justify-start"}>
      {/* max-w through a measure token, never a size utility named after a
          spacing key — max-w-md resolves to 20px in this config. */}
      <div
        className={
          outbound
            ? "min-w-0 max-w-narrow rounded-xl border border-hairline-strong bg-surface-strong p-sm"
            : "min-w-0 max-w-narrow rounded-xl border border-hairline bg-surface-card p-sm"
        }
      >
        {message.media ? <MediaBlock media={message.media} /> : null}

        {message.body ? (
          <p className="whitespace-pre-wrap break-words text-body-sm text-ink">
            {message.body}
          </p>
        ) : message.media ? null : (
          /* An unrecognised Meta type stores as itself and renders here, so the
             gap is visible and the row survives. */
          <p className="text-body-sm text-muted">
            Unsupported message type: {message.type}
          </p>
        )}

        <div className="mt-xs flex flex-wrap items-center gap-xs">
          <span className="text-caption text-muted-soft">
            {formatTimestamp(message.occurredAt)}
          </span>
          {outbound ? (
            <span className={`text-caption ${TONE_CLASS[status.tone]}`}>
              {status.label}
            </span>
          ) : null}
        </div>

        {/*
         * One sentence, not three.
         *
         * The stored reason wins over the generic one, because it is what this
         * row actually holds - and for UNCONFIRMED the two say the same thing,
         * so rendering both stacked a near-identical warning twice above a
         * retry button that warned a third time. statusDisplay's copy is the
         * fallback for the case with no stored reason, which is HELD.
         *
         * Red only when somebody actually refused. errorSource is null on an
         * UNCONFIRMED row on purpose - META would claim Meta refused it, which
         * it did not, and POLICY would claim we declined, which we also did not
         * - so colouring it as an error would assert a verdict nobody gave.
         * A populated title beside a null source means "no verdict", and it
         * should read as one.
         *
         * The code is only ever shown for META, so quoting a Graph code Meta
         * never issued is not expressible here.
         */}
        {explanation ? (
          <p
            className={
              message.errorSource !== null
                ? "mt-xs text-caption text-error"
                : "mt-xs text-caption text-body-strong"
            }
          >
            {message.errorSource === "META" && message.errorCode !== null
              ? `Meta ${message.errorCode}: ${explanation}`
              : explanation}
          </p>
        ) : null}

        {retry ? (
          <RetryButton
            messageId={message.id}
            label={retry.label}
            warning={retry.warning}
            csrf={csrf}
          />
        ) : null}
      </div>
    </li>
  );
}

function MediaBlock({ media }: { media: NonNullable<ThreadMessage["media"]> }) {
  if (media.state !== "STORED") {
    /* over_max_size is the expected one and is not an error — the thread says
       so and the file name survives, which is what makes the gap legible. */
    return (
      <p className="mb-xs text-caption text-muted">
        {media.fileName ?? "A file"} was not stored.
      </p>
    );
  }

  if (media.mimeType.startsWith("image/")) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element -- the route streams
         tenant bytes behind requireSession; next/image would proxy them through
         an optimiser cache that is not company-scoped. */
      <img
        src={`/api/media/${media.id}`}
        alt={media.fileName ?? "Attached image"}
        className="mb-xs max-w-full rounded-md border border-hairline"
      />
    );
  }

  return (
    <a
      href={`/api/media/${media.id}`}
      className="mb-xs block break-all text-caption text-ink underline underline-offset-4"
    >
      {media.fileName ?? "Attached file"}
    </a>
  );
}

/**
 * The BODY text out of a stored component array.
 *
 * The picker needs it to count variables and to show what is about to go out.
 * Defensive because the column is jsonb: a row written by an older build must
 * render as a template with no variables rather than throwing the page.
 */
function templateBody(components: unknown): string {
  if (!Array.isArray(components)) return "";
  for (const component of components) {
    if (
      component &&
      typeof component === "object" &&
      (component as { type?: unknown }).type === "BODY" &&
      typeof (component as { text?: unknown }).text === "string"
    ) {
      return (component as { text: string }).text;
    }
  }
  return "";
}
