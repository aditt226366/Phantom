import {
  JOB_NAMES,
  SEND_JOB_OPTIONS,
  decrypt,
  isQuotaFailure,
  readSheetValues,
  retryAfterMs,
  secretAad,
  sendJobId,
  type LeadSourcePollJob,
  type VerificationFailure,
} from "@whatsapp-os/core";
import { buildAudience, type ColumnMapping } from "@whatsapp-os/core/bulk";
import { parseLeadSourceAction, toRecords } from "@whatsapp-os/core/leads";
import { newRowsSince, rowHash } from "@whatsapp-os/core/leads-server";
import { fillVariables } from "@whatsapp-os/core/whatsapp";
import { encodeEntryButtonId, flowGraphSchema } from "@whatsapp-os/core/flows";
import {
  claimLeadRow,
  isDuplicateLead,
  leadSourceForPoll,
  recordPoll,
  recordPollFailure,
  withCompany,
  type PollCounts,
} from "@whatsapp-os/db";
import { keyring } from "../keyring.ts";
import { systemQueue } from "../queue.ts";
import { log } from "../logger.ts";

/**
 * Read one bound spreadsheet, and message the rows that are new.
 *
 * ---------------------------------------------------------------------------
 * The shape, and why every step is where it is
 * ---------------------------------------------------------------------------
 *
 *   read the binding      one short scope
 *   decrypt               CPU only, nothing open
 *   read the sheet        an HTTP call, with no scope open at all
 *   per row: claim        its OWN transaction, because the unique index in it
 *                         is the only thing standing between a re-poll and a
 *                         customer hearing from us twice
 *   per row: enqueue      after the transaction commits
 *   record the poll       one short scope
 *
 * withCompany holds a pooled connection and times out after five seconds, so a
 * sheet with a thousand new rows cannot be one transaction. It also must not
 * be: a duplicate on row 900 would roll back rows 1 to 899, un-claiming leads
 * whose messages were already enqueued. One claim, one transaction.
 *
 * ---------------------------------------------------------------------------
 * Nothing here is a second send path
 * ---------------------------------------------------------------------------
 *
 * A claimed lead becomes an ordinary outbound message row through the same
 * materialiseOutboundTemplate a broadcast uses, and is handed to the same send
 * job with the same SEND_JOB_OPTIONS - attempts: 1, the three-way outcome,
 * usage deduped on the message id. canSend runs inside that job, as late as a
 * read can be. This file decides WHO to message; it has no opinion about how.
 */

export type LeadPollResult =
  | "polled"
  | "not_found"
  | "not_active"
  | "backing_off"
  | "template_not_approved"
  | "misconfigured"
  | "unreadable";

/**
 * When Google says the quota is exhausted but not for how long.
 *
 * A minute rather than the poll interval, because the interval may be ten
 * seconds and re-asking a project that is already over its allowance is what
 * keeps it over. Retry-After is honoured when it is sent - see retryAfterMs.
 */
const DEFAULT_QUOTA_BACKOFF_MS = 60_000;

/**
 * One entry payload per quick-reply button on a flow version's entry template.
 *
 * Built here rather than read from a column, because the ids are derived from
 * the version and its entry node and there is exactly one correct answer -
 * storing a second copy would be a second thing to keep in step with the tree.
 *
 * Returns an empty array for a version whose graph cannot be read or has no
 * entry node, which the caller treats as a misconfigured binding. Sending its
 * template anyway would contact a real customer with buttons that resolve to
 * nothing, and that is worse than not sending: they have been asked a question
 * the system cannot hear the answer to.
 */
function entryPayloadsFor(versionId: string, graph: unknown): string[] {
  const parsed = flowGraphSchema.safeParse(graph);
  if (!parsed.success) return [];

  const entry = parsed.data.nodes.find((n) => n.id === parsed.data.entryNodeId);
  if (!entry || entry.kind !== "entry") return [];

  return entry.choices.map(() =>
    encodeEntryButtonId({ versionId, nodeId: entry.id }),
  );
}

