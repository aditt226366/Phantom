import type { ReactNode } from "react";

/** Page header shared by every section. */
export function SectionHeader({
  title,
  lede,
}: {
  title: string;
  lede?: string;
}) {
  return (
    <header className="mb-lg">
      <h1 className="text-display-md text-ink">{title}</h1>
      {lede ? (
        <p className="mt-xs max-w-2xl text-body-md text-body">{lede}</p>
      ) : null}
    </header>
  );
}

export function SectionShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-container">{children}</div>;
}
