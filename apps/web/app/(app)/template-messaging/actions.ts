"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  flowGraphSchema,
  validateFlow,
  type FlowGraph,
} from "@whatsapp-os/core/flows";
import { withCompany } from "@whatsapp-os/db";
import { assertCsrf } from "@/lib/auth/csrf";
import { assertFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";

/**
 * Creating, saving and publishing a flow.
 *
 * Every action calls requireSession and assertFeatureAccess itself. The layout
 * does neither as a boundary - it is cached per segment and not guaranteed to
 * re-execute - and a server action is reachable by its id whether or not a page
 * ever rendered a button for it.
 *
 * ---------------------------------------------------------------------------
 * The graph is validated on the server, whatever the client already said
 * ---------------------------------------------------------------------------
 *
 * The editor runs validateFlow as somebody types, which is the whole reason
 * @whatsapp-os/core/flows is a client-safe barrel. That is feedback. This is
 * the boundary: the same function, over the bytes that actually arrived, and a
 * graph that fails it is not written.
 *
 * The two answer different questions and both are needed. A published flow that
 * violates Meta's limits is not a validation message, it is a question a
 * customer never receives - refused by the Graph API, in a thread, with nobody
 * watching.
 */

export interface FlowFormState {
  message?: string;
  /** Per-node issues, so the editor can point at what is wrong. */
  issues?: Array<{ nodeId: string | null; message: string }>;
}

/**
 * A new flow, with an empty tree pointing at the template that opens it.
 *
 * The entry node is created here rather than left to the editor, because a flow
 * without one is not a draft of anything: interactive messages only work inside
 * the 24-hour window, so an approved template is the only legal way in and
 * there is no useful state before one is chosen.
 */
export async function createFlowAction(
  _previous: FlowFormState,
  formData: FormData,
): Promise<FlowFormState> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const name = String(formData.get("name") ?? "").trim();
  const templateId = String(formData.get("templateId") ?? "");

  if (name.length === 0) return { message: "Give the flow a name." };
  if (name.length > 120) return { message: "That name is too long." };
  if (!templateId) return { message: "Choose the template that opens this flow." };

  const flowId = await withCompany(session.companyId, async (db, companyId) => {
    /*
     * Scoped read before the write. The extension injects companyId into the
     * where clause, so a template id from another tenant simply does not
     * resolve - and the flow is refused rather than created pointing at a row
     * RLS would hide from every later read.
     */
    const template = await db.whatsAppTemplate.findFirst({
      where: { id: templateId, status: "APPROVED" },
      select: { id: true, name: true },
    });

    if (!template) return null;

    const flow = await db.flow.create({
      data: { companyId, name, createdByUserId: session.userId },
      select: { id: true },
    });

    await db.flowVersion.create({
      data: {
        companyId,
        flowId: flow.id,
        version: 1,
        entryTemplateId: template.id,
        createdByUserId: session.userId,
        graph: {
          entryNodeId: "start",
          nodes: [
            {
              id: "start",
              kind: "entry",
              templateId: template.id,
              variables: [],
              choices: [{ key: "yes", label: "Yes", next: null }],
            },
          ],
        },
      },
    });

    return flow.id;
  });

  if (!flowId) {
    return { message: "That template is not available. Choose an approved one." };
  }

  revalidatePath("/template-messaging");
  redirect(`/template-messaging/${flowId}`);
}

/**
 * Save the tree onto the flow's draft version.
 *
 * A draft is the version with no published_at. Editing a flow that is live
 * creates a new one rather than touching the published row, because a published
 * version is what runs are pinned to - rewriting it under a customer who is
 * three questions deep is exactly what the two tables exist to prevent.
 */
