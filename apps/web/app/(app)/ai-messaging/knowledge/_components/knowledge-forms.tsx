"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import {
  addUrlAction,
  createKnowledgeBaseAction,
  deleteDocumentAction,
  reindexDocumentAction,
  uploadDocumentAction,
  type KnowledgeState,
} from "../actions";

/**
 * The forms on the knowledge base screen.
 *
 * The CSRF field arrives as a prop rather than an import, for the reason
 * new-flow-form.tsx gives: it is a Server Component, and a client module
 * importing one drags next/headers into the browser graph and fails the build
 * with an import trace that names every file except this one.
 */

export function NewBaseForm({ csrf }: { csrf: ReactNode }) {
  const [state, action, pending] = useActionState<KnowledgeState, FormData>(
    createKnowledgeBaseAction,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-sm">
      {csrf}
      <Field
        label="Name"
        name="name"
        required
        maxLength={120}
        placeholder="Product handbook"
        error={state.error}
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create knowledge base"}
      </Button>
    </form>
  );
}

export function UploadForm({
  knowledgeBaseId,
  csrf,
}: {
  knowledgeBaseId: string;
  csrf: ReactNode;
}) {
  const [state, action, pending] = useActionState<KnowledgeState, FormData>(
    uploadDocumentAction,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-sm">
      {csrf}
      <input type="hidden" name="knowledgeBaseId" value={knowledgeBaseId} />
      <Field
        label="Upload a document"
        name="file"
        type="file"
        /*
         * A hint to the file picker, never the check. The type is decided from
         * the bytes in the action - `file.type` is supplied by the client and a
         * renamed file lies about it, which is the rule the KYC upload path
         * already establishes for this repository.
         */
        accept=".pdf,.txt"
        required
        description="PDF or plain text, up to 10 MB."
        error={state.error}
      />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Uploading…" : "Add document"}
      </Button>
    </form>
  );
}

export function AddUrlForm({
  knowledgeBaseId,
  csrf,
}: {
  knowledgeBaseId: string;
  csrf: ReactNode;
}) {
  const [state, action, pending] = useActionState<KnowledgeState, FormData>(
    addUrlAction,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-sm">
      {csrf}
      <input type="hidden" name="knowledgeBaseId" value={knowledgeBaseId} />
      <Field
        label="Or add a web page"
        name="url"
        type="url"
        required
        placeholder="https://example.com/delivery"
        description="Pages on the same site are followed, up to 25. Anything the site's robots.txt disallows is skipped."
        error={state.error}
      />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Adding…" : "Add page"}
      </Button>
    </form>
  );
}

/** Try a failed document again, in place. */
export function ReindexButton({
  documentId,
  csrf,
}: {
  documentId: string;
  csrf: ReactNode;
}) {
  const [state, action, pending] = useActionState<KnowledgeState, FormData>(
    reindexDocumentAction,
    {},
  );

  return (
    <form action={action}>
      {csrf}
      <input type="hidden" name="documentId" value={documentId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Retrying…" : "Try again"}
      </Button>
      <FormStatus message={state.error} />
    </form>
  );
}

export function DeleteDocumentButton({
  documentId,
  csrf,
}: {
  documentId: string;
  csrf: ReactNode;
}) {
  const [, action, pending] = useActionState<KnowledgeState, FormData>(
    deleteDocumentAction,
    {},
  );

  return (
    <form action={action}>
      {csrf}
      <input type="hidden" name="documentId" value={documentId} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        Remove
      </Button>
    </form>
  );
}
