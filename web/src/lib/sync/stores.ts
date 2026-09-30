import type { Envelope, Store, StoredEvent } from "./types";

export class MemoryStore implements Store {
  private rows = new Map<number, StoredEvent>();
  private seq = 0;
  async nextSeq() { return ++this.seq; }
  async put(e: StoredEvent) { this.rows.set(e.seq, structuredClone(e)); }
  async all() { return [...this.rows.values()].sort((a, b) => a.seq - b.seq).map((e) => structuredClone(e)); }
  async patch(seq: number, p: Partial<Pick<StoredEvent, "state" | "attempts" | "error">>) {
    const r = this.rows.get(seq);
    if (r) this.rows.set(seq, { ...r, ...p });
  }
  async remove(seqs: number[]) { for (const s of seqs) this.rows.delete(s); }
}

export interface Cipher { encrypt(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>; decrypt(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> }

export const passthroughCipher: Cipher = { encrypt: async (d) => d, decrypt: async (d) => d };

/** AES-256-GCM with a per-record random IV; the device id is bound as additional authenticated data. */
export function aesCipher(key: CryptoKey, deviceId: string): Cipher {
  const aad = new TextEncoder().encode(deviceId);
  return {
    async encrypt(data) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, data));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv); out.set(ct, 12);
      return out;
    },
    async decrypt(data) {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12), additionalData: aad }, key, data.slice(12));
      return new Uint8Array(pt);
    },
  };
}

const req = <T,>(r: IDBRequest<T>) => new Promise<T>((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
const done = (t: IDBTransaction) => new Promise<void>((ok, bad) => { t.oncomplete = () => ok(); t.onerror = () => bad(t.error); t.onabort = () => bad(t.error); });

interface Row { seq: number; state: StoredEvent["state"]; attempts: number; error?: string; blob: Uint8Array<ArrayBuffer> }

/** Durable IndexedDB store. The immutable envelope is encrypted at rest; delivery state is not secret. */
export class IdbStore implements Store {
  private constructor(private db: IDBDatabase, private cipher: Cipher) {}

  static async open(name: string, cipher: Cipher): Promise<IdbStore> {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("events", { keyPath: "seq" });
      open.result.createObjectStore("meta");
      open.result.createObjectStore("keys");
    };
    return new IdbStore(await req(open), cipher);
  }

  /** Non-extractable AES key, generated once and kept in IndexedDB (never leaves the browser). */
  static async deviceKey(name: string): Promise<CryptoKey> {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore("events", { keyPath: "seq" }); open.result.createObjectStore("meta"); open.result.createObjectStore("keys"); };
    const db = await req(open);
    const existing = await req<CryptoKey | undefined>(db.transaction("keys").objectStore("keys").get("aes"));
    if (existing) { db.close(); return existing; }
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const t = db.transaction("keys", "readwrite");
    t.objectStore("keys").put(key, "aes");
    await done(t);
    db.close();
    return key;
  }

  async nextSeq(): Promise<number> {
    const t = this.db.transaction("meta", "readwrite");
    const s = t.objectStore("meta");
    const n = ((await req<number | undefined>(s.get("seq"))) ?? 0) + 1;
    s.put(n, "seq");
    await done(t);
    return n;
  }

  async put(e: StoredEvent) {
    const blob = await this.cipher.encrypt(new TextEncoder().encode(JSON.stringify(e.env)) as Uint8Array<ArrayBuffer>);
    const t = this.db.transaction("events", "readwrite");
    t.objectStore("events").put({ seq: e.seq, state: e.state, attempts: e.attempts, error: e.error, blob } satisfies Row);
    await done(t);
  }

  async all(): Promise<StoredEvent[]> {
    const rows = await req<Row[]>(this.db.transaction("events").objectStore("events").getAll());
    return Promise.all(rows.map(async (r) => ({
      seq: r.seq, state: r.state, attempts: r.attempts, error: r.error,
      env: JSON.parse(new TextDecoder().decode(await this.cipher.decrypt(r.blob))) as Envelope,
    })));
  }

  async patch(seq: number, p: Partial<Pick<StoredEvent, "state" | "attempts" | "error">>) {
    const t = this.db.transaction("events", "readwrite");
    const s = t.objectStore("events");
    const row = await req<Row | undefined>(s.get(seq));
    if (row) s.put({ ...row, ...p });
    await done(t);
  }

  async remove(seqs: number[]) {
    const t = this.db.transaction("events", "readwrite");
    for (const s of seqs) t.objectStore("events").delete(s);
    await done(t);
  }
}
