import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...i: ClassValue[]) => twMerge(clsx(i));

export const fmtTime = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }) : "—";

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

export const shortHash = (h: string | null | undefined, n = 10): string =>
  !h ? "—" : h.length <= n * 2 + 1 ? h : `${h.slice(0, n)}…${h.slice(-6)}`;

export function relTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  const a = Math.abs(s);
  const t = a < 60 ? `${a}s` : a < 3600 ? `${Math.floor(a / 60)}m` : a < 86400 ? `${Math.floor(a / 3600)}h` : `${Math.floor(a / 86400)}d`;
  return s >= 0 ? `${t} ago` : `in ${t}`;
}

export function fmtCountdown(sec: number): string {
  if (sec <= 0) return "expired";
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(sec % 60).padStart(2, "0")}`;
}
