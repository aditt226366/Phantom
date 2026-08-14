import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Unmount between tests.
 *
 * Testing Library renders into a container appended to document.body and does
 * not remove it on its own. Without this, queries in a later test can match an
 * element left behind by an earlier one, and the failures look like flakes.
 */
afterEach(() => {
  cleanup();
});
