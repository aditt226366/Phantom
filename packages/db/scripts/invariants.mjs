import pg from "pg";

/**
 * The catalog invariants, and the connection they run against is a parameter.
 *
 * These assertions were written for the test database and lived inside two test
 * files. They are here because the database that needed checking turned out to
 * be a different one: dev had drifted, the suite was green throughout, and the
 * first symptom was a route that worked in tests and 500ed in a browser (C10).
 *
 * Nothing about them was test-specific except where they connected.
 *
 * ---------------------------------------------------------------------------
 * Why this cannot be `prisma migrate diff`
 * ---------------------------------------------------------------------------
 *
 * Everything checked here is invisible to it. Grants are not in the Prisma
 * schema language at all; column grants are not even in pg_class.relacl, they
 * live in pg_attribute.attacl. CHECK constraints, column storage and triggers
 * have no schema.prisma expression either. `migrate diff` compares the tables
 * and columns it can describe and reports "No difference detected" over a
 * database whose privileges have moved.
 *
 * So this is not a second opinion about drift. It is the only opinion about
 * this half of it.
 *
 * Read-only: every statement below is a SELECT against a system catalog. It is
 * safe to point at production, which is the point - see the Phase 12 launch
 * gate in docs/plans/spec-amendments.md.
 */

/**
 * Every column-level grant in the schema, to any role.
 *
 * Named for what it checks rather than for who currently appears in it. A stray
 * column grant to app_runtime or app_admin is exactly as undecided as one to
 * app_resolver, and the query that finds one finds all - so a narrower name
 * would read, later, as permission to grant elsewhere.
 *
 * The entry is (table, column, grantee, privilege), not (table, column). SELECT
 * on a column and UPDATE on the same column are different decisions, and an
 * allowlist that recorded only the column would let a grant widen from read to
 * write with no diff here at all.
 */
export const COLUMN_GRANTS = new Set([
  /* app_resolve_company joins companies and checks suspension; the id and
     deactivated_at are the whole of it. */
  "companies.id:app_resolver:SELECT",
  "companies.deactivated_at:app_resolver:SELECT",
  /* app_available_slug: SELECT 1 ... WHERE slug = $1, and nothing else. */
  "companies.slug:app_resolver:SELECT",
  /* app_resolve_company's 'webhook' kind: the key it matches, the id it
     returns, and the provider it constrains on so that a Sheets or Ads key
     cannot resolve into a WhatsApp handler. */
  "integrations.webhook_key:app_resolver:SELECT",
  "integrations.company_id:app_resolver:SELECT",
  "integrations.provider:app_resolver:SELECT",
  /* app_resolve_company's 'lead_source' kind: the key it matches and the id it
     returns, and deliberately nothing else. The resolver has no business
     reading a spreadsheet id, a mapping or a cursor - and the next column added
     to lead_sources must not become visible to it for free, which is exactly
     how deactivated_at became readable on another table before anyone decided
     to grant it. */
  "lead_sources.webhook_key:app_resolver:SELECT",
  "lead_sources.company_id:app_resolver:SELECT",
  /* The tenant runtime writes unroutable_webhooks but must not enumerate it.
     These three are forced by the upsert - RETURNING needs id, ON CONFLICT
     reads its arbiter column, and the increment reads what it writes. What is
     absent is the point: company_id, reason, last_ip_hash and the timestamps
     stay unreadable, so a tenant request cannot learn which companies are
     failing verification.

     Two of these three were missing from the development database for eight
     commits, and the upsert is the only thing that reads them - so the failure
     was a 500 on the one path nobody had exercised against a real database. */
  "unroutable_webhooks.id:app_runtime:SELECT",
  "unroutable_webhooks.webhook_key_hash:app_runtime:SELECT",
  "unroutable_webhooks.attempt_count:app_runtime:SELECT",
]);

