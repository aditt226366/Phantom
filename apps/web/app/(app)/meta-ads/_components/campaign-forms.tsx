"use client";

import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import {
  createCampaignAction,
  pauseCampaignAction,
  publishCampaignAction,
  type MetaAdsState,
} from "../actions";

const SELECT_CLASS =
  "h-input w-full rounded-md border border-hairline-strong bg-surface-card px-base py-sm font-body text-body-md text-ink focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ink";

export interface AccountChoice {
  id: string;
  name: string;
  currency: string;
}

const OBJECTIVES = [
  { value: "OUTCOME_LEADS", label: "Leads — people who message you" },
  { value: "OUTCOME_ENGAGEMENT", label: "Engagement — conversations started" },
  { value: "OUTCOME_TRAFFIC", label: "Traffic — clicks through to WhatsApp" },
  { value: "OUTCOME_SALES", label: "Sales — purchases after messaging" },
] as const;

export function NewCampaignForm({
  csrf,
  accounts,
}: {
  csrf: ReactNode;
  accounts: readonly AccountChoice[];
}) {
  const [state, action, pending] = useActionState<MetaAdsState, FormData>(
    createCampaignAction,
    {},
  );

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const currency = accounts.find((a) => a.id === accountId)?.currency ?? "";

  return (
    <form action={action} className="flex flex-col gap-base">
      {csrf}

      <div className="flex flex-col gap-xs">
        <Label htmlFor="adAccountId">Ad account</Label>
        <select
          id="adAccountId"
          name="adAccountId"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
          className={SELECT_CLASS}
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} — {account.currency}
            </option>
          ))}
        </select>
      </div>

      <Field label="Campaign name" name="name" required maxLength={120} />

      <div className="flex flex-col gap-xs">
        <Label htmlFor="objective">What it is for</Label>
        <select id="objective" name="objective" className={SELECT_CLASS}>
          {OBJECTIVES.map((objective) => (
            <option key={objective.value} value={objective.value}>
              {objective.label}
            </option>
          ))}
        </select>
      </div>

      <Field
        label={`Daily budget${currency ? ` (${currency})` : ""}`}
        name="dailyBudget"
        required
        inputMode="decimal"
        placeholder="2500"
        /*
         * The currency is shown, never chosen. It comes from the account, and
         * a field the tenant could set would let them denominate their own
         * dashboard wrongly by a factor of eighty.
         */
        description={`Meta will not spend more than this per day. The amount is in ${currency || "the account's currency"}.`}
      />

      <p className="rounded-md border border-hairline bg-surface-strong p-sm text-body-sm text-ink">
        {/*
          * Said before the button, not after. The whole design of this screen
          * is that nothing here starts spending - and a person who has just
          * typed a budget deserves to read that in the same glance.
          */}
        The campaign is created <strong>paused</strong>. It spends nothing until
        you publish it, which is a separate step and asks you to type its name.
      </p>

      <FormStatus
        message={state.error ?? state.notice}
        tone={state.error ? "error" : "success"}
      />

      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create paused campaign"}
      </Button>
    </form>
  );
}

/**
 * Publishing, behind a typed name.
 *
 * A confirm step protects against a misclick. Only the typed name protects
 * against publishing the wrong campaign off a list of six - and what is on the
 * other side of this button is money that cannot be recalled.
 */
export function PublishForm({
  csrf,
  id,
  name,
}: {
  csrf: ReactNode;
  id: string;
  name: string;
}) {
  const [state, action, pending] = useActionState<MetaAdsState, FormData>(
    publishCampaignAction,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-xs">
      {csrf}
      <input type="hidden" name="id" value={id} />
      <Field
        label="Type the campaign name to start its spend"
        name="confirmName"
        required
        placeholder={name}
        autoComplete="off"
      />
      <FormStatus
        message={state.error ?? state.notice}
        tone={state.error ? "error" : "success"}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Publishing…" : "Publish and start spending"}
        </Button>
      </div>
    </form>
  );
}

/** Pausing needs no confirmation. Stopping spend is the safe direction. */
export function PauseForm({ csrf, id }: { csrf: ReactNode; id: string }) {
  const [state, action, pending] = useActionState<MetaAdsState, FormData>(
    pauseCampaignAction,
    {},
  );

  return (
    <form action={action} className="flex flex-col items-start gap-xs">
      {csrf}
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Pausing…" : "Pause"}
      </Button>
      <FormStatus
        message={state.error ?? state.notice}
        tone={state.error ? "error" : "success"}
      />
    </form>
  );
}
