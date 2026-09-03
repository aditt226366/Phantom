import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { flowGraphSchema, type FlowNode } from "@whatsapp-os/core/flows";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import {
  flowState,
  flowStateLabel,
  flowStateVariant,
  nodeKindLabel,
  inRunStatusOrder,
  runStatusLabel,
  runStatusVariant,
} from "@/lib/flow-display";
import { formatTimestamp } from "@/lib/format";
import { SectionHeader, SectionShell } from "../../_components/section";
import { archiveFlowAction } from "../actions";
import { FlowEditor } from "../_components/flow-editor";

export const metadata: Metadata = { title: "Flow" };

/** How many recent runs the page lists. */
const RUN_LIMIT = 10;

/** Longest node summary before it is cut. A list row, not a paragraph. */
const SUMMARY_LENGTH = 60;

/**
 * What a node says, for somebody who did not write the flow.
 *
 * Falls back to the node id only when the graph cannot be read at all, which
 * is better than nothing and worse than everything else - so it is the last
 * branch rather than the first.
 */
function nodeSummary(graph: unknown, nodeId: string): string {
  const parsed = flowGraphSchema.safeParse(graph);
  if (!parsed.success) return nodeId;

  const node: FlowNode | undefined = parsed.data.nodes.find((n) => n.id === nodeId);
  if (!node) return nodeId;

  const body = "body" in node && typeof node.body === "string" ? node.body : null;
  if (!body) return nodeKindLabel(node.kind);

  return body.length > SUMMARY_LENGTH
    ? `${body.slice(0, SUMMARY_LENGTH).trimEnd()}...`
    : body;
}

/**
 * One flow: its tree, and what customers have done in it.
 *
 * The two halves are on one page deliberately. A flow's tree is only
 * interesting beside the conversations it produced - "eleven people got to the
 * second question and four handed off" is what tells an author which branch to
 * change - and a separate runs page would be one nobody opened.
 */
