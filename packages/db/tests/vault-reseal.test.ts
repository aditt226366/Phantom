import {
  createKeyring,
  decrypt,
  encrypt,
  generateEncryptionKey,
  secretAad,
  type Keyring,
} from "@whatsapp-os/core";
import { beforeEach, describe, expect, it } from "vitest";
import { resealCompanySecrets, withCompany } from "../src/index.ts";
import { seedCompany, truncateAll, type SeededCompany } from "./helpers.ts";

/**
 * Key rotation, and the race that makes it dangerous.
 */

const KEY_ONE = generateEncryptionKey();
const KEY_TWO = generateEncryptionKey();

/** Before rotation: k1 only, k1 active. */
const OLD_RING = createKeyring(`k1:${KEY_ONE}`, "k1");
/** During rotation: both present, k2 active. */
const ROTATING = createKeyring(`k1:${KEY_ONE},k2:${KEY_TWO}`, "k2");
/** After dropping the old key. */
const AFTER_DROP = createKeyring(`k2:${KEY_TWO}`, "k2");

const KEY = "META_ADS_ACCESS_TOKEN";
const ORIGINAL = "EAAG-original-access-token-0001";

let company: SeededCompany;
let integrationId: string;
let secretId: string;

/** Seed one integration with one secret, sealed under `ring`. */
async function seedSecret(ring: Keyring, plaintext: string): Promise<void> {
  await withCompany(company.id, async (db, companyId) => {
    const integration = await db.integration.create({
      data: { companyId, provider: "META_ADS", label: "Ads" },
    });
    integrationId = integration.id;

    const secret = await db.integrationSecret.create({
      data: {
        companyId,
        integrationId: integration.id,
        key: KEY,
        ciphertext: encrypt(
          plaintext,
          ring,
          secretAad(companyId, integration.id, KEY),
        ),
        keyId: ring.activeId,
        last4: plaintext.slice(-4),
      },
    });
    secretId = secret.id;
  });
}

async function storedRow(): Promise<{ ciphertext: string; key_id: string }> {
  const [row] = await withCompany(company.id, (db) => db.$queryRaw<
    Array<{ ciphertext: string; key_id: string }>
  >`SELECT ciphertext, key_id FROM integration_secrets WHERE id = ${secretId}`);

  return row!;
}

async function storedPlaintext(ring: Keyring): Promise<string> {
  const row = await storedRow();
  return decrypt(row.ciphertext, ring, secretAad(company.id, integrationId, KEY));
}

beforeEach(async () => {
  await truncateAll();
  company = await seedCompany("reseal");
});

describe("resealCompanySecrets", () => {
  it("moves a row onto the active key without changing what it holds", async () => {
    await seedSecret(OLD_RING, ORIGINAL);

    const counts = await resealCompanySecrets(company.id, ROTATING);

    expect(counts).toEqual({ resealed: 1, alreadyActive: 0, failures: [] });
    expect((await storedRow()).key_id).toBe("k2");
    expect(await storedPlaintext(ROTATING)).toBe(ORIGINAL);
  });

  it("leaves the row openable after the old key is dropped", async () => {
    /* The point of rotating at all. */
    await seedSecret(OLD_RING, ORIGINAL);
    await resealCompanySecrets(company.id, ROTATING);

    expect(await storedPlaintext(AFTER_DROP)).toBe(ORIGINAL);
  });

  it("keeps the AAD, so a resealed row is still bound to its company", async () => {
    await seedSecret(OLD_RING, ORIGINAL);
    await resealCompanySecrets(company.id, ROTATING);

    const row = await storedRow();

    expect(() =>
      decrypt(
        row.ciphertext,
        ROTATING,
        secretAad("some-other-company", integrationId, KEY),
      ),
    ).toThrow(/decryption failed/i);
  });

  it("is a no-op the second time", async () => {
    await seedSecret(OLD_RING, ORIGINAL);
    await resealCompanySecrets(company.id, ROTATING);

    const again = await resealCompanySecrets(company.id, ROTATING);

    expect(again).toEqual({ resealed: 0, alreadyActive: 0, failures: [] });
  });
});

describe("a row whose key is gone", () => {
  it("fails loudly, naming the key, and is never skipped", async () => {
    /*
     * The row vault:status counts as undecryptable. Skipping it is how a
     * credential survives a rotation, passes a key_id-based completion check,
     * and is found months later by a failing provider call with the key
     * material long since deleted.
     */
    await seedSecret(OLD_RING, ORIGINAL);

    const stranded = createKeyring(`k2:${KEY_TWO}`, "k2");
    const counts = await resealCompanySecrets(company.id, stranded);

    expect(counts.resealed).toBe(0);
    expect(counts.alreadyActive).toBe(0);
    expect(counts.failures).toHaveLength(1);
    expect(counts.failures[0]?.key).toBe(KEY);
    expect(counts.failures[0]?.reason).toContain("k1");
  });

  it("leaves the row untouched rather than half-written", async () => {
    await seedSecret(OLD_RING, ORIGINAL);
    const before = await storedRow();

    await resealCompanySecrets(company.id, createKeyring(`k2:${KEY_TWO}`, "k2"));

    expect(await storedRow()).toEqual(before);
  });

  it("still rotates the rows it can", async () => {
    /* One bad row aborts that row, not the batch. */
    await seedSecret(OLD_RING, ORIGINAL);

    const strandedKey = generateEncryptionKey();
    await withCompany(company.id, (db, companyId) =>
      db.integrationSecret.create({
        data: {
          companyId,
          integrationId,
          key: "META_AD_ACCOUNT_ID",
          ciphertext: encrypt(
            "act_999",
            createKeyring(`k9:${strandedKey}`, "k9"),
            secretAad(companyId, integrationId, "META_AD_ACCOUNT_ID"),
          ),
          keyId: "k9",
          last4: null,
        },
      }),
    );

    const counts = await resealCompanySecrets(company.id, ROTATING);

    expect(counts.resealed).toBe(1);
    expect(counts.failures).toHaveLength(1);
    expect(counts.failures[0]?.key).toBe("META_AD_ACCOUNT_ID");
  });
});

