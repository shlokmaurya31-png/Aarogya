/**
 * Flagship 4c — the ward device's local store (docs/OFFLINE_NURSING_DESIGN.md
 * §3, §8, §13.4). Browser only.
 *
 * IndexedDB holds the pack and the outbox, each record encrypted with
 * AES-GCM under a key made on this tablet, non-extractable (the browser keeps
 * it; no code can read it out), stored beside them. "Hand back the tablet"
 * deletes the database: pack, outbox and key. Nothing is kept in the service
 * worker's cache except the app itself.
 */

const DB = "aarogya-ward";
const VERSION = 1;

export interface OutboxCommand {
  clientOperationId: string;
  kind: string;
  deviceTime: string;
  /** What the screen shows while it waits (no ids). */
  label: string;
  [k: string]: unknown;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try { return await req(fn(db.transaction("kv", mode).objectStore("kv"))); } finally { db.close(); }
}

/** The tablet's key: made once, non-extractable, kept in IndexedDB as a CryptoKey. */
async function key(): Promise<CryptoKey> {
  const have = await kv<CryptoKey | undefined>("readonly", (s) => s.get("key") as IDBRequest<CryptoKey | undefined>);
  if (have) return have;
  const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await kv("readwrite", (s) => s.put(k, "key"));
  return k;
}

async function seal(value: unknown): Promise<{ iv: Uint8Array; data: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(JSON.stringify(value)));
  return { iv, data };
}

async function unseal<T>(box: { iv: Uint8Array; data: ArrayBuffer } | undefined): Promise<T | null> {
  if (!box) return null;
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: box.iv as BufferSource }, await key(), box.data);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export async function getDeviceId(): Promise<string | null> {
  return (await kv<string | undefined>("readonly", (s) => s.get("deviceId") as IDBRequest<string | undefined>)) ?? null;
}
export async function setDeviceId(id: string) {
  await kv("readwrite", (s) => s.put(id, "deviceId"));
}

export async function savePack(pack: unknown) {
  const box = await seal(pack);
  await kv("readwrite", (s) => s.put(box, "pack"));
}
export async function loadPack<T>(): Promise<T | null> {
  return unseal<T>(await kv<{ iv: Uint8Array; data: ArrayBuffer } | undefined>("readonly", (s) => s.get("pack") as IDBRequest<{ iv: Uint8Array; data: ArrayBuffer } | undefined>));
}

export async function queue(cmd: OutboxCommand) {
  const box = await seal(cmd);
  const db = await open();
  try { await req(db.transaction("outbox", "readwrite").objectStore("outbox").add({ box })); } finally { db.close(); }
}

/** The outbox in the order recorded. */
export async function outbox(): Promise<{ seq: number; cmd: OutboxCommand }[]> {
  const db = await open();
  let rows: { seq: number; box: { iv: Uint8Array; data: ArrayBuffer } }[];
  try { rows = await req(db.transaction("outbox", "readonly").objectStore("outbox").getAll()); } finally { db.close(); }
  const out: { seq: number; cmd: OutboxCommand }[] = [];
  for (const r of rows) { const cmd = await unseal<OutboxCommand>(r.box); if (cmd) out.push({ seq: r.seq, cmd }); }
  return out.sort((a, b) => a.seq - b.seq);
}

export async function dropFromOutbox(seqs: number[]) {
  const db = await open();
  try {
    const t = db.transaction("outbox", "readwrite");
    for (const s of seqs) t.objectStore("outbox").delete(s);
    await new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); });
  } finally { db.close(); }
}

/** Hand back the tablet: the pack, the outbox and the key, gone (and the app's cache). */
export async function wipe() {
  await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  if (typeof caches !== "undefined") for (const k of await caches.keys()) if (k.startsWith("aarogya-ward")) await caches.delete(k);
}
