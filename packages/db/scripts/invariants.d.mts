import type { Client } from "pg";

export declare const COLUMN_GRANTS: Set<string>;
export declare const RESOLVER_TABLE_GRANTS: Set<string>;
export declare const OUT_OF_BAND_DDL: Set<string>;
export declare const NAIVE_COLUMNS_ALLOWED: Set<string>;

/** Each returns a list of findings. Empty means the invariant holds. */
export declare function checkColumnGrants(client: Client): Promise<string[]>;
export declare function checkResolverTableGrants(client: Client): Promise<string[]>;
export declare function checkOutOfBandDdl(client: Client): Promise<string[]>;
export declare function checkTimestampColumns(client: Client): Promise<string[]>;

export declare const INVARIANTS: ReadonlyArray<{
  name: string;
  run: (client: Client) => Promise<string[]>;
}>;

export declare function runInvariants(
  connectionString: string,
): Promise<Array<{ name: string; findings: string[] }>>;
