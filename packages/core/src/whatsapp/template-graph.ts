import { graphGetJson, graphPost, type GraphResult } from "../providers/meta.ts";
import type { FailureKind, FetchImpl } from "../providers/types.ts";
import type { TemplateComponent } from "./template.ts";

/**
 * Creating a template at Meta, and reading back what it says about them.
 *
 * Separate from graph.ts because that file is the *message* path and this one
 * is the template path — different endpoint, different id (the WABA rather than
 * the phone number), and different failure meanings. Sharing a file would mean
 * one set of outcome types trying to describe both.
 *
 * Still in the client-safe barrel's reach, and it has to be: nothing here
 * imports Node, and whatsapp-client-safe.test.ts will fail the moment that
 * stops being true.
 */

/* -------------------------------------------------------------------------- *
 * Creating
 * -------------------------------------------------------------------------- */

interface CreateResponse {
  id?: string;
  status?: string;
  category?: string;
}

export interface TemplateAccepted {
  ok: true;
  /** Meta's id for the template. What later status callbacks are matched by. */
  metaTemplateId: string;
  /**
   * What Meta says the status is, right now. Almost always PENDING.
   *
   * Read from the response rather than assumed, because Meta auto-approves
   * some templates immediately and a hardcoded PENDING would leave a row
   * waiting for a callback that already happened.
   */
  status: string;
  /**
   * The category Meta filed it under, which is not necessarily the one asked
   * for. Meta reads the wording and re-categorises promotional text, and the
   * price follows the category — so this is the value worth storing.
   */
  category: string | null;
}

export interface TemplateRefused {
  ok: false;
  kind: FailureKind;
  /** Meta's own sentence. Shown verbatim; paraphrasing it helps nobody. */
  error: string;
  statusCode: number | null;
  /** Meta's numeric code, for the cases worth branching on. */
  code: number | null;
}

export type TemplateCreateOutcome = TemplateAccepted | TemplateRefused;

/**
 * POST /{WABA_ID}/message_templates.
 *
 * The components array is passed through untouched — it is what the Studio
 * previewed and what the database stored, and re-deriving it here would be the
 * second assembly decision 10 exists to forbid.
 *
 * Unlike the message send, this is safe to retry. A duplicate name is refused
 * by Meta with a specific error rather than silently creating a second
 * template, so there is no un-sendable side effect to protect against.
 */
export async function createWhatsAppTemplate(
  secrets: Readonly<Record<string, string>>,
  input: {
    name: string;
    language: string;
    category: string;
    components: TemplateComponent[];
  },
  fetchImpl: FetchImpl = fetch,
): Promise<TemplateCreateOutcome> {
  const wabaId = secrets["WHATSAPP_BUSINESS_ACCOUNT_ID"] ?? "";
  const accessToken = secrets["WHATSAPP_ACCESS_TOKEN"] ?? "";

  if (!wabaId || !accessToken) {
    /*
     * config rather than auth: this is a key nobody filled in, not a credential
     * Meta rejected, and the two lead to different places. demotesStatus treats
     * config as a reason to demote the integration badge, which is right — the
     * connection genuinely cannot do this.
     */
    return {
      ok: false,
      kind: "config",
      error:
        "A WhatsApp Business Account ID and an access token are both required to create templates.",
      statusCode: null,
      code: null,
    };
  }

  const result: GraphResult<CreateResponse> = await graphPost<CreateResponse>(
    `${encodeURIComponent(wabaId)}/message_templates`,
    {
      name: input.name,
      language: input.language,
      category: input.category,
      components: input.components,
    },
    accessToken,
    Object.values(secrets),
    fetchImpl,
  );

  if (!result.ok) {
    return {
      ok: false,
      kind: result.kind,
      error: result.error,
      statusCode: result.statusCode ?? null,
      /* Meta's numeric code lives in details, beside error_subcode and the
         fbtrace_id their support asks for first. */
      code:
        typeof result.details?.["code"] === "number"
          ? (result.details["code"] as number)
          : null,
    };
  }

  const id = result.data.id;
  if (!id) {
    /*
     * A 200 with no id. Meta has not done this, but a template with no id can
     * never be matched to a status callback, so it is worth refusing loudly
     * rather than storing a row nothing can ever update.
     *
     * `transient` and not `config`, because it is the one kind demotesStatus
     * does not demote on. Meta answering oddly is not evidence the tenant's
     * credential is broken, and marking the integration NOT_CONNECTED over it
     * would send somebody to re-enter a token that was never wrong.
     */
    return {
      ok: false,
      kind: "transient",
      error: "Meta accepted the template but did not return an id for it.",
      statusCode: result.statusCode,
      code: null,
    };
  }

  return {
    ok: true,
    metaTemplateId: id,
    status: result.data.status ?? "PENDING",
    category: result.data.category ?? null,
  };
}

/* -------------------------------------------------------------------------- *
 * Reading
 * -------------------------------------------------------------------------- */

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: TemplateComponent[];
  /** Meta's reason, when it has rejected the template. */
  rejectedReason: string | null;
}

export type TemplateListOutcome =
  | { ok: true; templates: MetaTemplate[] }
  | { ok: false; kind: FailureKind; error: string; statusCode: number | null };

interface ListResponse {
  data?: Array<{
    id?: string;
    name?: string;
    language?: string;
    category?: string;
    status?: string;
    components?: TemplateComponent[];
    rejected_reason?: string;
  }>;
}

/**
 * GET /{WABA_ID}/message_templates.
 *
 * Two callers, and they want the same thing for different reasons: the Library
 * tab lists what already exists at Meta, and a reconciliation read answers
 * "what does Meta think" when a status callback was missed.
 *
 * `rejected_reason` is Meta's field name and it comes back as a machine-ish
 * token (`INVALID_FORMAT`, `ABUSIVE_CONTENT`, `NONE`). NONE is normalised to
 * null here so callers do not have to know that a rejection reason of "NONE"
 * means there is no rejection.
 */
export async function listWhatsAppTemplates(
  secrets: Readonly<Record<string, string>>,
  fetchImpl: FetchImpl = fetch,
): Promise<TemplateListOutcome> {
  const wabaId = secrets["WHATSAPP_BUSINESS_ACCOUNT_ID"] ?? "";
  const accessToken = secrets["WHATSAPP_ACCESS_TOKEN"] ?? "";

  if (!wabaId || !accessToken) {
    return {
      ok: false,
      kind: "config",
      error:
        "A WhatsApp Business Account ID and an access token are both required to read templates.",
      statusCode: null,
    };
  }

  const result = await graphGetJson<ListResponse>(
    `${encodeURIComponent(wabaId)}/message_templates`,
    "id,name,language,category,status,components,rejected_reason",
    accessToken,
    Object.values(secrets),
    fetchImpl,
  );

  if (!result.ok) {
    return {
      ok: false,
      kind: result.kind,
      error: result.error,
      statusCode: result.statusCode ?? null,
    };
  }

  const templates: MetaTemplate[] = [];
  for (const row of result.data.data ?? []) {
    /* A row missing a name or a language cannot be matched to anything here,
       and skipping it is better than inventing a key for it. */
    if (!row.id || !row.name || !row.language) continue;

    templates.push({
      id: row.id,
      name: row.name,
      language: row.language,
      category: row.category ?? "UTILITY",
      status: row.status ?? "PENDING",
      components: row.components ?? [],
      rejectedReason:
        row.rejected_reason && row.rejected_reason !== "NONE"
          ? row.rejected_reason
          : null,
    });
  }

  return { ok: true, templates };
}
