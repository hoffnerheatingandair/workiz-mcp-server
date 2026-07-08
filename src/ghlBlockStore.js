// Persists Workiz job UUID -> { ghlUserId: ghlBlockEventId } mappings to a
// small JSON file, so reschedules can update the right GHL block slot(s) and
// cancels can delete them instead of creating duplicates.
//
// This is a flat file, not a database -- fine for one location's job volume,
// but note Render's disk is ephemeral across deploys/restarts unless you
// attach a persistent disk at GHL_BLOCK_STORE_PATH. Reads/writes are
// serialized through an in-process queue so concurrent webhook requests
// can't race and clobber each other -- that only holds for a single server
// instance/process, not multiple replicas.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const STORE_PATH = process.env.GHL_BLOCK_STORE_PATH || path.join(process.cwd(), "data", "ghl-block-map.json");

let queue = Promise.resolve();

function enqueue(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

async function readStore() {
  try {
    const text = await readFile(STORE_PATH, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeStore(data) {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(data, null, 2));
}

// Returns { ghlUserId: ghlBlockEventId, ... } for a Workiz job UUID, or {}.
export function getBlocksForJob(workizUuid) {
  return enqueue(async () => {
    const data = await readStore();
    return data[workizUuid] || {};
  });
}

export function setBlocksForJob(workizUuid, blocks) {
  return enqueue(async () => {
    const data = await readStore();
    data[workizUuid] = blocks;
    await writeStore(data);
  });
}

export function deleteBlocksForJob(workizUuid) {
  return enqueue(async () => {
    const data = await readStore();
    delete data[workizUuid];
    await writeStore(data);
  });
}
