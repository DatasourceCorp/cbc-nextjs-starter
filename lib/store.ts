// ============================================================================
//  LOCAL JSON FILE STORE: REPLACE WITH YOUR DATABASE.
//
//  This keeps the starter dependency-free. It is fine for one process on a
//  laptop, not for production: no indexes, one process only, and the whole
//  file is rewritten on every change. Move each StoreData field to a table:
//    church        -> your churches table (clientId, externalClientId)
//    checks        -> a checks table keyed by check id (chk_...)
//    seenEvents    -> a processed_webhook_events table with a unique eventId
//    lastSync      -> a column on the church row
//  It holds applicant names and emails: protect it like any personal data.
// ============================================================================

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyStore, type StoreData } from "./checks-state.ts";

function storePath() {
  // turbopackIgnore: a runtime data file, not something to bundle or trace.
  return path.resolve(/*turbopackIgnore: true*/ process.env.CBC_STORE_PATH || path.join(process.cwd(), ".data", "cbc-store.json"));
}

// One lock per process, shared by every module instance (Next can load a module
// more than once, e.g. for route handlers and server actions).
const globalForLock = globalThis as unknown as { __cbcStoreLock?: Promise<unknown> };

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalForLock.__cbcStoreLock ?? Promise.resolve();
  const run = previous.then(fn, fn);
  globalForLock.__cbcStoreLock = run.catch(() => undefined);
  return run;
}

async function load(): Promise<StoreData> {
  try {
    const text = await readFile(storePath(), "utf8");
    return { ...emptyStore(), ...(JSON.parse(text) as Partial<StoreData>) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw err;
  }
}

async function save(data: StoreData): Promise<void> {
  const file = storePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file); // atomic replace: readers never see half a file
}

/** Reads the whole store. */
export function readStore(): Promise<StoreData> {
  return withLock(load);
}

/** Read-modify-write under the lock. Nothing is saved if `fn` throws. */
export function updateStore<T>(fn: (data: StoreData) => T | Promise<T>): Promise<T> {
  return withLock(async () => {
    const data = await load();
    const result = await fn(data);
    await save(data);
    return result;
  });
}