export default async function FlowPage({
  params,
}: {
  params: Promise<{ flowId: string }>;
}) {
  const { flowId } = await params;
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="Template Messaging" />;
  }

  const loaded = await withCompany(session.companyId, async (db, companyId) => {
    const flow = await db.flow.findFirst({
      where: { id: flowId },
      select: {
        id: true,
        name: true,
        publishedVersionId: true,
        archivedAt: true,
        publishedVersion: { select: { id: true, version: true, publishedAt: true } },
      },
    });

    if (!flow) return null;

    /* The draft if there is one, otherwise the live version - which is what
       "edit a published flow" means: a copy that becomes version n+1. */
    const editing =
      (await db.flowVersion.findFirst({
        where: { flowId: flow.id, publishedAt: null },
        orderBy: { version: "desc" },
        select: { id: true, version: true, graph: true },
      })) ??
      (await db.flowVersion.findFirst({
        where: { flowId: flow.id },
        orderBy: { version: "desc" },
        select: { id: true, version: true, graph: true },
      }));

    const templates = await db.whatsAppTemplate.findMany({
      where: { companyId, status: "APPROVED" },
      /* Then id, because name is not unique: the same template approved in
         two languages is two rows sharing it, and a tied ORDER BY lets the
         database pick an order per query. */
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, language: true },
    });

    const runs = await db.flowRun.findMany({
      where: { flowId: flow.id },
      /*
       * Then id. A tied sort key under a LIMIT does not merely reorder the
       * answer, it changes which rows ARE the answer - and runs tie readily,
       * because a broadcast's entry template starts every recipient's run in
       * the same instant.
       */
      orderBy: [{ startedAt: "desc" }, { id: "asc" }],
      take: RUN_LIMIT,
      select: {
        id: true,
        status: true,
        currentNodeId: true,
        startedAt: true,
        contact: { select: { displayName: true, profileName: true, phoneE164: true } },
        /* The run's OWN version, not the flow's live one - a run standing on a
           node version 3 deleted still has to say where it is standing. */
        flowVersion: { select: { graph: true } },
      },
    });

    /* Unordered on purpose: a groupBy has no meaningful order to ask the
       database for, and the one this page wants is a lifecycle rather than a
       column. inRunStatusOrder applies it at the point of rendering. */
    const counts = await db.flowRun.groupBy({
      by: ["status"],
      where: { flowId: flow.id },
      _count: { _all: true },
    });

    return { flow, editing, templates, runs, counts };
  });

  /*
   * 404, never 403. A different answer for a flow that exists but is not
   * yours would confirm that it exists - CLAUDE.md rule 6.
   */
  if (!loaded || !loaded.editing) notFound();

  const { flow, editing, templates, runs, counts } = loaded;
  const state = flowState(flow);

  /* Parsed rather than cast: the column is jsonb and holds what was written. A
     tree the schema no longer accepts is shown as an empty one to edit rather
     than crashing the page an author would use to fix it. */
  const parsedGraph = flowGraphSchema.safeParse(editing.graph);
  const graph = parsedGraph.success
    ? parsedGraph.data
    : { entryNodeId: "start", nodes: [] };

  return (
    <SectionShell>
      <SectionHeader
        title={flow.name}
        lede={
          flow.publishedVersion
            ? `Version ${flow.publishedVersion.version} is live. You are editing version ${editing.version}.`
            : "This flow has never been published, so nobody is in it yet."
        }
      />

      <div className="mb-lg flex flex-wrap items-center gap-sm">
        <Badge variant={flowStateVariant(state)}>{flowStateLabel(state)}</Badge>

        {flow.archivedAt ? (
          <p className="text-caption text-muted">
            Archived {formatTimestamp(flow.archivedAt)}. Taps on its opening
            template are declined rather than starting a conversation.
          </p>
        ) : (
          <form action={archiveFlowAction}>
            <CsrfField />
            <input type="hidden" name="flowId" value={flow.id} />
            <Button type="submit" variant="ghost">
              Archive
            </Button>
          </form>
        )}
      </div>

      {flow.archivedAt ? null : (
        <FlowEditor
          flowId={flow.id}
          initialGraph={graph}
          templates={templates}
          hasUnpublishedChanges={editing.id !== flow.publishedVersionId}
          csrf={<CsrfField />}
        />
      )}

      <section aria-labelledby="flow-runs" className="mt-xl">
        <h2 id="flow-runs" className="text-title-md text-ink">
          Conversations
        </h2>

        {counts.length === 0 ? (
          <p className="mt-xs text-body-sm text-body">
            Nobody has been through this flow yet. A conversation starts when
            somebody taps a quick-reply button on its opening template.
          </p>
        ) : (
          <>
            <ul className="mt-sm flex flex-wrap gap-xs">
              {inRunStatusOrder(counts).map((row) => (
                <li key={row.status}>
                  <Badge variant={runStatusVariant(row.status)}>
                    {runStatusLabel(row.status)}: {row._count._all}
                  </Badge>
                </li>
              ))}
            </ul>

            <ul className="mt-base flex flex-col gap-xs">
              {runs.map((run) => (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center justify-between gap-sm rounded-lg border border-hairline bg-surface-card px-base py-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate text-body-sm text-ink">
                      {run.contact.displayName ??
                        run.contact.profileName ??
                        run.contact.phoneE164 ??
                        "Unknown contact"}
                    </p>
                    <p className="text-caption text-muted">
                      {/* The step's own words, never its id. "Standing on n4"
                          is an internal name leaking onto a tenant's screen -
                          correct, and meaningless to the person reading it. */}
                      {run.currentNodeId
                        ? `Waiting at: ${nodeSummary(run.flowVersion.graph, run.currentNodeId)}`
                        : "Finished"}
                      {" · "}
                      {formatTimestamp(run.startedAt)}
                    </p>
                  </div>
                  <Badge variant={runStatusVariant(run.status)}>
                    {runStatusLabel(run.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </SectionShell>
  );
}