export async function handleLeadSourcePoll(
  payload: LeadSourcePollJob,
): Promise<{ result: LeadPollResult; sent: number }> {
  const { companyId, leadSourceId } = payload;
  const startedAt = new Date();

  const binding = await withCompany(companyId, (db, scoped) =>
    leadSourceForPoll(db, scoped, leadSourceId),
  );

  if (!binding) {
    /*
     * The scheduler outlived its binding. Not an error to retry - it is a
     * scheduler that should have been removed, and saying so by name is what
     * makes it findable if the removal ever stops working.
     */
    log.warn("lead source poll: no such binding", { companyId, leadSourceId });
    return { result: "not_found", sent: 0 };
  }

  if (binding.status !== "ACTIVE") {
    /* PAUSED is the tenant's decision; ERROR means the last read failed and
       the binding is waiting for somebody to fix the share. Neither is a
       reason to keep reading, and the scheduler keeps ticking either way so
       that re-enabling needs no re-registration. */
    return { result: "not_active", sent: 0 };
  }

  if (binding.backoffUntil && binding.backoffUntil > startedAt) {
    /* Quota. Reading anyway is what keeps a project over its allowance, and
       the allowance is shared with every other tenant's bindings. */
    log.info("lead source poll: backing off", {
      companyId,
      leadSourceId,
      until: binding.backoffUntil.toISOString(),
    });
    return { result: "backing_off", sent: 0 };
  }

  const action = parseLeadSourceAction(binding.actionConfig);

  /*
   * Which template goes out, and what its buttons carry.
   *
   * -------------------------------------------------------------------------
   * The action switch, and everything above it that did not change
   * -------------------------------------------------------------------------
   *
   * This is the whole of the second action kind. A cold lead has never written
   * to us, so the 24-hour window is not open and an interactive message cannot
   * be sent - which means a FLOW binding contacts a row in exactly the way a
   * TEMPLATE binding does: one approved template, through
   * materialiseOutboundTemplate, with the same idempotency index in front of
   * it. What differs is the payloads on its quick-reply buttons.
   *
   * The sheet, the tab, the mapping, the cleaning, the cursor and the anchor
   * are all above this line and untouched. That is what the discriminated
   * column was built for in Phase 6, and wiring the second member here is what
   * proves the shape was right rather than merely claimed.
   *
   * The template comes from the pinned VERSION, never from the flow's current
   * published one - so republishing mid-import cannot change what a poll
   * halfway through a sheet is sending.
   */
  const target =
    action?.kind === "FLOW"
      ? binding.flowVersion
        ? {
            template: binding.flowVersion.template,
            payloads: entryPayloadsFor(
              binding.flowVersion.id,
              binding.flowVersion.graph,
            ),
          }
        : null
      : binding.template
        ? { template: binding.template, payloads: [] }
        : null;

  if (!action || !target || (action.kind === "FLOW" && target.payloads.length === 0)) {
    /*
     * A config this build cannot read, a TEMPLATE binding with no template, or
     * a FLOW binding whose version is gone or whose tree has no entry node.
     * Recorded on the binding rather than thrown: a poll job that throws every
     * thirty seconds is a binding nobody can even look at, and the page has a
     * sentence for this.
     */
    await withCompany(companyId, (db, scoped) =>
      recordPollFailure(db, scoped, leadSourceId, {
        error: "This lead source is not configured completely. Edit it and save again.",
        at: startedAt,
        demote: true,
      }),
    );
    return { result: "misconfigured", sent: 0 };
  }

  if (target.template.status !== "APPROVED") {
    /*
     * Checked once here rather than per row. Meta re-checks on every send and a
     * withdrawal comes back as a refusal with its own reason - but sending a
     * rejected template to every new lead for a week would burn the number's
     * quality rating for no possible benefit.
     */
    await withCompany(companyId, (db, scoped) =>
      recordPollFailure(db, scoped, leadSourceId, {
        error: `Meta has not approved this template (${target.template.status}), so nothing can be sent.`,
        at: startedAt,
        demote: true,
      }),
    );
    return { result: "template_not_approved", sent: 0 };
  }

  /* Credentials, in their own scope, then closed before any HTTP call. */
  const secrets = await loadGoogleSecrets(companyId);

  if (!secrets) {
    await withCompany(companyId, (db, scoped) =>
      recordPollFailure(db, scoped, leadSourceId, {
        error:
          "Google Sheets is not connected for this workspace. Add the service account in Configuration.",
        at: startedAt,
        demote: true,
      }),
    );
    return { result: "unreadable", sent: 0 };
  }

  /* The read. No scope is open. */
  const sheet = await readSheetValues(
    secrets,
    binding.spreadsheetId,
    binding.tab,
  );

  if (!sheet.ok) {
    await recordReadFailure(companyId, leadSourceId, sheet, startedAt);
    return { result: "unreadable", sent: 0 };
  }

  const content = toRecords(sheet.rows);
  const scan = newRowsSince(content.rows, {
    count: binding.cursorCount,
    anchor: binding.cursorAnchor,
  });

  if (scan.rescanned) {
    /* The sheet was edited structurally - a deletion, a mid-sheet insert, a
       re-sort. Logged because it explains a poll that suddenly does a lot of
       work, and because a binding rescanning on EVERY poll would mean the
       anchor is not being stored. */
    log.info("lead source rescanned", {
      companyId,
      leadSourceId,
      rows: scan.rows.length,
    });
  }

  const mapping = action.mapping as ColumnMapping;

  /*
   * The same cleaning pipeline a bulk import runs, reused rather than
   * reimplemented: E.164 through parsePhone with the India default, rejects
   * with reasons, and dedupe within this batch. A lead source that cleaned its
   * numbers differently from an import of the same file would be two answers to
   * one question.
   */
  const audience = buildAudience(scan.rows, mapping);

  const counts: PollCounts = {
    seen: scan.rows.length,
    sent: 0,
    skipped: 0,
    rejected: audience.rejects.length,
    duplicate: 0,
    rejectReasons: tallyReasons(audience.rejects.map((reject) => reject.reason)),
  };

  /* Hoisted out of the loop, and narrowed once. Reading through the binding
     inside the callback below leaves TypeScript unable to see the guard above
     it, which is fair - a closure could run later. */
  const template = {
    name: target.template.name,
    language: target.template.language,
  };
  const body = extractBody(target.template.components);
  const buttonPayloads = target.payloads;

  for (const recipient of audience.recipients) {
    const hash = rowHash(recipient.phoneE164, recipient.variables);
    const occurredAt = new Date();

    let claim;
    try {
      /*
       * Its own scope, which is its own transaction. The unique index is
       * checked inside it, so there is no window between deciding to send and
       * having sent - and a duplicate rolls back only this one row.
       */
      claim = await withCompany(companyId, (db, scoped) =>
        claimLeadRow(db, scoped, {
          leadSourceId,
          spreadsheetId: binding.spreadsheetId,
          tab: binding.tab,
          rowHash: hash,
          whatsappNumberId: binding.whatsappNumberId,
          phoneE164: recipient.phoneE164,
          variables: recipient.variables,
          template,
          renderedBody: fillVariables(body, recipient.variables),
          occurredAt,
          createdByUserId: binding.createdByUserId,
          buttonPayloads,
        }),
      );
    } catch (error) {
      if (isDuplicateLead(error)) {
        /*
         * Already claimed - by an earlier poll, by a rescan, or by another
         * binding on the same spreadsheet. Counted rather than swallowed, so
         * the binding's page can say why a row it can see produced nothing.
         */
        counts.duplicate += 1;
        continue;
      }
      throw error;
    }

    if (claim.kind === "skipped") {
      counts.skipped += 1;
      continue;
    }

    if (claim.kind === "duplicate") {
      counts.duplicate += 1;
      continue;
    }

    /*
     * After the transaction commits, never inside it.
     *
     * A job enqueued inside a transaction that then rolls back is a send for a
     * message row that does not exist. The other order - commit, then fail to
     * enqueue - leaves a PENDING message with no job, which is recoverable and
     * visible. Only one of those two costs a customer anything.
     */
    await systemQueue.add(
      JOB_NAMES.WHATSAPP_MESSAGE_SEND,
      {
        companyId,
        messageId: claim.messageId,
        sendAttempt: claim.sendAttempt,
      },
      {
        jobId: sendJobId(claim.messageId, claim.sendAttempt),
        ...SEND_JOB_OPTIONS,
      },
    );

    counts.sent += 1;
  }

  await withCompany(companyId, (db, scoped) =>
    recordPoll(db, scoped, leadSourceId, {
      counts,
      cursor: scan.cursor,
      at: startedAt,
    }),
  );

  if (counts.sent > 0 || counts.rejected > 0 || counts.duplicate > 0) {
    log.info("lead source polled", { companyId, leadSourceId, ...counts });
  }

  return { result: "polled", sent: counts.sent };
}

