"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { TIER_CHOICES } from "@/lib/verse-display";
import {
  archiveCampaignAction,
  createCampaignAction,
  duplicateCampaignAction,
  importAudienceAction,
  pauseCampaignAction,
  resumeCampaignAction,
  startCampaignAction,
  type CampaignState,
} from "../actions";

/**
 * The wizard, and the four controls a campaign has afterwards.
 *
 * One form rather than a multi-step wizard with its own state. Every field
 * below is a decision the tenant has already made before they open this screen
 * - which template, which knowledge base, when to send - and a stepper would
 * turn six answers into six page loads and a half-finished draft to resume.
 *
 * The CSRF field arrives as a prop: it is a Server Component, and a client
 * module importing one drags next/headers into the browser graph.
 */

export interface Option {
  id: string;
  label: string;
}

export function CampaignWizard({
  templates,
  bases,
  numbers,
  defaultTimezone,
  csrf,
}: {
  templates: readonly Option[];
  bases: readonly Option[];
  numbers: readonly Option[];
  defaultTimezone: string;
  csrf: ReactNode;
}) {
  const [state, action, pending] = useActionState<CampaignState, FormData>(
    createCampaignAction,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-md">
      {csrf}

      <Field
        label="Campaign name"
        name="name"
        required
        maxLength={120}
        placeholder="Diwali offers"
        description="Only your team sees this."
      />

      {/*
        The goal, and the one field whose exact words matter.

        It goes into the system prompt verbatim - never normalised, summarised
        or spell-corrected - so the description says so plainly. A tenant who
        thinks this is a label writes "Diwali"; one who knows it is an
        instruction writes something Verse can act on.
      */}
      <Field
        label="What is this campaign for?"
        name="goal"
        required
        maxLength={2000}
        placeholder="Answer questions about our Diwali offers and help people choose a saree. Take orders to the shop."
        description="Verse is given this word for word, so write it as an instruction to a new colleague."
      />

      <div className="flex flex-col gap-xs">
        <Label htmlFor="templateId">Opening template</Label>
        <select
          id="templateId"
          name="templateId"
          required
          className="h-button rounded-md border border-hairline-strong bg-transparent px-sm text-body-sm"
        >
          <option value="">Choose an approved template…</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.label}
            </option>
          ))}
        </select>
        <p className="text-caption text-muted">
          Only an approved template can open a conversation. Verse answers
          freely afterwards, inside the 24-hour window.
        </p>
      </div>

      <div className="flex flex-col gap-xs">
        <Label htmlFor="knowledgeBaseId">Knowledge base</Label>
        <select
          id="knowledgeBaseId"
          name="knowledgeBaseId"
          required
          className="h-button rounded-md border border-hairline-strong bg-transparent px-sm text-body-sm"
        >
          <option value="">Choose one…</option>
          {bases.map((base) => (
            <option key={base.id} value={base.id}>
              {base.label}
            </option>
          ))}
        </select>
        <p className="text-caption text-muted">
          Verse answers from this and nothing else. If it cannot find an answer
          here, it hands the conversation to your team.
        </p>
      </div>

      <div className="flex flex-col gap-xs">
        <Label htmlFor="whatsappNumberId">Send from</Label>
        <select
          id="whatsappNumberId"
          name="whatsappNumberId"
          required
          className="h-button rounded-md border border-hairline-strong bg-transparent px-sm text-body-sm"
        >
          <option value="">Choose a number…</option>
          {numbers.map((number) => (
            <option key={number.id} value={number.id}>
              {number.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-xs">
        <Label htmlFor="modelTier">Model</Label>
        <select
          id="modelTier"
          name="modelTier"
          required
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

      {/* ------------------------------------------------------------------ */}
      {/* The schedule                                                        */}
      {/* ------------------------------------------------------------------ */}

      <Field
        label="Timezone"
        name="timezone"
        required
        defaultValue={defaultTimezone}
        description="The send window and the daily cap are both read in this timezone, not the server's."
      />

      <div className="grid gap-sm sm:grid-cols-2">
        <Field
          label="Send no earlier than"
          name="windowStart"
          placeholder="09:00"
          description="Optional."
        />
        <Field
          label="and no later than"
          name="windowEnd"
          placeholder="20:00"
          description="Leave both blank to send at any hour."
        />
      </div>

      <Field
        label="Most messages per day"
        name="dailyCap"
        type="number"
        min={1}
        placeholder="200"
        description="Optional. Counted against your timezone's day, not the server's."
      />

      <FormStatus message={state.error} />

      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create campaign"}
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------------- *
 * The controls
 * ------------------------------------------------------------------------- */

function ControlForm({
  campaignId,
  csrf,
  action,
  label,
  pendingLabel,
  variant = "outline",
}: {
  campaignId: string;
  csrf: ReactNode;
  action: (state: CampaignState, form: FormData) => Promise<CampaignState>;
  label: string;
  pendingLabel: string;
  variant?: "primary" | "outline" | "ghost";
}) {
  const [state, formAction, pending] = useActionState<CampaignState, FormData>(
    action,
    {},
  );

  return (
    <form action={formAction} className="inline-flex flex-col gap-xs">
      {csrf}
      <input type="hidden" name="campaignId" value={campaignId} />
      <Button type="submit" variant={variant} size="sm" disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      <FormStatus message={state.error} />
    </form>
  );
}

export function StartButton(props: { campaignId: string; csrf: ReactNode }) {
  return (
    <ControlForm
      {...props}
      action={startCampaignAction}
      label="Start"
      pendingLabel="Starting…"
      variant="primary"
    />
  );
}

export function PauseButton(props: { campaignId: string; csrf: ReactNode }) {
  return (
    <ControlForm
      {...props}
      action={pauseCampaignAction}
      label="Pause"
      pendingLabel="Pausing…"
    />
  );
}

export function ResumeButton(props: { campaignId: string; csrf: ReactNode }) {
  return (
    <ControlForm
      {...props}
      action={resumeCampaignAction}
      label="Resume"
      pendingLabel="Resuming…"
    />
  );
}

export function DuplicateButton(props: { campaignId: string; csrf: ReactNode }) {
  return (
    <ControlForm
      {...props}
      action={duplicateCampaignAction}
      label="Duplicate"
      pendingLabel="Copying…"
      variant="ghost"
    />
  );
}

export function ArchiveButton(props: { campaignId: string; csrf: ReactNode }) {
  return (
    <ControlForm
      {...props}
      action={archiveCampaignAction}
      label="Archive"
      pendingLabel="Archiving…"
      variant="ghost"
    />
  );
}

/**
 * Who this campaign will contact.
 *
 * One number per line, with optional comma-separated template variables -
 * deliberately simpler than bulk's CSV upload and its column-mapping screen. A
 * campaign's audience is typically one column somebody already has, and asking
 * them to map columns for a single required field would be three screens to
 * collect one.
 *
 * The parsing, the rejects and the positional ordering of variables all come
 * from the same `buildAudience` bulk messaging uses. A second copy would be one
 * edit from disagreeing about the order, which is where the order number ends
 * up in place of the customer's name.
 */
export function AudienceForm({
  campaignId,
  csrf,
}: {
  campaignId: string;
  csrf: ReactNode;
}) {
  const [state, action, pending] = useActionState<CampaignState, FormData>(
    importAudienceAction,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-sm">
      {csrf}
      <input type="hidden" name="campaignId" value={campaignId} />
      <Field
        label="Add people to contact"
        name="numbers"
        required
        placeholder="+919876543210, Asha"
        description="One phone number per line. Add template variables after a comma, in the order the template uses them."
      />
      <FormStatus message={state.error} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Adding…" : "Add to audience"}
      </Button>
    </form>
  );
}
