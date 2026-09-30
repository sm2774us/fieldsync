import { canonicalJson } from "./canonical";

const hex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export const fromHex = (h: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export async function sha256Hex(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", data));
}

export type SigResult = "valid" | "invalid" | "unsupported";

/** Verify an Ed25519 signature with WebCrypto. "unsupported" when the browser lacks Ed25519. */
export async function verifyEd25519(publicHex: string, sigHex: string, message: Uint8Array<ArrayBuffer>): Promise<SigResult> {
  try {
    const key = await crypto.subtle.importKey("raw", fromHex(publicHex), { name: "Ed25519" }, false, ["verify"]);
    return (await crypto.subtle.verify({ name: "Ed25519" }, key, fromHex(sigHex), message)) ? "valid" : "invalid";
  } catch (e) {
    if (e instanceof DOMException && (e.name === "NotSupportedError" || e.name === "SyntaxError")) return "unsupported";
    return "invalid";
  }
}

export const verifySignedObject = (publicHex: string, sigHex: string, obj: unknown): Promise<SigResult> =>
  verifyEd25519(publicHex, sigHex, new TextEncoder().encode(canonicalJson(obj)) as Uint8Array<ArrayBuffer>);
