import type { Metadata } from "next";
import type * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { describeWindow } from "@whatsapp-os/core/whatsapp";
import { withCompany } from "@whatsapp-os/db";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { requireSession } from "@/lib/auth/session";
import { EMPTY_COPY } from "@/lib/empty-copy";
import { formatTimestamp } from "@/lib/format";
import {
  contactLabel,
  inboxWhere,
  needsHuman,
  parseInboxView,
  previewLabel,
  sourceLabel,
  windowLabel,
  windowVariant,
  type InboxView,
} from "@/lib/inbox-display";
import { SectionHeader, SectionShell } from "../_components/section";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { getFeatureAccess } from "@/lib/auth/feature-gate";

export const metadata: Metadata = { title: "Inbox" };

/**
 * Every conversation, newest activity first.
 *
 * ---------------------------------------------------------------------------
 * R4: this is the page most likely to break at 390px, and it is designed for it
 * ---------------------------------------------------------------------------
 *
 * Both faults the screenshot suite has ever caught were the same shape — an
 * element whose automatic minimum size was a string that could not be broken,
 * pushing the page wider than the viewport. This list renders two of exactly
 * that shape, `lastMessagePreview` and a contact's `profileName`, and both are
 * customer-supplied so neither has a length anybody controls.
 *
 * `truncate` alone does not fix it. It sets `white-space: nowrap`, which clips
 * what is drawn and leaves min-content as the full string — the grid item on
 * the admin console had `truncate` and still took the page to 94px wide on a
 * phone. What fixes it is `min-w-0` on the flex child, which is on every one of
 * them below, and the suite asserts the width before it photographs anything.
 *
 * Single pane at every width, deliberately. A list-plus-detail split would have
 * to collapse to one pane on a phone anyway, and a layout that only exists
 * above a breakpoint is a layout nobody looks at.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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


  /*
   * One instant for the whole render.
   *
   * describeWindow takes `now` rather than reading the clock so that twelve
   * rows cannot describe twelve slightly different moments — and so a thread
   * one millisecond from expiry is closed for all of them or open for all of
   * them, rather than open in the badge and closed in the composer it links to.
   */
  const now = new Date();

  const view = parseInboxView((await searchParams)["view"]);

  const conversations = await withCompany(session.companyId, (db) =>
    db.conversation.findMany({
      /*
       * The default view drops threads nobody has written in - see inboxWhere.
       * A broadcast creates one conversation per recipient, and without this
       * a ten thousand recipient run buries every genuine conversation.
       */
      where: inboxWhere(view),
      /* The index is (company_id, last_message_at DESC). Tie-broken on id
         because Meta's timestamps are whole seconds, so ties are real. */
      orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }],
      take: 50,
      select: {
        id: true,
        source: true,
        lastMessageAt: true,
        lastMessagePreview: true,
        windowExpiresAt: true,
        unreadCount: true,
        assignedUserId: true,
        contact: {
          select: {
            displayName: true,
            profileName: true,
            phoneE164: true,
            waId: true,
          },
        },
      },
    }),
  );

  return (
    <SectionShell>
      <SectionHeader
        title="Inbox"
        lede={
          view === "all"
            ? "Every conversation on your numbers, including the one-way threads a broadcast creates."
            : "Conversations a customer has written in, most recent first."
        }
      />

      {/* Real links, not client state: each view is a URL, so the back button
          works and a filtered inbox is shareable into a support thread. */}
      <nav aria-label="Inbox views" className="mb-lg flex gap-lg border-b border-hairline">
        <ViewTab href="/inbox" active={view === "replies"}>
          Replies
        </ViewTab>
        <ViewTab href="/inbox?view=all" active={view === "all"}>
          All conversations
        </ViewTab>
      </nav>

      {conversations.length > 0 ? (
        <ul className="flex flex-col gap-sm">
          {conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              now={now}
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          tone="mint"
          title={
            view === "all" ? "No conversations yet" : "No replies yet"
          }
          /*
           * Different copy per view, because "empty" means two different
           * things. On the default view it usually means a broadcast went out
           * and nobody has written back yet - which is not the same as having
           * no conversations at all, and telling somebody it is would send
           * them looking for a fault.
           */
          description={view === "all" ? EMPTY_COPY["inbox#all"] : EMPTY_COPY.inbox}
          action={
            view === "replies" ? (
              <Button asChild variant="outline">
                <Link href="/inbox?view=all">See all conversations</Link>
              </Button>
            ) : undefined
          }
        />
      )}
    </SectionShell>
  );
}

function ViewTab({
  href,
  active,
  children,
}: {
  href: "/inbox" | "/inbox?view=all";
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`-mb-px inline-block border-b-2 pb-sm text-nav-link transition-colors ${
        active
          ? "border-ink text-ink"
          : "border-transparent text-muted hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

interface ConversationListItem {
  id: string;
  source: string;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  windowExpiresAt: Date | null;
  unreadCount: number;
  assignedUserId: string | null;
  contact: {
    displayName: string | null;
    profileName: string | null;
    phoneE164: string | null;
    waId: string;
  };
}

function ConversationRow({
  conversation,
  now,
}: {
  conversation: ConversationListItem;
  now: Date;
}) {
  const window = describeWindow(conversation.windowExpiresAt, now);
  const waiting = needsHuman(conversation);

  return (
    <li>
      {/* The whole row is the target. A thread opened by a careful click on the
          name is a thread nobody opens on a phone. */}
      <Link
        href={`/inbox/${conversation.id}`}
        className="block rounded-xl border border-hairline bg-surface-card p-base transition-colors hover:border-hairline-strong hover:bg-canvas-soft"
      >
      {/* min-w-0 on the growing child, not just truncate on the text. See the
          note at the top of this file — this is the R4 mitigation itself. */}
      <div className="flex items-start justify-between gap-base">
        <p className="min-w-0 flex-1 truncate text-body-strong text-ink">
          {contactLabel(conversation.contact)}
        </p>

        <div className="flex shrink-0 items-center gap-xs">
          {conversation.unreadCount > 0 ? (
            <Badge aria-label={`${conversation.unreadCount} unread`}>
              {conversation.unreadCount} new
            </Badge>
          ) : null}
        </div>
      </div>

      <p className="mt-xxs min-w-0 truncate text-body-sm text-body">
        {previewLabel(conversation.lastMessagePreview)}
      </p>

      {/* Wraps rather than truncates: these are short, fixed-vocabulary chips,
          and a wrapped second row is better than a hidden window state. */}
      <div className="mt-sm flex flex-wrap items-center gap-xs">
        <Badge variant={windowVariant(window)}>{windowLabel(window)}</Badge>
        {waiting ? <Badge variant="outline">Needs a person</Badge> : null}
        <span className="text-caption text-muted">
          {sourceLabel(conversation.source)}
        </span>
        <span className="text-caption text-muted-soft">
          {formatTimestamp(conversation.lastMessageAt)}
        </span>
      </div>
      </Link>
    </li>
  );
}
