import type { ResealCounts } from "@whatsapp-os/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the job does with the counts it gets back.
 *
 * The rotation itself is proved against a real database in
 * packages/db/tests/vault-reseal.test.ts, including the row lock. What is
 * asserted here is the reporting rule, which is where a partial rotation
 * either gets noticed or does not.
 */

const resealCompanySecrets = vi.fn<() => Promise<ResealCounts>>();

vi.mock("@whatsapp-os/db", () => ({ resealCompanySecrets }));

const { handleVaultReseal } = await import("../src/jobs/vault-reseal.ts");

function captureLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];

  const error = vi
    .spyOn(console, "error")
    .mockImplementation((line: unknown) => void lines.push(String(line)));
  const out = vi
    .spyOn(console, "log")
    .mockImplementation((line: unknown) => void lines.push(String(line)));

  return {
    lines,
    restore: () => {
      error.mockRestore();
      out.mockRestore();
    },
  };
}

beforeEach(() => {
  resealCompanySecrets.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a clean rotation", () => {
  it("reports the counts and succeeds", async () => {
    resealCompanySecrets.mockResolvedValue({
      resealed: 3,
      alreadyActive: 1,
      failures: [],
    });

    const capture = captureLines();
    try {
      const result = await handleVaultReseal({ companyId: "c1" });

      expect(result).toEqual({
        companyId: "c1",
        resealed: 3,
        alreadyActive: 1,
        failed: 0,
      });
      expect(capture.lines.join("\n")).toContain('"level":"info"');
    } finally {
      capture.restore();
    }
  });
});

describe("a rotation with failures", () => {
  const withFailures: ResealCounts = {
    resealed: 2,
    alreadyActive: 0,
    failures: [
      {
        secretId: "s1",
        key: "META_ADS_ACCESS_TOKEN",
        reason: 'sealed with key "k1", which is not in the keyring (have: k2)',
      },
    ],
  };

  it("does not report success", async () => {
    /*
     * The reason this matters: reporting success lets an operator see
     * "rotated", check that nothing remains on the old key, and drop it —
     * destroying the only thing that could still open the row that failed.
     */
    resealCompanySecrets.mockResolvedValue(withFailures);

    const capture = captureLines();
    try {
      await expect(handleVaultReseal({ companyId: "c1" })).rejects.toThrow(
        /unrotated/i,
      );
    } finally {
      capture.restore();
    }
  });

  it("logs at error level, naming the key and the missing key id", async () => {
    resealCompanySecrets.mockResolvedValue(withFailures);

    const capture = captureLines();
    try {
      await handleVaultReseal({ companyId: "c1" }).catch(() => undefined);

      const logged = capture.lines.join("\n");
      expect(logged).toContain('"level":"error"');
      expect(logged).toContain("META_ADS_ACCESS_TOKEN");
      expect(logged).toContain("k1");
    } finally {
      capture.restore();
    }
  });

  it("still says how many rows did rotate", async () => {
    /* A failure must not hide the progress that was made, or a rerun looks
       like it has everything to do again. */
    resealCompanySecrets.mockResolvedValue(withFailures);

    const capture = captureLines();
    try {
      await handleVaultReseal({ companyId: "c1" }).catch(() => undefined);

      expect(capture.lines.join("\n")).toContain('"resealed":2');
    } finally {
      capture.restore();
    }
  });
});
