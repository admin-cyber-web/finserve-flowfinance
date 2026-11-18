import { api } from "@/convex/_generated/api";
import { StatusChip, toneFor } from "@/components/fs/primitives";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "convex/react";
import { useParams } from "react-router";

function statusTone(status: string) {
  return toneFor(status);
}

export default function SecurityDeviceAdmin() {
  const { id } = useParams<{ id: string }>();
  const device = useQuery(api.securityAdmin.superadminDeviceDetails, {
    deviceId: (id ?? "skip") as any,
    enrollmentId: "skip",
  });

  if (!device?.device) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Device Details</CardTitle>
          <CardDescription>Device record not found.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The requested device does not exist, or you do not have access.
          </p>
        </CardContent>
      </Card>
    );
  }

  const d = device.device;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Device Details</CardTitle>
        <CardDescription>Full device record for SUPER_ADMIN administration.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-2 text-sm">
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Staff ID</dt>
            <dd className="font-medium">{d.staffId}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Staff Name</dt>
            <dd className="font-medium">{d.staffName}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Role</dt>
            <dd className="font-medium">{d.role}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Device Label</dt>
            <dd className="font-medium">{d.label}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Platform</dt>
            <dd className="font-medium">{d.platform ?? "—"}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <StatusChip label={d.status} tone={statusTone(d.status)} />
            </dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Source</dt>
            <dd className="font-medium">{d.source ?? "—"}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Enrollment ID</dt>
            <dd className="font-mono text-xs">{d.enrollmentId ?? "—"}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Requested</dt>
            <dd className="text-xs">
              {d.requestedAt ? new Date(d.requestedAt).toLocaleString("en-IN") : "—"}
            </dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Last Seen</dt>
            <dd className="text-xs">
              {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString("en-IN") : "—"}
            </dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Decided By</dt>
            <dd className="text-xs">{d.decidedBy ?? "—"}</dd>
          </div>
          <div className="flex items-center justify-between border-b border-ink pb-1">
            <dt className="text-muted-foreground">Reason</dt>
            <dd className="text-xs">{d.reason ?? "—"}</dd>
          </div>
        </dl>

        <div className="mt-4 space-y-2">
          <p className="text-sm font-semibold">Event History</p>
          {device.history?.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {device.history.map((event) => (
                <div
                  key={event.ref}
                  className="flex items-start justify-between border border-ink/50 rounded-lg p-2"
                >
                  <div>
                    <p className="text-xs font-semibold">{event.kind}</p>
                    <p className="text-xs text-muted-foreground">{event.detail}</p>
                  </div>
                  <StatusChip label={event.kind} tone={statusTone(event.kind)} />
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
