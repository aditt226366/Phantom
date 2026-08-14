export declare const TEST_DATABASE_NAME: string;

/** Owner role against the test database. Runs migrations and truncates. */
export declare function testDatabaseUrl(): string;

/** Runtime (non-owner) role against the test database. The client under test. */
export declare function testAppDatabaseUrl(): string;

/** A database we can always connect to in order to CREATE another one. */
export declare function maintenanceDatabaseUrl(): string;
