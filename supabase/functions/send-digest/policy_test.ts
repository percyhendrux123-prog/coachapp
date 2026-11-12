import { filterOwnerDigestRows, requireOwnerTenant } from "./policy.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const assertThrows = (fn: () => unknown, message: string) => {
  try { fn(); } catch (error) {
    if ((error as Error).message.includes(message)) return;
    throw error;
  }
  throw new Error(`Expected error containing: ${message}`);
};

Deno.test("digest fixture excludes rows from an outside tenant", () => {
  const rows = [
    { tenant_id: "owner-id", template: "message" },
    { tenant_id: "outside-id", template: "checkin_due" },
  ];
  assertEquals(filterOwnerDigestRows(rows, { id: "owner-id", slug: "owner" }), [rows[0]]);
});

Deno.test("digest fails closed when owner lookup is absent or wrong", () => {
  assertThrows(() => requireOwnerTenant(null), "Owner tenant not found");
  assertThrows(() => requireOwnerTenant({ id: "outside-id", slug: "outside-coach" }), "Owner tenant not found");
});
