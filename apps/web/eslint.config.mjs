import next from "eslint-config-next/core-web-vitals";

/**
 * Flat config. Next 16 removed `next lint`, so ESLint runs directly:
 *   npm run lint --workspace=web
 *
 * Pinned to ESLint 9: eslint-plugin-react (a transitive dependency of
 * eslint-config-next) has not been updated for ESLint 10's rule-context API
 * and throws `contextOrFilename.getFilename is not a function` on every file.
 */
const config = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...next,
];

export default config;
