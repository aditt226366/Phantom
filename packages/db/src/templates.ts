import type { CompanyClient } from "./with-company.ts";

/**
 * Templates, and the edit quota counted from the log rather than stored.
 *
 * ---------------------------------------------------------------------------
 * R8: what this returns is a FLOOR, and the wording has to say so
 * ---------------------------------------------------------------------------
 *
 * Meta counts edits made anywhere, including in Business Manager, and those
 * never reach this table. So `used` is "edits we know about", always less than
 * or equal to what Meta thinks, and the Studio labels it "edits made here" for
 * that reason.
 *
 * The consequence is a rule about the UI, not a caveat about the number: the
 * Edit button is never gated on this. A disabled button that disagrees with
 * Meta is a support ticket - somebody who has edits left, being told they do
 * not, by a screen that cannot know. Submitting attempts the edit and decodes
 * Meta's refusal, which is the only answer that is actually authoritative.
 */

/** Meta's documented allowance. Ours to display, never ours to enforce. */
export const TEMPLATE_EDIT_LIMIT = 10;
export const TEMPLATE_EDIT_WINDOW_DAYS = 30;

export interface TemplateEditQuota {
  /**
   * Edits recorded here inside the window. A floor: Meta's count includes
   * edits made in Business Manager, which never reach this table.
   */
  used: number;
  limit: number;
  /**
   * When the oldest counted edit falls out of the window, or null when nothing
   * is counted. Rendered so somebody who has run out can see when that changes
   * rather than being told only that they cannot.
   */
  oldestAt: Date | null;
}

/**
 * How many edits this template has had here, in Meta's rolling window.
 *
 * Counted on every read rather than kept in a column. A counter is a second
 * source of truth for something the rows already say, and it is wrong the first
 * time a write half-fails - after which nothing ever notices, because there is
 * nothing to compare it against. Counting is cheap at this cardinality and the
 * index makes the window a seek.
 */
export async function templateEditQuota(
  db: CompanyClient,
  companyId: string,
  templateId: string,
  now: Date,
): Promise<TemplateEditQuota> {
  const since = new Date(
    now.getTime() - TEMPLATE_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  /* Order-independent despite the tie: only `rows.length` and `rows[0]` are
     used, and two edits sharing a created_at give the same oldestAt either
     way - it is the value that is read, not the row. */
  const rows = await db.whatsAppTemplateEdit.findMany({
    where: { companyId, templateId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  return {
    used: rows.length,
    limit: TEMPLATE_EDIT_LIMIT,
    oldestAt: rows[0]?.createdAt ?? null,
  };
}

/**
 * Append one edit. Never updates, never deletes.
 *
 * The components are stored as this edit submitted them, so the log is a
 * history of what was actually sent rather than a list of timestamps - which
 * is what makes it useful when Meta rejects the third version of something and
 * somebody needs to see what the second one said.
 */
export async function recordTemplateEdit(
  db: CompanyClient,
  companyId: string,
  input: {
    templateId: string;
    components: unknown;
    editedByUserId: string | null;
  },
): Promise<void> {
  await db.whatsAppTemplateEdit.create({
    data: {
      companyId,
      templateId: input.templateId,
      components: input.components as never,
      editedByUserId: input.editedByUserId,
    },
  });
}

/**
 * What Meta's status callback does to a row.
 *
 * Matched on `meta_template_id`, which is the only identifier the callback
 * carries that we also hold. Name and language would work for templates we
 * created, but not for one adopted from the Library.
 *
 * Returns whether anything was updated, so the caller can tell "applied" from
 * "no such template here" - which is an ordinary outcome rather than an error:
 * a WABA can hold templates created in Business Manager that this system has
 * never seen, and Meta sends callbacks for those too.
 */
export async function applyTemplateStatus(
  db: CompanyClient,
  companyId: string,
  input: {
    metaTemplateId: string;
    status: string;
    /** Meta's own words, or null when the update is not a rejection. */
    rejectedReason: string | null;
    /** Meta re-categorises; when the callback says so, the row follows. */
    category: string | null;
    at: Date;
  },
): Promise<boolean> {
  const result = await db.whatsAppTemplate.updateMany({
    where: { companyId, metaTemplateId: input.metaTemplateId },
    data: {
      status: input.status,
      /*
       * Cleared when this update is not a rejection. A template that was
       * rejected, fixed and approved must not keep last time's reason sitting
       * under an APPROVED badge - which is the same argument the retry action
       * makes about a failed message's error columns.
       */
      rejectedReason: input.rejectedReason,
      ...(input.category ? { category: input.category } : {}),
      statusUpdatedAt: input.at,
    },
  });

  return result.count > 0;
}