/**
 * Write down why the sheet could not be read.
 *
 * Three outcomes and they are not interchangeable:
 *
 *   quota      transient, so the badge and the binding's state are untouched -
 *              but nothing is polled again until the back-off expires, because
 *              re-asking an exhausted project is what keeps it exhausted, and
 *              the allowance belongs to every tenant at once.
 *   auth/config the tenant has to act. A share that was never made or has been
 *              revoked is the single most common failure of this feature, and
 *              it must present as an error on the page rather than as silence.
 *   transient  Google was slow. Recorded, nothing demoted. Demoting on a
 *              timeout teaches people to ignore the state that matters.
 */
async function recordReadFailure(
  companyId: string,
  leadSourceId: string,
  failure: VerificationFailure,
  at: Date,
): Promise<void> {
  const quota = isQuotaFailure(failure);
  const backoff = quota
    ? new Date(at.getTime() + (retryAfterMs(failure) ?? DEFAULT_QUOTA_BACKOFF_MS))
    : null;

  await withCompany(companyId, (db, scoped) =>
    recordPollFailure(db, scoped, leadSourceId, {
      error: quota
        ? "Google is rate limiting reads of this spreadsheet. Polling will resume shortly."
        : failure.error,
      at,
      /* Only a failure the tenant can act on moves the binding to ERROR. */
      demote: failure.kind !== "transient",
      backoffUntil: backoff,
    }),
  );

  if (quota) {
    log.warn("lead source hit the Sheets read quota", {
      companyId,
      leadSourceId,
      until: backoff?.toISOString(),
    });
    return;
  }

  log.warn("lead source could not be read", {
    companyId,
    leadSourceId,
    kind: failure.kind,
    error: failure.error,
  });
}

