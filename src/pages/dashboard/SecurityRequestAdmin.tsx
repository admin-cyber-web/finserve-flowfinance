import { api } from "@/convex/_generated/api";
import { StatusChip, toneFor } from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useMutation, useQuery } from "convex/react";
import { useParams } from "react-router";
import { Check, X } from "lucide-react";

function statusTone(status: string) {
  return toneFor(status);
}

export default function SecurityRequestAdmin() {
  const { enrollmentId } = useParams<{ enrollmentId: string }>();
  const device = useQuery(api.securityAdmin.superadminDeviceDetails, {
    deviceId: "skip" as any,
    enrollmentId: enrollmentId ?? "skip",
  });

  const approveDevice = useMutation(api.securityAdmin.superadminApproveDevice);
  const rejectDevice = useMutation(api.securityAdmin.superadminRejectDevice);

  if (!device?.device) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Registration Request</CardTitle>
          <CardDescription>Device record not found.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No device matches that enrollment id, or it has already been decided.</p>
        </CardContent>
      </Card>
    );
  }

  const d = device.device;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Registration Request</CardTitle>
        <CardDescription>
          Device enrollment request from /security/register/&lt;token&gt;.
        </CardDescription>
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

        {d.status === "PENDING" && (
          <div className="mt-4 flex gap-2">
            <Button
              size="sm"
              onClick={async () => {
                const ok = await approveDevice({
                  deviceId: d._id,
                  reason: "Approved by SUPER_ADMIN",
                });
                if (ok.ok) {
                  window.location.reload();
                }
              }}
            >
              <Check className="size-3" /> Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const ok = await rejectDevice({
                  deviceId: d._id,
                  reason: "Rejected by SUPER_ADMIN",
                });
                if (ok.ok) {
                  window.location.reload();
                }
              }}
            >
              <X className="size-3" /> Reject
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
