/**
 * Stand-in for the `server-only` package.
 *
 * That package is a build-time guard: it exists so that importing a
 * server-only module from a Client Component fails the bundle. Outside the
 * "react-server" resolution condition its main entry throws on import, which
 * would take down every test of a module that uses it. Vitest is not a client
 * bundle, so the guard has nothing to protect here.
 */
export {};