/**
 * Tables where app_resolver still holds a *whole-table* SELECT grant.
 *
 * app_resolver answers one question - "which company does this opaque key
 * belong to" - from outside every company context, running SECURITY DEFINER.
 * The entire argument for giving it that reach is that it can see almost
 * nothing, and a whole-table grant is how that stops being true without anyone
 * deciding it.
 *
 * companies has since been narrowed to three columns and is deliberately
 * absent. These four are listed rather than fixed, because each needs its own
 * reading of which columns the lookup functions touch, and bundling four
 * narrowings into one migration is how one of them goes wrong quietly.
 */
export const RESOLVER_TABLE_GRANTS = new Set([
  /* app_resolve_company: username and email lookups. */
  "users",
  /* app_resolve_company: the session token lookup. */
  "sessions",
  /* app_resolve_company: consuming an unauthenticated verification link. */
  "email_verification_tokens",
  /* app_resolve_company: consuming an unauthenticated reset link. */
  "password_reset_tokens",
]);

/**
 * Database objects that schema.prisma cannot express.
 *
 * Everything here is invisible to `prisma migrate diff`. It lives only in a
 * migration, the schema file has no way to describe it, and the drift check
 * reports nothing when it disappears - so dropping one is a silent change to
 * what the database guarantees, and adding one by hand is a decision only its
 * author knows about.
 *
 * Format is `kind:table.object`, plus the value for storage, so that a change
 * of *setting* is as loud as a removal.
 */
