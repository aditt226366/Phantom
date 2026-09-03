import type { Metadata } from "next";
import { withCompany } from "@whatsapp-os/db";
import { FeatureBlocked } from "@/components/brand/feature-blocked";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CsrfField } from "@/components/ui/csrf-field";
import { EmptyState } from "@/components/ui/empty-state";
import { getFeatureAccess } from "@/lib/auth/feature-gate";
import { requireSession } from "@/lib/auth/session";
import { formatTimestamp } from "@/lib/format";
import {
  documentContribution,
  documentStatusLabel,
  documentStatusVariant,
  floorNotice,
  type DocumentStatus,
} from "@/lib/verse-display";
import { SectionHeader, SectionShell } from "../../_components/section";
import {
  AddUrlForm,
  DeleteDocumentButton,
  NewBaseForm,
  ReindexButton,
  UploadForm,
} from "./_components/knowledge-forms";

export const metadata: Metadata = { title: "Knowledge base" };

/**
 * What the business knows, and what Verse can therefore answer.
 *
 * ---------------------------------------------------------------------------
 * Every document says what it contributed, or why it did not
 * ---------------------------------------------------------------------------
 *
 * The failure this screen exists to prevent is a knowledge base that looks
 * indexed and answers nothing: a scanned PDF with no text layer, a page behind
 * a login, a site whose robots.txt disallows the path. Each of those extracts
 * to almost nothing rather than throwing, so without a per-document status the
 * tenant would see a full list, a working assistant that says "I don't know" to
 * everything, and no way to connect the two.
 *
 * So a failed document carries the sentence the worker wrote, in full, and a
 * Try again beside it - because every one of those failures has a remedy the
 * tenant can carry out themselves.
 */
export default async function KnowledgePage() {
  /* Not the layout. Layouts are cached per segment; this is the boundary. */
  const session = await requireSession();

  const access = await getFeatureAccess();
  if (!access.allowed) {
    return <FeatureBlocked reason={access.reason} section="AI Messaging" />;
  }

  const bases = await withCompany(session.companyId, (db, companyId) =>
    db.knowledgeBase.findMany({
      where: { companyId, archivedAt: null },
      /* Tie-broken on id: bases created together would otherwise swap places
         between two loads of the page. */
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        name: true,
        createdAt: true,
        documents: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            title: true,
            kind: true,
            sourceUrl: true,
            status: true,
            failureReason: true,
            chunkCount: true,
            createdAt: true,
          },
        },
      },
    }),
  );

  const notice = floorNotice();

  return (
    <SectionShell>
      <SectionHeader
        title="Knowledge base"
        lede="What Verse is allowed to answer from. It never answers from anything else."
      />

      {/*
        The floor's provenance, on the page where somebody is looking at
        retrieval rather than only in a developer tool. A missing measurement
        visible only in a commit message is a missing measurement nobody sees.
      */}
      {notice.headline ? (
        <Card className="mb-lg">
          <p className="text-body-sm font-medium">{notice.headline}</p>
          <p className="mt-xs text-caption text-muted">{notice.detail}</p>
        </Card>
      ) : null}

      {bases.length === 0 ? (
        <EmptyState
          tone="mint"
          title="No knowledge base yet"
          description="Add what your business knows — a handbook, a price list, your delivery and returns pages — and Verse will answer from it and nothing else."
          action={<NewBaseForm csrf={<CsrfField />} />}
        />
      ) : (
        <div className="flex flex-col gap-lg">
          {bases.map((base) => (
            <Card key={base.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-sm">
                <h2 className="text-title-sm">{base.name}</h2>
                <p className="text-caption text-muted">
                  Created {formatTimestamp(base.createdAt)}
                </p>
              </div>

              <div className="mt-md grid gap-md sm:grid-cols-2">
                <UploadForm knowledgeBaseId={base.id} csrf={<CsrfField />} />
                <AddUrlForm knowledgeBaseId={base.id} csrf={<CsrfField />} />
              </div>

              {base.documents.length === 0 ? (
                <p className="mt-md text-body-sm text-body">
                  Nothing added yet. Verse cannot answer anything until this has
                  something in it.
                </p>
              ) : (
                <ul className="mt-md flex flex-col gap-sm">
                  {base.documents.map((document) => {
                    const status = document.status as DocumentStatus;
                    const contribution = documentContribution(
                      status,
                      document.chunkCount,
                    );

                    return (
                      <li
                        key={document.id}
                        className="flex flex-col gap-xs border-t border-hairline pt-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-sm">
                          <div className="min-w-0">
                            {/*
                              min-w-0 because a long filename is an unbreakable
                              string, and a grid item's automatic minimum size
                              is its content - which took the admin console 90
                              pixels wide on a phone once already.
                            */}
                            <p className="truncate text-body-sm font-medium">
                              {document.title}
                            </p>
                            <p className="truncate text-caption text-muted">
                              {document.kind === "URL"
                                ? document.sourceUrl
                                : "Uploaded file"}
                            </p>
                          </div>
                          <Badge variant={documentStatusVariant(status)}>
                            {documentStatusLabel(status)}
                          </Badge>
                        </div>

                        {contribution ? (
                          <p className="text-caption text-muted">{contribution}</p>
                        ) : null}

                        {/*
                          The reason in full, never truncated. It is the whole
                          point of the status: "this PDF is a scan with no text
                          layer" is something the tenant fixes in a minute, and
                          a red dot alone sends them to support.
                        */}
                        {document.failureReason ? (
                          <p className="text-caption text-error">
                            {document.failureReason}
                          </p>
                        ) : null}

                        <div className="flex gap-xs">
                          <ReindexButton
                            documentId={document.id}
                            csrf={<CsrfField />}
                          />
                          <DeleteDocumentButton
                            documentId={document.id}
                            csrf={<CsrfField />}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ))}

          <Card>
            <h2 className="text-title-sm">Another knowledge base</h2>
            <p className="mt-xs mb-md text-caption text-muted">
              One per campaign. A campaign answers only from the base it names.
            </p>
            <NewBaseForm csrf={<CsrfField />} />
          </Card>
        </div>
      )}
    </SectionShell>
  );
}
