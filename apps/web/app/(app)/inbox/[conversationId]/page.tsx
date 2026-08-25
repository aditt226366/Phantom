import type { Metadata } from "next";
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
import { refusalSentence, statusDisplay } from "@/lib/thread-display";
import { SectionShell } from "../../_components/section";
import { Composer } from "../_components/composer";
import { ThreadRefresh } from "../_components/thread-refresh";

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
  const { conversationId } = await params;

  const now = new Date();

  const loaded = await withCompany(session.companyId, async (db, companyId) => {
    const conversation = await db.conversation.findFirst({
      where: { id: conversationId },
      select: {
        id: true,
        windowExpiresAt: true,
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
    };
  });

  /* Rule 6: not yours means it does not exist. Same answer as never having. */
  if (!loaded) notFound();

  const { conversation, messages, sendability, receipt } = loaded;

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
      </header>

      <ol className="flex flex-col gap-sm">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </ol>

      <div className="mt-lg">
        <Composer
          conversationId={conversation.id}
          closedReason={closedReason}
          csrf={<CsrfField />}
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

function MessageBubble({ message }: { message: ThreadMessage }) {
  const outbound = message.direction === "OUTBOUND";
  const status = statusDisplay(message.status);

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

        {status.detail ? (
          <p className="mt-xs text-caption text-body-strong">{status.detail}</p>
        ) : null}

        {/*
         * Meta's own words, and only ever labelled as Meta's. errorSource keeps
         * the two namespaces apart: a POLICY refusal is ours and carries no
         * code, so quoting a Graph code Meta never issued is impossible here.
         */}
        {message.errorTitle ? (
          <p className="mt-xs text-caption text-error">
            {message.errorSource === "META" && message.errorCode !== null
              ? `Meta ${message.errorCode}: ${message.errorTitle}`
              : message.errorTitle}
          </p>
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
