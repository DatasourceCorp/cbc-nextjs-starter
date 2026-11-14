// "Refresh from API": the reconciliation recipe from the guide (chapter 8).
// Run it from a button here; in production also run it nightly per church.

import type { CbcClient } from "./cbc-client.ts";
import type { Check } from "./types.ts";
import { upsertCheckFromApi } from "./checks-state.ts";
import { readStore, updateStore } from "./store.ts";

export async function refreshChecks(client: CbcClient, clientRef: string): Promise<{ fetched: number; applied: number }> {
  const { lastSync } = await readStore();
  const startedAt = new Date().toISOString(); // becomes the next updated_since

  // Fetch every page first (following nextCursor), then write once.
  const checks: Check[] = [];
  for await (const check of client.listAllChecks(clientRef, lastSync)) checks.push(check);

  const applied = await updateStore((data) => {
    let n = 0;
    for (const check of checks) if (upsertCheckFromApi(data, check) === "applied") n++; // upsert by id
    data.lastSync = startedAt;
    return n;
  });
  console.info(`[cbc] refresh: ${checks.length} checks fetched, ${applied} updated`);
  return { fetched: checks.length, applied };
}
