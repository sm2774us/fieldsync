import { IdbStore, MemoryStore, aesCipher } from "./stores";
import type { Store } from "./types";

export type StoreFactory = (deviceId: string) => Promise<{ store: Store; durable: boolean }>;

/** Encrypted IndexedDB when available, otherwise memory (and the UI says so). */
export const defaultStore: StoreFactory = async (deviceId) => {
  if (typeof indexedDB === "undefined") return { store: new MemoryStore(), durable: false };
  const name = `fieldsync-${deviceId}`;
  const key = await IdbStore.deviceKey(name);
  return { store: await IdbStore.open(name, aesCipher(key, deviceId)), durable: true };
};

