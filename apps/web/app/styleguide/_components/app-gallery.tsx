"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { VerifyBanner } from "@/components/brand/verify-banner";
import { Section, SubHeading } from "./primitives";

/**
 * The application-shell primitives.
 *
 * A client component only because the dropdown and the banner are interactive
 * and the styleguide has to demonstrate them open and dismissible. Field and
 * FormStatus are server components in real use — nothing here changes that.
 */

export function FieldGallery() {
  return (
    <Section
      id="fields"
      title="Fields"
      lede="Label, control and message wired together once. The error message is linked by aria-describedby and the required marker is decorative — the real signal is the required attribute."
    >
      <div className="grid grid-cols-1 gap-xl desktop:grid-cols-2">
        <div className="flex flex-col gap-lg">
          <SubHeading>States</SubHeading>

          <Field
            label="Work email"
            name="sg-field-email"
            type="email"
            placeholder="you@company.com"
            autoComplete="email"
            required
          />

          <Field
            label="Username"
            name="sg-field-username"
            description="Letters, numbers, dots and underscores. 3–32 characters."
            defaultValue="ada_l"
            autoComplete="username"
            required
            readOnly
          />

          <Field
            label="Work email"
            name="sg-field-error"
            defaultValue="not-an-email"
            error="Enter a valid email address."
            required
            readOnly
          />

          <Field
            label="Company name"
            name="sg-field-disabled"
            placeholder="Unavailable"
            disabled
          />

          <SubHeading>Password autocomplete</SubHeading>
          <Field
            label="Password (sign up)"
            name="sg-field-new-password"
            type="password"
            autoComplete="new-password"
            required
          />
          <Field
            label="Password (sign in)"
            name="sg-field-current-password"
            type="password"
            autoComplete="current-password"
            required
          />
          <p className="text-caption text-muted">
            The two are different attributes on purpose: new-password asks a
            password manager to offer a generated one, current-password asks it
            to fill the saved one. Neither field sets maxLength — that would
            silently truncate a pasted passphrase, and the 256 cap belongs in
            the schema.
          </p>
        </div>

        <div className="flex flex-col gap-lg">
          <SubHeading>Form status</SubHeading>

          <FormStatus message="That username and password do not match." />

          <FormStatus
            tone="success"
            message="Check your inbox — we sent a verification link."
          />

          <p className="text-caption text-muted">
            The live region is always mounted, even with no message. Rendering
            it only when there is text means the region and its content appear
            together, and most screen readers announce nothing at all.
          </p>

          <SubHeading>Verify banner</SubHeading>
          <VerifyBanner email="ada@example.com" />
          <p className="text-caption text-muted">
            Dismissible until reload, never permanently — an unverified account
            is a real outstanding task. Resend is a form submission because it
            has a side effect.
          </p>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

export function ShellGallery() {
  return (
    <Section
      id="shell"
      title="Shell primitives"
      lede="Empty states and the profile menu. Every section of the application shell lands empty first, so the empty state is the designed default rather than a spinner."
    >
      <SubHeading>Empty state</SubHeading>
      <div className="grid grid-cols-1 gap-lg desktop:grid-cols-2">
        <EmptyState
          tone="mint"
          title="No campaigns yet"
          description="Bulk messaging sends a template to a list of contacts, with delivery reporting per recipient."
          action={
            <Button>
              <Plus size={16} aria-hidden="true" />
              New campaign
            </Button>
          }
        />

        <EmptyState
          tone="lavender"
          title="Nothing in the inbox"
          description="Replies from your contacts land here. Nothing has come in yet."
        />
      </div>

      <SubHeading>Profile menu</SubHeading>
      <div className="rounded-xl border border-hairline bg-surface-card p-lg">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Ada Lovelace</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Signed in</DropdownMenuLabel>
            <DropdownMenuItem>Personal details</DropdownMenuItem>
            <DropdownMenuItem>Documents</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Log out</DropdownMenuItem>
            <DropdownMenuItem disabled>Disabled item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <p className="mt-sm text-caption text-muted">
          Re-tokenised from the shadcn shape: the generator emits bg-popover,
          text-popover-foreground and border-input, none of which exist here.
        </p>
      </div>
    </Section>
  );
}
