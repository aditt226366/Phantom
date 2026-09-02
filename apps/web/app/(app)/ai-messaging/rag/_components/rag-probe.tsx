"use client";

import { useActionState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { TIER_CHOICES } from "@/lib/verse-display";
import { probeAction, type RagResult } from "../actions";

/**
 * Ask, and see what a customer would have got.
 *
 * The chunks below the floor are shown as prominently as the ones above it,
 * greyed rather than hidden. A refusal at 0.34 and a refusal at 0.02 are
 * completely different findings - the first says the floor may be a shade
 * high, the second says the base has nothing on the subject - and a view that
 * showed only what cleared would make them look identical.
 */
export function RagProbe({
  bases,
  csrf,
}: {
  bases: ReadonlyArray<{ id: string; label: string }>;
  csrf: ReactNode;
}) {
  const [state, action, pending] = useActionState<RagResult, FormData>(
    probeAction,
    {},
  );

  return (
    <div className="flex flex-col gap-lg">
      <Card>
        <form action={action} className="flex flex-col gap-md">
          {csrf}

          <Field
            label="Question"
            name="question"
            required
            placeholder="Do you deliver to Pune?"
            description="Ask exactly what a customer would ask."
          />

          <div className="flex flex-col gap-xs">
            <Label htmlFor="knowledgeBaseId">Knowledge base</Label>
            <select
              id="knowledgeBaseId"
              name="knowledgeBaseId"
              required
              className="h-button rounded-md border border-hairline-strong bg-transparent px-sm text-body-sm"
            >
              {bases.map((base) => (
                <option key={base.id} value={base.id}>
                  {base.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-xs">
            <Label htmlFor="modelTier">Model</Label>
            <select
              id="modelTier"
              name="modelTier"
              defaultValue="V1"
              className="h-button rounded-md border border-hairline-strong bg-transparent px-sm text-body-sm"
            >
              {TIER_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>

          <FormStatus message={state.error} />

          <Button type="submit" disabled={pending}>
            {pending ? "Asking…" : "Ask"}
          </Button>
        </form>
      </Card>

      {state.question ? (
        <>
          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-sm">
              <h2 className="text-title-sm">
                {state.answer ? "Verse answered" : "Verse handed over"}
              </h2>
              <Badge variant={state.answer ? "success" : "outline"}>
                {state.answer ? "Grounded" : (state.escalation ?? "handed over")}
              </Badge>
            </div>

            <p className="mt-sm whitespace-pre-wrap text-body-sm text-body">
              {state.answer ??
                "Nothing retrieved cleared the floor, or the question is one Verse hands over by policy. A customer would have been told a colleague will reply."}
            </p>

            {/*
              Latency split into embedding and generation, because they are
              different problems: a slow embed is the index, a slow completion
              is the model, and one number hides which.
            */}
            <dl className="mt-md flex flex-wrap gap-lg text-caption">
              <div>
                <dt className="text-muted">Embedding</dt>
                <dd>{state.embedMs ?? 0} ms</dd>
              </div>
              <div>
                <dt className="text-muted">Generation</dt>
                <dd>{state.latencyMs ? `${state.latencyMs} ms` : "—"}</dd>
              </div>
              <div>
                <dt className="text-muted">Tokens in</dt>
                <dd>{state.inputTokens ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted">Tokens out</dt>
                <dd>{state.outputTokens ?? "—"}</dd>
              </div>
            </dl>
          </Card>

          <Card>
            <h2 className="text-title-sm">
              What came back{" "}
              <span className="text-caption text-muted">
                ({state.chunks?.length ?? 0} considered)
              </span>
            </h2>

            {state.chunks && state.chunks.length > 0 ? (
              <ul className="mt-sm flex flex-col gap-sm">
                {state.chunks.map((chunk, index) => (
                  <li
                    key={index}
                    className="border-t border-hairline pt-sm"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-sm">
                      <p className="text-caption font-medium">
                        {chunk.documentTitle}
                      </p>
                      <Badge variant={chunk.cleared ? "success" : "outline"}>
                        {chunk.similarity.toFixed(3)}
                      </Badge>
                    </div>
                    <p
                      className={
                        chunk.cleared
                          ? "mt-xs text-caption text-body"
                          : "mt-xs text-caption text-muted"
                      }
                    >
                      {chunk.content}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-sm text-caption text-muted">
                Nothing at all came back. This knowledge base has no passages
                indexed yet.
              </p>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
