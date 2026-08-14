export declare const TEST_DATABASE_NAME: string;

/** Owner role against the test database. Runs migrations and truncates. */
export declare function testDatabaseUrl(): string;

/** Runtime (non-owner) role against the test database. The client under test. */
export declare function testAppDatabaseUrl(): string;

/** A database we can always connect to in order to CREATE another one. */
export declare function maintenanceDatabaseUrl(): string;

/** The cluster superuser. Used by db-roles.mjs and nothing else. */
export declare function superuserDatabaseUrl(): string;

/** Platform-admin role against the test database. */
export declare function testAdminDatabaseUrl(): string;

/** Superuser against the test database. Test scaffolding only. */
export declare function testSuperuserDatabaseUrl(): string;

/** Throw if any DATABASE_URL* the app reads points outside the test database. */
export declare function assertTestDatabaseOnly(): void;

/** Databases db-roles.mjs should fix up ownership in, when they exist. */
export declare function managedDatabaseNames(): string[];
