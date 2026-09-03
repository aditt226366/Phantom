import type { Metadata } from "next";
import { FLOOR, SIMILARITY_FLOOR, VERSE_KEY_VARS } from "@whatsapp-os/core/verse";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CsrfField } from "@/components/ui/csrf-field";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { floorNotice } from "@/lib/verse-display";
import { SectionHeader, SectionShell } from "../../_components/section";
import { RagProbe } from "./_components/rag-probe";

export const metadata: Metadata = { title: "Retrieval" };

/**
 * The harness: ask a question, see exactly what came back and what it cost.
 *
 * ---------------------------------------------------------------------------
 * Why this is inside the product rather than a script
 * ---------------------------------------------------------------------------
 *
 * The thing worth looking at is the SCORES, and a script that prints them runs
 * against whatever database the person running it happens to be pointed at. In
 * the app it runs under withCompany against the tenant's own base, so what it
 * shows is what that tenant's customers would actually get.
 *
 * It is gated like every other page here. A retrieval probe is a read of the
 * knowledge base, which is a tenant's own operating knowledge in plain text.
 */
export default async function RagPage() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="AI Messaging" />;
  }

  const bases = await withCompany(session.companyId, (db, companyId) =>
    db.knowledgeBase.findMany({
      where: { companyId, archivedAt: null },
      /* Tie-broken on id, as the knowledge list is. */
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        name: true,
        embeddingModel: true,
        _count: { select: { chunks: true } },
      },
    }),
  );

  const notice = floorNotice();
  const configured = VERSE_KEY_VARS.filter((name) => !process.env[name]);

  return (
    <SectionShell>
      <SectionHeader
        title="Retrieval"
        lede="Ask what a customer would ask, and see exactly which passages come back and how close they scored."
      />

      {/*
        The floor's provenance, second of the two places it renders. The
        knowledge base page tells a tenant; this tells whoever is tuning it,
        with the number and the status side by side.
      */}
      <Card className="mb-lg">
        <div className="flex flex-wrap items-baseline justify-between gap-sm">
          <p className="text-title-sm">
            Similarity floor {SIMILARITY_FLOOR}
          </p>
          <Badge variant={FLOOR.status === "measured" ? "success" : "outline"}>
            {FLOOR.status === "measured" ? "Measured" : "Provisional"}
          </Badge>
        </div>
        <p className="mt-xs text-caption text-muted">{notice.detail}</p>
        <p className="mt-xs text-caption text-muted">
          Set {FLOOR.setAt} · embeddings from {FLOOR.embeddingModel}
        </p>
        {FLOOR.status === "provisional" ? (
          <p className="mt-sm text-caption text-muted">
            Run <code>npm run verse:metric</code> against a knowledge base to
            replace it with a measured value.
          </p>
        ) : null}
      </Card>

      {configured.length > 0 ? (
        <Card className="mb-lg">
          <p className="text-body-sm font-medium">Verse is not configured here</p>
          <p className="mt-xs text-caption text-muted">
            {/*
              Named, not hidden. Somebody on this page is diagnosing retrieval,
              and "it returned nothing" reads as an index problem when the real
              cause is an absent credential.
            */}
            Missing: {configured.join(", ")}. Retrieval will fail until these
            are set on the server.
          </p>
        </Card>
      ) : null}

      {bases.length === 0 ? (
        <Card>
          <p className="text-body-sm text-body">
            No knowledge base to probe yet.
          </p>
        </Card>
      ) : (
        <RagProbe
          bases={bases.map((base) => ({
            id: base.id,
            label: `${base.name} — ${base._count.chunks} passages (${base.embeddingModel})`,
          }))}
          csrf={<CsrfField />}
        />
      )}
    </SectionShell>
  );
}
