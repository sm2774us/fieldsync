import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useSession } from "@/store/session";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { NAV, allowed } from "./nav";
import { Input } from "@/components/ui/input";

interface Cmd { id: string; label: string; hint?: string; run: () => void }

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const role = useSession((s) => s.identity?.role);
  const nav = useNavigate();
  const [q, setQ] = React.useState("");
  const [i, setI] = React.useState(0);

  const cmds = React.useMemo<Cmd[]>(() => {
    const go = (to: string) => () => void nav({ to });
    const list: Cmd[] = NAV.filter((n) => allowed(role, n.perm)).map((n) => ({ id: n.to, label: `Go to ${n.label}`, run: go(n.to) }));
    return list;
  }, [role, nav]);

  const shown = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  const pick = (c?: Cmd) => { if (c) { onOpenChange(false); setQ(""); c.run(); } };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Command palette" description="Type to filter, arrows to move, Enter to run.">
        <Input autoFocus role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={shown[i] ? `cmd-${shown[i]!.id}` : undefined}
          placeholder="Type a command…" value={q} onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(x + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); pick(shown[i]); }
          }} />
        <ul id="palette-list" role="listbox" className="mt-2 max-h-72 overflow-auto">
          {shown.map((c, idx) => (
            <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={idx === i}
              className={`flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm ${idx === i ? "bg-muted" : ""}`}
              onMouseEnter={() => setI(idx)} onClick={() => pick(c)}>
              {c.label}{c.hint ? <span className="text-xs text-muted-foreground">{c.hint}</span> : null}
            </li>
          ))}
          {shown.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matching command</li> : null}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
