export function makeToken(over: Partial<{ sub: string; role: string; agency: string; exp: number }> = {}): string {
  const p = { sub: "aud-1", role: "auditor", agency: "agency-1", exp: Math.floor(Date.now() / 1000) + 900, jti: "j1", ...over };
  const b64 = btoa(JSON.stringify(p)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64}.sig`;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