export const OUT_OF_BAND_DDL = new Set([
  /* The 5 MiB cap on stored media. The real enforcement aborts the download
     once the running byte count crosses the limit; this is the backstop that
     does not depend on the caller having behaved. */
  "check:whatsapp_media.whatsapp_media_bytes_within_cap",
  /* byte_size cannot disagree with the bytes actually present. */
  "check:whatsapp_media.whatsapp_media_byte_size_matches",
  "check:whatsapp_media.whatsapp_media_byte_size_non_negative",
  /* EXTERNAL, not the type's default EXTENDED. Load-bearing: the read path
     slices this column with substring() to stream it, and a compressed value
     has to be decompressed from the start, so every slice would become a full
     read and the streaming would be a fiction. */
  "storage:whatsapp_media.bytes=e",
  /* 64 KiB on a stored webhook body. The route truncates and flags; this is
     the backstop that does not depend on it having done so. */
  "check:whatsapp_webhook_events.whatsapp_webhook_events_payload_within_cap",
  /* The same three for a KYC document, and one more. The upload path already
     enforces the cap while streaming and the file type from the bytes in hand;
     these are what a second upload path added later inherits without knowing
     they exist. */
  "check:kyc_documents.kyc_documents_bytes_within_cap",
  "check:kyc_documents.kyc_documents_byte_size_matches",
  /* First five bytes are %PDF-. A file type is what its content says it is,
     never its name or the Content-Type the browser volunteered. */
  "check:kyc_documents.kyc_documents_bytes_are_pdf",
  /* EXTERNAL for the same reason whatsapp_media.bytes is: the download route
     slices this column to stream it. */
  "storage:kyc_documents.bytes=e",
  /* Pacing has to be a pace. Zero would make a broadcast one burst - the
     behaviour the gap exists to prevent - and a negative value is not a delay
     BullMQ can schedule. Capped at a day, past which it is a schedule and not
     a send. Both copies, because the broadcast freezes its own at start. */
  "check:companies.companies_broadcast_gap_ms_sane",
  "check:broadcasts.broadcasts_gap_ms_sane",
  /* The cleaning pipeline's counts describe a file and cannot be negative. */
  "check:broadcasts.broadcasts_counts_non_negative",
  /* The discriminated action, in the schema. A TEMPLATE binding must name a
     template; a second action kind gets its own arm here, and the absence of
     one is a migration that fails rather than a binding that polls a sheet and
     does nothing with what it finds. */
  "check:lead_sources.lead_sources_action_has_its_target",
  /* Ten seconds to a day. Sheets meters reads per PROJECT, so a binding polling
     every second would consume the whole allowance and take every other
     tenant's bindings down with it. Mirrors POLL_INTERVAL_MIN/MAX_SECONDS. */
  "check:lead_sources.lead_sources_poll_interval_sane",
  "check:lead_sources.lead_sources_counts_non_negative",
  /* A skipped row explains itself and a sent one does not pretend to. Without
     it a row can be SENT carrying a skip reason, or SKIPPED with neither a
     reason nor a message - which renders as a blank cell in the report
     somebody is reading to find out why a customer was never contacted. */
  "check:lead_source_rows.lead_source_rows_state_matches_reason",
  /* A rollup counts things that happened. A subtraction going the wrong way
     renders as a bar drawn off the left of its track, which looks like a CSS
     bug and gets chased in the wrong file. */
  "check:dashboard_rollups.dashboard_rollups_counts_non_negative",
  /* The two partitions the delivery chart is presented as. The breakdown claims
     to account for every outbound message exactly once, so a FILTER clause that
     overlaps or misses a status makes the chart quietly not add up - and one
     statement computing all seven is the only thing that would ever notice.
     These are what makes the claim structural instead of a comment. */
  "check:dashboard_rollups.dashboard_rollups_ladder_partitions_outbound",
  "check:dashboard_rollups.dashboard_rollups_directions_partition_total",
  /* A thread cannot have replied without having been messaged - the reply
     rate's denominator bounds its numerator, so a rate over 100% is impossible
     rather than merely unlikely. */
  "check:dashboard_rollups.dashboard_rollups_replied_within_messaged",
  /* A version is numbered from one, and a published one names who published
     it. A published_at with nobody beside it is the shape of "the system
     turned this on by itself", and who turned an automated conversation on is
     the audit question a tenant asks first. */
  "check:flow_versions.flow_versions_version_positive",
  "check:flow_versions.flow_versions_published_has_publisher",
  /* The two halves of the partial-unique trick on flow_runs, and neither is
     optional. active_conversation_id is NULL exactly when the run is not live,
     which is what makes the plain unique index MEAN "one live run per
     conversation" - without it a live run carrying NULL slips a second live run
     straight past the index. And when it is non-null it is the run's OWN
     conversation, or the run holds somebody else's slot while advancing this
     one. */
  "check:flow_runs.flow_runs_active_conversation_matches_status",
  "check:flow_runs.flow_runs_active_conversation_is_its_own",
  /* A live run knows where it is standing, and PAUSED is the half that matters:
     a run whose window shut keeps its position, which is the whole difference
     between pausing and failing. A PAUSED row with no current_node_id has lost
     the thing pausing exists to keep, and the only symptom is a customer
     answering the same three questions twice. */
  "check:flow_runs.flow_runs_live_run_has_a_position",
  "check:flow_runs.flow_runs_ended_when_finished",
  "check:flow_runs.flow_runs_step_count_non_negative",
  "check:flow_run_steps.flow_run_steps_seq_positive",
  /* "A person is needed here" and why, together or not at all. A flagged thread
     with no reason is a blank cell in the queue somebody is reading to decide
     what to pick up; a reason with no flag is a sentence that would be shown
     the next time it IS flagged, for something unrelated. */
  "check:conversations.conversations_needs_human_has_a_reason",
  /* A thread a flow handled is still a thread. The card renders automated as a
     proportion of all conversations, so a count above the total draws a bar off
     the end of its track - which looks like a CSS bug and gets chased in the
     wrong file. */
  "check:dashboard_rollups.dashboard_rollups_automated_within_total",
]);

/**
 * Columns allowed to be `timestamp without time zone`. Empty, and meant to be.
 *
 * 20260816090000 converted all 64. A naive column stores a wall clock with no
 * offset, which the ORM is self-consistent about and raw SQL is not - a bound
 * Date cast to ::timestamp lands out by the node process's UTC offset.
 */
export const NAIVE_COLUMNS_ALLOWED = new Set([]);

/** Prisma's own bookkeeping, which it owns and already stores as timestamptz. */
const NOT_OURS = new Set(["_prisma_migrations"]);