describe("a concurrent save", () => {
  it("applies after the reseal commits, and wins", async () => {
    /*
     * The lost update this lock exists to prevent.
     *
     * Without FOR UPDATE: reseal reads the old value, the save writes a new
     * one, reseal then writes the old value back re-encrypted. The row is
     * valid, decryptable, carries the right key_id, and holds a secret the
     * operator replaced minutes ago — and nothing detects it, because every
     * check a rotation performs passes.
     *
     * With the lock, the save queues behind the reseal and lands on top.
     */
    await seedSecret(OLD_RING, ORIGINAL);

    const SAVED = "EAAG-saved-by-the-operator-0002";

    let saveApplied = false;
    let releaseReseal!: () => void;
    const resealHolding = new Promise<void>((resolve) => {
      releaseReseal = resolve;
    });

    let lockTaken!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });

    /* Reseal, holding the row lock until told to finish. */
    const reseal = withCompany(company.id, async (db, companyId) => {
      const rows = await db.$queryRaw<Array<{ ciphertext: string }>>`
        SELECT ciphertext FROM integration_secrets WHERE id = ${secretId} FOR UPDATE
      `;

      lockTaken();
      await resealHolding;

      const plaintext = decrypt(
        rows[0]!.ciphertext,
        ROTATING,
        secretAad(companyId, integrationId, KEY),
      );

      await db.integrationSecret.update({
        where: { id: secretId },
        data: {
          ciphertext: encrypt(
            plaintext,
            ROTATING,
            secretAad(companyId, integrationId, KEY),
          ),
          keyId: ROTATING.activeId,
        },
      });
    });

    await lockAcquired;

    /* The operator's save, from a separate connection. It must block. */
    const save = withCompany(company.id, async (db, companyId) => {
      await db.integrationSecret.update({
        where: { id: secretId },
        data: {
          ciphertext: encrypt(
            SAVED,
            ROTATING,
            secretAad(companyId, integrationId, KEY),
          ),
          keyId: ROTATING.activeId,
          last4: SAVED.slice(-4),
        },
      });
      saveApplied = true;
    });

    /* Long enough that an unblocked save would certainly have finished. */
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(saveApplied, "the save was not blocked by the row lock").toBe(false);

    releaseReseal();
    await reseal;
    await save;

    expect(saveApplied).toBe(true);
    expect(await storedPlaintext(ROTATING)).toBe(SAVED);
  });

  it("is not lost when the save commits mid-reseal", async () => {
    /*
     * The test above proves Postgres honours FOR UPDATE. This one proves
     * resealCompanySecrets actually takes it, and it is the only assertion
     * here that fails if the clause is removed.
     *
     * An uncommitted save holds the row lock. Then:
     *
     *   with FOR UPDATE     the reseal's first statement blocks. When the save
     *                       commits, READ COMMITTED re-reads the new version,
     *                       sees key_id already active, and does nothing. The
     *                       saved value survives.
     *
     *   without it          the reseal reads the pre-save snapshot, decrypts
     *                       the OLD value, and only blocks at the UPDATE. That
     *                       write then lands, overwriting the save with a
     *                       re-encrypted stale plaintext — valid, decryptable,
     *                       right key_id, wrong secret.
     */
    await seedSecret(OLD_RING, ORIGINAL);

    const SAVED = "EAAG-saved-mid-rotation-0003";

    let commitSave!: () => void;
    const holdSave = new Promise<void>((resolve) => {
      commitSave = resolve;
    });

    let saveWritten!: () => void;
    const saveHasWritten = new Promise<void>((resolve) => {
      saveWritten = resolve;
    });

    /* An operator's save, written but not yet committed. */
    const save = withCompany(company.id, async (db, companyId) => {
      await db.integrationSecret.update({
        where: { id: secretId },
        data: {
          ciphertext: encrypt(
            SAVED,
            ROTATING,
            secretAad(companyId, integrationId, KEY),
          ),
          keyId: ROTATING.activeId,
          last4: SAVED.slice(-4),
        },
      });

      saveWritten();
      await holdSave;
    });

    await saveHasWritten;

    const reseal = resealCompanySecrets(company.id, ROTATING);

    /* Let the reseal get as far as it is going to get while the lock is held. */
    await new Promise((resolve) => setTimeout(resolve, 250));

    commitSave();
    await save;

    const counts = await reseal;

    expect(await storedPlaintext(ROTATING)).toBe(SAVED);
    expect(counts.resealed).toBe(0);
    expect(counts.alreadyActive).toBe(1);
  });
});
