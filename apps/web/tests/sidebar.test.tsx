import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_SECTIONS, isActiveSection } from "@/lib/nav";
import { Sidebar } from "@/components/app-shell/sidebar";

let pathname = "/dashboard";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

/** next/link renders an anchor; that is all these tests need from it. */
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function Harness({ open = true }: { open?: boolean }) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [isOpen, setOpen] = React.useState(open);

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open navigation
      </button>
      <Sidebar
        open={isOpen}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
      />
    </>
  );
}

beforeEach(() => {
  pathname = "/dashboard";
});

describe("nav config", () => {
  it("renders every section from lib/nav.ts", () => {
    render(<Harness />);

    for (const section of NAV_SECTIONS) {
      const link = screen.getByRole("link", { name: section.label });
      expect(link.getAttribute("href")).toBe(section.href);
    }
  });

  it("has the seven sections in order", () => {
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
      "Dashboard",
      "AI Messaging",
      "Template Messaging",
      "Bulk Messaging",
      "Meta Ads",
      "Configuration",
      "Billing",
    ]);
  });

  it("matches on a segment boundary, not a prefix", () => {
    /* Otherwise /bulk-messaging would light up for /bulk-messaging-archive. */
    expect(isActiveSection("/bulk-messaging", "/bulk-messaging")).toBe(true);
    expect(isActiveSection("/bulk-messaging", "/bulk-messaging/new")).toBe(true);
    expect(isActiveSection("/bulk-messaging", "/bulk-messaging-archive")).toBe(
      false,
    );
  });
});

describe("active item", () => {
  it("marks the current section with aria-current", () => {
    pathname = "/meta-ads";
    render(<Harness />);

    /* Colour alone tells a screen-reader user nothing. */
    expect(
      screen.getByRole("link", { name: "Meta Ads" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("marks exactly one item", () => {
    pathname = "/configuration";
    render(<Harness />);

    const current = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");

    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Configuration");
  });

  it("keeps the parent marked on a nested route", () => {
    pathname = "/template-messaging/new";
    render(<Harness />);

    expect(
      screen
        .getByRole("link", { name: "Template Messaging" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });
});

describe("overlay behaviour", () => {
  it("moves focus into the panel when opened", () => {
    render(<Harness />);

    /*
     * Compared by element, not by text: the close button is an icon and its
     * name comes from aria-label, so its textContent is empty.
     *
     * Otherwise focus is left on the page behind and Tab goes nowhere useful.
     */
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close navigation" }),
    );
  });

  it("closes on Escape", () => {
    render(<Harness />);
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeDefined();

    fireEvent.keyDown(document, { key: "Escape" });

    /* The panel stays mounted — it is the persistent sidebar at desktop — so
       what changes is focus returning, asserted below. */
    expect(document.activeElement?.textContent).toBe("Open navigation");
  });

  it("returns focus to the trigger on close", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open navigation" });

    fireEvent.keyDown(document, { key: "Escape" });

    /* Without this the user is dropped at the top of the document. */
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when a section is chosen", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("link", { name: "Meta Ads" }));

    expect(document.activeElement?.textContent).toBe("Open navigation");
  });

  it("traps Tab inside the panel", () => {
    render(<Harness />);

    const panel = screen.getByRole("navigation", { name: "Sections" })
      .parentElement!;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    /* Forward from the last element wraps to the first. */
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    /* And backward from the first wraps to the last. */
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("does not trap anything while closed", () => {
    render(<Harness open={false} />);

    const outside = screen.getByRole("button", { name: "Open navigation" });
    outside.focus();

    fireEvent.keyDown(document, { key: "Tab" });

    /* No preventDefault, so the browser's own tab order applies. */
    expect(document.activeElement).toBe(outside);
  });
});