export async function saveFlowAction(
  _previous: FlowFormState,
  formData: FormData,
): Promise<FlowFormState> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const flowId = String(formData.get("flowId") ?? "");
  const parsed = readGraph(formData);

  if ("message" in parsed) return parsed;

  const saved = await withCompany(session.companyId, async (db, companyId) => {
    const flow = await db.flow.findFirst({
      where: { id: flowId, archivedAt: null },
      select: { id: true, publishedVersionId: true },
    });

    if (!flow) return false;

    const draft = await db.flowVersion.findFirst({
      where: { flowId: flow.id, publishedAt: null },
      orderBy: { version: "desc" },
      select: { id: true },
    });

    if (draft) {
      await db.flowVersion.update({
        where: { id: draft.id },
        data: { graph: parsed.graph, entryTemplateId: parsed.entryTemplateId },
      });
      return true;
    }

    const highest = await db.flowVersion.findFirst({
      where: { flowId: flow.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    await db.flowVersion.create({
      data: {
        companyId,
        flowId: flow.id,
        version: (highest?.version ?? 0) + 1,
        entryTemplateId: parsed.entryTemplateId,
        createdByUserId: session.userId,
        graph: parsed.graph,
      },
    });

    return true;
  });

  if (!saved) return { message: "That flow does not exist." };

  revalidatePath(`/template-messaging/${flowId}`);
  return { message: "Saved." };
}

/**
 * Make the draft the version customers are put into.
 *
 * Publishing moves the flow's pointer. It does not touch any run: every run in
 * flight stays on the version it started, which is the whole reason the pointer
 * exists rather than a flag on the version.
 */
export async function publishFlowAction(
  _previous: FlowFormState,
  formData: FormData,
): Promise<FlowFormState> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const flowId = String(formData.get("flowId") ?? "");
  const parsed = readGraph(formData);

  if ("message" in parsed) return parsed;

  const result = await withCompany(session.companyId, async (db, companyId) => {
    const flow = await db.flow.findFirst({
      where: { id: flowId, archivedAt: null },
      select: { id: true },
    });

    if (!flow) return "missing" as const;

    const draft = await db.flowVersion.findFirst({
      where: { flowId: flow.id, publishedAt: null },
      orderBy: { version: "desc" },
      select: { id: true },
    });

    const highest = await db.flowVersion.findFirst({
      where: { flowId: flow.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    const versionId = draft
      ? (
          await db.flowVersion.update({
            where: { id: draft.id },
            data: {
              graph: parsed.graph,
              entryTemplateId: parsed.entryTemplateId,
              publishedAt: new Date(),
              /* The CHECK requires both together: a version that went live
                 with nobody named is the shape of "the system did it". */
              publishedByUserId: session.userId,
            },
            select: { id: true },
          })
        ).id
      : (
          await db.flowVersion.create({
            data: {
              companyId,
              flowId: flow.id,
              version: (highest?.version ?? 0) + 1,
              entryTemplateId: parsed.entryTemplateId,
              createdByUserId: session.userId,
              graph: parsed.graph,
              publishedAt: new Date(),
              publishedByUserId: session.userId,
            },
            select: { id: true },
          })
        ).id;

    await db.flow.update({
      where: { id: flow.id },
      data: { publishedVersionId: versionId },
    });

    return "published" as const;
  });

  if (result === "missing") return { message: "That flow does not exist." };

  revalidatePath(`/template-messaging/${flowId}`);
  revalidatePath("/template-messaging");
  return { message: "Published. New conversations will use this version." };
}

/**
 * Take a flow out of service without deleting it.
 *
 * Archived rather than deleted, because a flow with runs behind it is the
 * record of what customers were told - and because the entry template may still
 * be sitting in a thousand chats. Archiving clears the published pointer, so a
 * tap on one of those is declined as version_unpublished rather than opening a
 * conversation the tenant stopped having.
 */
export async function archiveFlowAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await assertCsrf(formData, session);
  await assertFeatureAccess();

  const flowId = String(formData.get("flowId") ?? "");

  await withCompany(session.companyId, async (db) => {
    const flow = await db.flow.findFirst({
      where: { id: flowId },
      select: { id: true },
    });

    if (!flow) return;

    await db.flow.update({
      where: { id: flow.id },
      data: { archivedAt: new Date(), publishedVersionId: null },
    });
  });

  revalidatePath("/template-messaging");
  redirect("/template-messaging");
}

/**
 * The posted tree, parsed and validated, or the reason it was refused.
 *
 * Runs validateFlow rather than only the Zod schema. The schema catches a shape
 * Meta would reject; validateFlow also catches the structural faults that
 * produce a flow which works for the author on the happy path and strands a
 * customer on a branch nobody can leave.
 */
function readGraph(
  formData: FormData,
):
  | { graph: FlowGraph; entryTemplateId: string }
  | { message: string; issues?: FlowFormState["issues"] } {
  const raw = String(formData.get("graph") ?? "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { message: "The flow could not be read. Reload the page and try again." };
  }

  const validation = validateFlow(parsed);

  if (!validation.ok) {
    return {
      message: "This flow has problems that have to be fixed first.",
      issues: validation.issues.map((issue) => ({
        nodeId: issue.nodeId,
        message: issue.message,
      })),
    };
  }

  const graph = flowGraphSchema.parse(parsed);
  const entry = graph.nodes.find((node) => node.id === graph.entryNodeId);

  /* validateFlow has already established this; narrowing for the type. */
  if (!entry || entry.kind !== "entry") {
    return { message: "This flow has no opening template." };
  }

  return { graph, entryTemplateId: entry.templateId };
}