function difference(actual, allowed, noun) {
  const findings = [];

  for (const entry of actual) {
    if (!allowed.has(entry)) findings.push(`unexpected ${noun}: ${entry}`);
  }

  for (const entry of allowed) {
    if (!actual.includes(entry)) findings.push(`missing ${noun}: ${entry}`);
  }

  return findings;
}

/** Every column-level grant, to every role, compared against the allowlist. */
export async function checkColumnGrants(client) {
  const { rows } = await client.query(
    `SELECT c.relname || '.' || a.attname || ':' ||
            COALESCE(r.rolname, 'PUBLIC') || ':' || acl.privilege_type AS entry
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
       LEFT JOIN pg_roles r ON r.oid = acl.grantee
      WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY entry`,
  );

  return difference(
    rows.map((row) => row.entry),
    COLUMN_GRANTS,
    "column grant",
  );
}

/** app_resolver's whole-table reach. */
export async function checkResolverTableGrants(client) {
  const { rows } = await client.query(
    `SELECT DISTINCT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'app_resolver' AND table_schema = 'public'
      ORDER BY table_name`,
  );

  return difference(
    rows.map((row) => row.table_name),
    RESOLVER_TABLE_GRANTS,
    "resolver table grant",
  );
}

/** CHECK constraints, column storage, triggers and exclusion constraints. */
export async function checkOutOfBandDdl(client) {
  const { rows } = await client.query(
    `SELECT 'check:' || c.relname || '.' || con.conname AS entry
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND con.contype = 'c'
     UNION ALL
     SELECT 'exclusion:' || c.relname || '.' || con.conname
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND con.contype = 'x'
     UNION ALL
     SELECT 'storage:' || c.relname || '.' || a.attname || '=' || a.attstorage::text
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attstorage <> t.typstorage
     UNION ALL
     SELECT 'trigger:' || c.relname || '.' || tg.tgname
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT tg.tgisinternal
      ORDER BY entry`,
  );

  return difference(
    rows.map((row) => row.entry),
    OUT_OF_BAND_DDL,
    "out-of-band object",
  );
}

/** Every timestamp column is timestamptz, at millisecond precision. */
export async function checkTimestampColumns(client) {
  const findings = [];

  const naive = await client.query(
    `SELECT table_name || '.' || column_name AS entry
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type = 'timestamp without time zone'
      ORDER BY entry`,
  );

  const ours = naive.rows
    .map((row) => row.entry)
    .filter((entry) => !NOT_OURS.has(entry.split(".")[0]));

  findings.push(...difference(ours, NAIVE_COLUMNS_ALLOWED, "naive timestamp column"));

  const precision = await client.query(
    `SELECT table_name || '.' || column_name AS entry, datetime_precision AS scale
       FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp with time zone'
      ORDER BY entry`,
  );

  for (const row of precision.rows) {
    if (NOT_OURS.has(row.entry.split(".")[0])) continue;
    if (row.scale !== 3) {
      findings.push(`timestamptz column is not (3): ${row.entry} has ${row.scale}`);
    }
  }

  /*
   * A guard against the whole thing passing because the query matched nothing -
   * a filter bug, or being pointed at an empty schema.
   */
  if (precision.rows.length < 50) {
    findings.push(
      `only ${precision.rows.length} timestamptz columns found; this database ` +
        "does not look migrated",
    );
  }

  return findings;
}

export const INVARIANTS = [
  { name: "column grants", run: checkColumnGrants },
  { name: "resolver table grants", run: checkResolverTableGrants },
  { name: "out-of-band DDL", run: checkOutOfBandDdl },
  { name: "timestamp columns", run: checkTimestampColumns },
];

/**
 * Run all four against one database. Opens and closes its own connection.
 *
 * Returns a result per invariant rather than throwing, so a caller can print
 * every finding at once - being told about one missing grant, fixing it, and
 * being told about the next is how a launch gate becomes four deploys.
 */
export async function runInvariants(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const results = [];
    for (const invariant of INVARIANTS) {
      results.push({ name: invariant.name, findings: await invariant.run(client) });
    }
    return results;
  } finally {
    await client.end();
  }
}
