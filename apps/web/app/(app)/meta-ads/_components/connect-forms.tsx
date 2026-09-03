"use client";

import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { removeAdAccountAction, selectAdAccountAction, type MetaAdsState } from "../actions";

/**
 * Choosing the account that will spend money, and the Page it spends from.
 *
 * The CSRF field arrives as a prop rather than an import: it is a Server
 * Component, and a client module importing one drags next/headers into the
 * browser graph and fails the build with an import trace naming every file
 * except this one.
 */

export interface AccountOption {
  id: string;
  name: string;
  currency: string;
  accountStatus: number | null;
}

export interface PageOption {
  id: string;
  name: string;
  /** What checkLinkedNumber concluded, already turned into a sentence. */
  linkMessage: string;
  linkKind: "matched" | "elsewhere" | "unlinked";
}

export function ConnectForm({
  csrf,
  accounts,
  pages,
}: {
  csrf: ReactNode;
  accounts: readonly AccountOption[];
  pages: readonly PageOption[];
}) {
  const [state, action, pending] = useActionState<MetaAdsState, FormData>(
    selectAdAccountAction,
    {},
  );

  /*
   * Held in state so the warning below changes as the Page changes, before
   * anything is submitted. The whole value of that sentence is that it arrives
   * BEFORE the tenant commits, not after - a message shown only on the result
   * page is a message about money already being spent.
   */
  const [pageId, setPageId] = useState<string>(pages[0]?.id ?? "");
  const selectedPage = pages.find((page) => page.id === pageId);

  return (
    <form action={action} className="flex flex-col gap-base">
      {csrf}

      <div className="flex flex-col gap-xs">
        <Label htmlFor="adAccountId">Ad account</Label>
        <select
          id="adAccountId"
          name="adAccountId"
          required
          /* Matching Input's own class list rather than approximating it.
             There is no Select component in this system yet, and a hand-rolled
             one that merely looks similar drifts the first time Input changes. */
          className="h-input w-full rounded-md border border-hairline-strong bg-surface-card px-base py-sm font-body text-body-md text-ink focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ink"
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} — {account.currency}
            </option>
          ))}
        </select>
        <p className="text-caption text-muted">
          Spend is reported in each account&apos;s own currency and never added
          across them.
        </p>
      </div>

      <div className="flex flex-col gap-xs">
        <Label htmlFor="pageId">Page the ads post from</Label>
        <select
          id="pageId"
          name="pageId"
          value={pageId}
          onChange={(event) => setPageId(event.target.value)}
          /* Matching Input's own class list rather than approximating it.
             There is no Select component in this system yet, and a hand-rolled
             one that merely looks similar drifts the first time Input changes. */
          className="h-input w-full rounded-md border border-hairline-strong bg-surface-card px-base py-sm font-body text-body-md text-ink focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ink"
        >
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.name}
            </option>
          ))}
        </select>
        <input type="hidden" name="pageName" value={selectedPage?.name ?? ""} />
      </div>

      {selectedPage ? (
        <p
          className={
            selectedPage.linkKind === "matched"
              ? "rounded-md border border-hairline bg-surface-strong p-sm text-body-sm text-ink"
              : "rounded-md border border-hairline bg-surface-strong p-sm text-body-sm text-error"
          }
        >
          {selectedPage.linkMessage}
        </p>
      ) : null}

      <FormStatus
        message={state.error ?? state.notice}
        tone={state.error ? "error" : "success"}
      />

      <Button type="submit" disabled={pending}>
        {pending ? "Connecting…" : "Connect ad account"}
      </Button>
    </form>
  );
}

export function RemoveAccountForm({ csrf, id }: { csrf: ReactNode; id: string }) {
  const [state, action, pending] = useActionState<MetaAdsState, FormData>(
    removeAdAccountAction,
    {},
  );

  return (
    <form action={action} className="flex flex-col items-start gap-xs">
      {csrf}
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" disabled={pending}>
        {pending ? "Removing…" : "Remove"}
      </Button>
      <FormStatus
        message={state.error ?? state.notice}
        tone={state.error ? "error" : "success"}
      />
    </form>
  );
}