/** The company's Google Sheets credentials, decrypted, or null if unconnected. */
async function loadGoogleSecrets(
  companyId: string,
): Promise<Record<string, string> | null> {
  const integration = await withCompany(companyId, (db) =>
    db.integration.findFirst({
      where: { provider: "GOOGLE_SHEETS" },
      select: { id: true, secrets: { select: { key: true, ciphertext: true } } },
    }),
  );

  if (!integration || integration.secrets.length === 0) return null;

  const secrets: Record<string, string> = {};

  for (const row of integration.secrets) {
    secrets[row.key] = decrypt(
      row.ciphertext,
      keyring(),
      secretAad(companyId, integration.id, row.key),
    );
  }

  return secrets;
}

/** Reject reasons, counted, for the tally on the binding. */
function tallyReasons(reasons: readonly string[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const reason of reasons) tally[reason] = (tally[reason] ?? 0) + 1;
  return tally;
}

/** The BODY text out of a stored component array, or empty if there is none. */
function extractBody(components: unknown): string {
  if (!Array.isArray(components)) return "";

  for (const component of components) {
    if (
      component &&
      typeof component === "object" &&
      (component as Record<string, unknown>)["type"] === "BODY"
    ) {
      const text = (component as Record<string, unknown>)["text"];
      if (typeof text === "string") return text;
    }
  }

  return "";
}
