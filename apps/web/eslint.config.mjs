import next from "eslint-config-next/core-web-vitals";

/**
 * Flat config. Next 16 removed `next lint`, so ESLint runs directly:
 *   npm run lint --workspace=web
 *
 * Pinned to ESLint 9: eslint-plugin-react (a transitive dependency of
 * eslint-config-next) has not been updated for ESLint 10's rule-context API
 * and throws `contextOrFilename.getFilename is not a function` on every file.
 */

/**
 * The database clients that bypass tenant isolation, and who may hold them.
 *
 * `no-restricted-imports` is core ESLint — no plugin, no dependency. It supports
 * `importNames`, which is what makes this precise: `withCompany` and the model
 * types come from the same specifier as the raw client, so banning the module
 * outright would be unusable and banning nothing is the status quo.
 *
 * Paired with apps/web/tests/no-raw-prisma.test.ts, which asserts the same
 * thing independently. Both, because they fail differently — a test survives an
 * eslint-disable comment, a config that drifts, and a CI job that skips lint.
 */
const RESTRICTED_DB_IMPORTS = {
  paths: [
    {
      name: "@whatsapp-os/db",
      importNames: ["prisma", "getPrismaClient"],
      message:
        "The unscoped client bypasses every RLS policy. Use " +
        "withCompany(session.companyId, (db, companyId) => ...). See CLAUDE.md.",
    },
    {
      name: "@whatsapp-os/db/client",
      message:
        "The unscoped client bypasses every RLS policy. Use withCompany. See CLAUDE.md.",
    },
    {
      name: "@whatsapp-os/db/admin",
      message:
        "The admin client reads across every company. Only lib/admin-db.ts may " +
        "import it, and it exposes named queries rather than the client.",
    },
  ],
};

const config = [
  {
    /* playwright-report and test-results hold Playwright's own bundled
       reporter and whatever a failed run captured. Both are gitignored, and
       linting a minified vendor bundle produces 186 errors about a variable
       called `be`. */
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...next,

  {
    files: [
      "app/**/*.{ts,tsx}",
      "components/**/*.{ts,tsx}",
      "lib/**/*.{ts,tsx}",
      "proxy.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", RESTRICTED_DB_IMPORTS],
    },
  },

  {
    /*
     * The single sanctioned holder of the cross-tenant client.
     *
     * Scoped to the literal file path rather than an `app/(admin)/**` glob:
     * flat-config patterns go through minimatch, where parentheses are a group
     * operator, and a guard that silently matches nothing is worse than none.
     */
    files: ["lib/admin-db.ts"],
    rules: { "no-restricted-imports": "off" },
  },

  {
    /*
     * login_attempts is a global table with no company_id — a failed sign-in
     * for a username that does not exist has no company to attribute it to. So
     * withCompany cannot scope it and the unscoped client is correct here. It
     * touches that one table, before any company context exists.
     */
    files: ["lib/auth/lockout.ts"],
    rules: { "no-restricted-imports": "off" },
  },
];

export default config;
