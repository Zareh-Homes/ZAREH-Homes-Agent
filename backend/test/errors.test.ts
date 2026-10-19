import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDatabaseError } from "../src/errors.ts";

test("database rule violations become clear 4xx errors, even when Prisma only puts the Postgres error in the message text", () => {
  const err = new Error('Invalid `prisma.transaction.create()` invocation:\n\nError occurred during query execution:\nConnectorError(ConnectorError { ' +
    'user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"Transaction\\" violates ' +
    'check constraint \\"txn_coop_commission\\"", severity: "ERROR", detail: None }) })');
  const mapped = fromDatabaseError(err);
  assert.equal(mapped?.code, "CONSTRAINT_VIOLATION");
  assert.equal(mapped?.status, 422);
  assert.equal(mapped?.message, 'new row for relation "Transaction" violates check constraint "txn_coop_commission"');
  // Anything unrecognised is left for the caller (a 500, logged)
  assert.equal(fromDatabaseError(new Error("connection reset")), null);
});
