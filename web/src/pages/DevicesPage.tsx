import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useSession } from "@/store/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmButton, ErrorState, Field, PageHeader } from "@/components/ui/misc";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function DevicesPage() {
  const agency = useSession((s) => s.identity!.agency);
  const [f, setF] = React.useState({ device_id: "", label: "" });
  const [target, setTarget] = React.useState("");
  const reg = useMutation({ mutationFn: () => api.registerDevice({ ...f, agency_id: agency }), onSuccess: (r) => toast.success(`${r.device_id} registered (pending). A second administrator must activate it.`), onError: (e) => toast.error(e.message) });
  const act = useMutation({ mutationFn: () => api.activateDevice(target.trim()), onSuccess: (r) => toast.success(`${r.device_id} is now active`), onError: (e) => toast.error(e.message) });
  const rev = useMutation({ mutationFn: () => api.revokeDevice(target.trim(), "Revoked via console"), onSuccess: (r) => toast.success(`${r.device_id} revoked`), onError: (e) => toast.error(e.message) });
  const valid = ID.test(f.device_id) && f.label.trim().length > 0;
  return (
    <>
      <PageHeader title="Device enrolment" subtitle="Only active devices may write. Registration and activation need two different administrators. Administrators cannot read events or records." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>1 · Register</CardTitle><Badge>step 1 of 2</Badge></CardHeader><CardContent>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); reg.mutate(); }}>
            <Field label="Device ID (also the device's token subject)" htmlFor="did"><Input id="did" value={f.device_id} onChange={(e) => setF({ ...f, device_id: e.target.value })} placeholder="unit-0417" /></Field>
            <Field label="Label" htmlFor="lbl"><Input id="lbl" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Patrol unit 417" /></Field>
            <Button type="submit" loading={reg.isPending} disabled={!valid}>Register (pending)</Button>
            {reg.isError ? <ErrorState error={reg.error} /> : null}
          </form></CardContent></Card>
        <Card><CardHeader><CardTitle>2 · Activate or revoke</CardTitle><Badge>step 2 of 2</Badge></CardHeader><CardContent className="space-y-3">
          <Field label="Device ID" htmlFor="tid"><Input id="tid" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="unit-0417" /></Field>
          <div className="flex gap-2">
            <ConfirmButton size="md" variant="primary" label="Activate" confirmLabel="Confirm activate" disabled={!ID.test(target.trim())} loading={act.isPending} onConfirm={() => act.mutate()} />
            <ConfirmButton size="md" variant="danger" label="Revoke" confirmLabel="Confirm revoke" disabled={!ID.test(target.trim())} loading={rev.isPending} onConfirm={() => rev.mutate()} /></div>
          {act.isError ? <ErrorState error={act.error} /> : null}{rev.isError ? <ErrorState error={rev.error} /> : null}
          <p className="text-xs text-muted-foreground">You cannot activate a device you registered. Revocation blocks all future writes from that device.</p>
        </CardContent></Card>
      </div>
    </>
  );
}
