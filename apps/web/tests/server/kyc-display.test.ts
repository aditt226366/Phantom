import { describe, expect, it } from "vitest";
import { KYC_KINDS, type FeatureBlock, type KycStatus } from "@whatsapp-os/core/kyc";
import {
  blockedCopy,
  canReplace,
  formatBytes,
  kindLabel,
  statusLabel,
  statusVariant,
} from "@/lib/kyc-display";

/**
 * The rendering decisions, asserted as values.
 *
 * The reason these are extracted from the pages at all is the lesson in the
 * conventions file: asserting a rendered substring is not a test of a branch.
 * A check that the markup contained "Reactivate" stayed green after the
 * control was deleted, because the word survived in a neighbouring heading.
 */

const EVERY_STATUS: (KycStatus | null)[] = [
  null,
  "PENDING",
  "APPROVED",
  "REJECTED",
];

describe("the status chip", () => {
  it("has a label and a variant for every state, including never-uploaded", () => {
    /*
     * Null is a state and not a missing value - it is the most common thing
     * this page renders, because it is where every account starts. A version
     * that treated it as absent would render three empty chips on a new
     * tenant's first visit.
     */
    for (const status of EVERY_STATUS) {
      expect(statusLabel(status), `no label for ${status}`).toBeTruthy();
      expect(statusVariant(status), `no variant for ${status}`).toBeTruthy();
    }
  });

  it("does not paint a new tenant's untouched documents red", () => {
    /*
     * The decision worth asserting. Nothing has gone wrong when an account has
     * not filed a document yet, and three red chips on the first visit tell
     * somebody they have already failed at something they have not started.
     */
    expect(statusVariant(null)).toBe("outline");
    expect(statusVariant("REJECTED")).toBe("error");
    expect(statusVariant("APPROVED")).toBe("success");
  });

  it("calls a pending document reviewed rather than pending", () => {
    /* "Pending" describes our queue; "In review" describes what is happening
       to their document. The tenant is the reader. */
    expect(statusLabel("PENDING")).toBe("In review");
    expect(statusLabel(null)).toBe("Not uploaded");
  });
});

describe("what may be replaced", () => {
  it("locks only an approved document", () => {
    /*
     * A re-upload over an approval would silently un-verify the account: the
     * new row is PENDING, the gate shuts, and nothing the tenant did looked
     * like turning the product off.
     *
     * Waiting is not a reason to refuse a better scan, and a rejection is an
     * instruction to send one - so those two stay open.
     */
    expect(canReplace("APPROVED")).toBe(false);
    expect(canReplace("PENDING")).toBe(true);
    expect(canReplace("REJECTED")).toBe(true);
    expect(canReplace(null)).toBe(true);
  });
});

describe("the document names", () => {
  it("names all three", () => {
    for (const kind of KYC_KINDS) {
      expect(kindLabel(kind), `no label for ${kind}`).toBeTruthy();
    }

    expect(kindLabel("GST")).toBe("GST Certificate");
  });
});

describe("the blocked state's copy", () => {
  const EVERY_REASON: FeatureBlock[] = [
    "company_deactivated",
    "documents_missing",
    "documents_rejected",
    "documents_pending",
  ];

  it("says what is wrong and what to do, for every reason", () => {
    /*
     * A blocked page that only names its own state sends the reader to
     * support, which is the outcome the designed state exists to avoid. Every
     * reason gets both halves.
     */
    for (const reason of EVERY_REASON) {
      const copy = blockedCopy(reason);

      expect(copy.title, `no title for ${reason}`).toBeTruthy();
      expect(copy.description, `no description for ${reason}`).toBeTruthy();
    }
  });

  it("does not send a suspended workspace to upload paperwork", () => {
    /*
     * The one branch that differs, and the reason the flag exists. Documents
     * will not lift a suspension, so offering the link would send somebody to
     * do work that changes nothing.
     */
    expect(blockedCopy("company_deactivated").showDocumentsLink).toBe(false);
    expect(blockedCopy("documents_missing").showDocumentsLink).toBe(true);
    expect(blockedCopy("documents_rejected").showDocumentsLink).toBe(true);
    expect(blockedCopy("documents_pending").showDocumentsLink).toBe(true);
  });

  it("tells a waiting tenant that nothing is needed from them", () => {
    /* The pending state is the only one where the right action is to do
       nothing, and saying so is what stops somebody re-uploading. */
    expect(blockedCopy("documents_pending").description).toMatch(
      /nothing more is needed/i,
    );
  });
});

describe("file sizes", () => {
  it("uses binary units, matching the cap", () => {
    /*
     * The limit is 5 MiB. Rendering a file at exactly the cap as "5.2 MB"
     * beside a rule that says 5 MB is a support conversation nobody needs.
     */
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});
