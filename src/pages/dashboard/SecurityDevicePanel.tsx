/** SUPER_ADMIN — Security & Device Management panel (KMC dashboard).

 * Real backend-backed device registry, registration-link generation and device
 * administration.  Every mutation authenticates the signed-in SUPER_ADMIN
 * through `securityAdmin.ts`; the independent Security Department portal keeps
 * its own operator sessions and authority (`/security`).
 */

import { api } from "@/convex/_generated/api";
import { PageHeader, RowSkeleton, StatCard, StatusChip, toneFor } from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useProfile } from "@/hooks/use-profile";
import { useMutation, useQuery } from "convex/react";
import { cn } from "@/lib/utils";
import {
  ShieldCheck,
  ShieldAlert,
  Link2,
  Copy,
  Check,
  ExternalLink,
  Trash2,
  Eye,
  Ban,
  RotateCcw,
  ArrowRight,
  Loader2,
  Smartphone,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

type SecurityTab = "dashboard" | "requests" | "links" | "devices" | "device";

const FILTER_ALL = ["ALL", "PENDING", "AUTHORIZED", "BLOCKED", "REVOKED"] as const;
type DeviceFilter = (typeof FILTER_ALL)[number];

const LINK_STATUS_ALL = ["ALL", "UNUSED", "USED", "EXPIRED", "REVOKED"] as const;
type LinkFilter = (typeof LINK_STATUS_ALL)[number];

function fmtAgo(ts: number) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtDateTime(ts: number) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(status: string) {
  return toneFor(status);
}

export default function SecurityDevicePanel() {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const [activeTab, setActiveTab] = useState<SecurityTab>("dashboard");

  const stats = useQuery(api.securityAdmin.superadminDevices, { status: "ALL" });

  const total = stats?.length ?? 0;
  const pending = stats?.filter((d) => d.status === "PENDING").length ?? 0;
  const authorized = stats?.filter((d) => d.status === "AUTHORIZED").length ?? 0;
  const blocked = stats?.filter((d) => d.status === "BLOCKED").length ?? 0;
  const revoked = stats?.filter((d) => d.status === "REVOKED" || d.status === "REPLACED").length ?? 0;
  const today = stats?.filter((d) => Boolean(d.requestedAt) && Math.floor((Date.now() - d.requestedAt) / 86400000) < 1).length ?? 0;
  const recentlyActive = stats?.filter((d) => Boolean(d.lastSeenAt) && Math.floor((Date.now() - d.lastSeenAt) / 3600000) < 24).length ?? 0;

  const [linkFilter, setLinkFilter] = useState<LinkFilter>("ALL");
  const links = useQuery(api.securityAdmin.listRegistrationLinks, {
    status: linkFilter === "ALL" ? undefined : linkFilter,
    limit: 50,
  });

  const [deviceFilter, setDeviceFilter] = useState<DeviceFilter>("PENDING");
  const devices = useQuery(api.securityAdmin.superadminDevices, {
    status: deviceFilter === "ALL" ? undefined : deviceFilter,
  });

  const [requestFilter, setRequestFilter] = useState<"ALL" | "PENDING">("PENDING");
  const requests = useQuery(api.securityAdmin.listRegistrationRequests, {
    status: requestFilter === "ALL" ? undefined : requestFilter,
    limit: 200,
  });

  const generateLink = useMutation(api.securityAdmin.generateRegistrationLink);
  const revokeLink = useMutation(api.securityAdmin.revokeRegistrationLink);
  const approveDevice = useMutation(api.securityAdmin.superadminApproveDevice);
  const rejectDevice = useMutation(api.securityAdmin.superadminRejectDevice);
  const blockDevice = useMutation(api.securityAdmin.superadminBlockDevice);
  const revokeDevice = useMutation(api.securityAdmin.superadminRevokeDevice);
  const reactivateDevice = useMutation(api.securityAdmin.superadminReactivateDevice);
  const deviceDetails = useQuery(api.securityAdmin.superadminDeviceDetails, { deviceId: ("skip" as unknown as any), enrollmentId: "skip" });

  const [generating, setGenerating] = useState(false);
  const [genForm, setGenForm] = useState({
    staffId: "",
    deviceLabel: "",
    deviceType: "Web",
    immediateApproval: false,
    expiresInHours: 168,
  });
  const [genResult, setGenResult] = useState<{
    link: string;
    token: string;
    staffId: string;
    staffName: string;
    deviceLabel: string;
    deviceType: string;
    immediateApproval: boolean;
    expiresAt: number;
  } | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleGenerateLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!genForm.staffId.trim()) {
      setGenError("Enter a Staff ID.");
      return;
    }
    setGenerating(true);
    setGenError(null);
    try {
      const result = await generateLink({
        staffId: genForm.staffId,
        deviceLabel: genForm.deviceLabel,
        deviceType: genForm.deviceType,
        immediateApproval: genForm.immediateApproval,
        expiresInHours: genForm.expiresInHours,
      });
      setGenResult({
        link: result.link,
        token: result.token,
        staffId: result.staffId,
        staffName: result.staffName,
        deviceLabel: result.deviceLabel,
        deviceType: result.deviceType,
        immediateApproval: result.immediateApproval,
        expiresAt: result.expiresAt,
      });
      setGenForm({ staffId: "", deviceLabel: "", deviceType: "Web", immediateApproval: false, expiresInHours: 168 });
      setGenForm((prev) => ({ ...prev, staffId: "", deviceLabel: "" }));
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Failed to generate registration link.");
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyLink = async () => {
    if (!genResult) return;
    try {
      await navigator.clipboard.writeText(genResult.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  };

  const handleRevokeLink = async (token: string, e: React.FormEvent) => {
    e.preventDefault();
    const result = await revokeLink({ token, reason: "Revoked by SUPER_ADMIN" });
    if (result.ok) {
      setGenResult(null);
    }
  };

  const handleCopyWhatsApp = () => {
    if (!genResult) return;
    const text = `Hi, please register your KMC device using this link: ${genResult.link}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  };

  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="Security & Device Management"
        subtitle="SUPER_ADMIN device authority · backend-backed device registry and registration links"
      />

      {/* Tab navigation */}
      <div className="flex gap-2 border-b border-ink">
        {[
          { key: "dashboard", label: "Device Dashboard" },
          { key: "requests", label: "Registration Requests" },
          { key: "links", label: "Registration Links" },
          { key: "devices", label: "Device Registry" },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key as SecurityTab)}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-black uppercase tracking-wide transition",
              activeTab === t.key
                ? "border-gold text-ink"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ---- Device Dashboard ---- */}
      {activeTab === "dashboard"
        ? (
            <section className="mt-6">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatCard label="Total Registered Devices" value={String(total)} sub="All devices" tone="info" />
                <StatCard label="Pending Devices" value={String(pending)} sub="Awaiting approval" tone={pending > 0 ? "warn" : "idle"} />
                <StatCard label="Approved Devices" value={String(authorized)} sub="Active" tone="ok" />
                <StatCard label="Blocked Devices" value={String(blocked)} sub="Session invalidated" tone={blocked > 0 ? "bad" : "idle"} />
                <StatCard label="Revoked Devices" value={String(revoked)} sub="Revoked / replaced" tone="bad" />
                <StatCard label="Devices Registered Today" value={String(today)} sub="Last 24 hours" tone="info" />
                <StatCard label="Recently Active Devices" value={String(recentlyActive)} sub="Last 24 hours" tone="ok" />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Status Summary</CardTitle>
                  <CardDescription>
                    Live counts from the device registry and the pending registration request queue. Counts update as devices are approved, blocked, revoked, reactivated or enrolled.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div className="flex items-center justify-between border-b border-ink pb-1">
                      <dt className="text-muted-foreground">Registration Requests</dt>
                      <dd className="font-bold">{requests?.length ?? 0}</dd>
                    </div>
                    <div className="flex items-center justify-between border-b border-ink pb-1">
                      <dt className="text-muted-foreground">Total</dt>
                      <dd className="font-bold">{total}</dd>
                    </div>
                    <div className="flex items-center justify-between border-b border-ink pb-1">
                      <dt className="text-muted-foreground">Pending Approval</dt>
                      <dd className="font-bold">{pending}</dd>
                    </div>
                    <div className="flex items-center justify-between border-b border-ink pb-1">
                      <dt className="text-muted-foreground">Authorized</dt>
                      <dd className="font-bold">{authorized}</dd>
                    </div>
                    <div className="flex items-center justify-between border-b border-ink pb-1">
                      <dt className="text-muted-foreground">Blocked</dt>
                      <dd className="font-bold">{blocked}</dd>
                    </div>
                    <div className="flex items-center justify-between border-b border-ink pb-1">
                      <dt className="text-muted-foreground">Revoked / Replaced</dt>
                      <dd className="font-bold">{revoked}</dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt className="text-muted-foreground">Registered Today</dt>
                      <dd className="font-bold">{today}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShieldAlert className="size-4 text-amber-500" />
                    Authorization Reminder
                  </CardTitle>
                  <CardDescription>
                    SUPER_ADMIN has full device-management authority. Security Operators retain their independent Security Department authority. Ordinary staff cannot manage device authorization.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="list-disc pl-5 text-sm text-muted-foreground">
                    <li>Generate device registration links for staff</li>
                    <li>Approve, reject, block, revoke and reactivate devices</li>
                    <li>View device registry and audit history</li>
                    <li>Security Operators can independently approve devices from the Security Command Center</li>
                  </ul>
                </CardContent>
              </Card>
            </section>
          )
        : null
      }

      {/* ---- Registration Requests ---- */}
      {activeTab === "requests"
        ? (
            <section className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Pending Registration Requests</CardTitle>
                  <CardDescription>
                    Device enrollment requests that have not yet been approved or rejected. Each request here corresponds to one cryptographic enrollment through /security/register/&lt;token&gt;.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-2 mb-3">
                    <button
                      onClick={() => setRequestFilter("PENDING")}
                      className={cn(
                        "border px-2 py-1 text-xs font-black uppercase tracking-wider transition",
                        requestFilter === "PENDING"
                          ? "border-gold bg-gold/10 text-ink"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Pending
                    </button>
                    <button
                      onClick={() => setRequestFilter("ALL")}
                      className={cn(
                        "border px-2 py-1 text-xs font-black uppercase tracking-wider transition",
                        requestFilter === "ALL"
                          ? "border-gold bg-gold/10 text-ink"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      All
                    </button>
                  </div>
                  {requests === undefined ? (
                    <RowSkeleton rows={5} />
                  ) : requests.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No pending registration requests.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-ink">
                            <th className="text-left py-2 font-semibold">#</th>
                            <th className="text-left py-2 font-semibold">Staff</th>
                            <th className="text-left py-2 font-semibold">Device</th>
                            <th className="text-left py-2 font-semibold">Source</th>
                            <th className="text-left py-2 font-semibold">Requested</th>
                            <th className="text-left py-2 font-semibold">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {requests.map((req) => (
                            <tr key={req._id} className="border-b border-ink/50 hover:bg-muted/30">
                              <td className="py-2">
                                <p className="font-mono text-xs">{req.idx}</p>
                              </td>
                              <td className="py-2">
                                <p className="font-medium">{req.staffName}</p>
                                <p className="text-xs text-muted-foreground">{req.staffId} · {req.role}</p>
                              </td>
                              <td className="py-2">
                                <p className="flex items-center gap-1">
                                  <Smartphone className="size-3" />
                                  {req.label}
                                </p>
                                {req.browser && (
                                  <p className="text-xs text-muted-foreground">
                                    {req.browser} {req.browserVersion} · {req.os}
                                  </p>
                                )}
                              </td>
                              <td className="py-2">
                                <StatusChip label={req.source} tone={statusTone(req.source)} />
                              </td>
                              <td className="py-2 text-xs text-muted-foreground">
                                {req.requestedAt ? fmtDateTime(req.requestedAt) : "—"}
                              </td>
                              <td className="py-2">
                                <div className="flex gap-1">
                                  <Button variant="outline" size="sm" onClick={() => navigate(`/dashboard/security/request/${req.enrollmentId}`)}>
                                    <Eye className="size-3" /> View
                                  </Button>
                                  <Button
                                    size="sm"
                                    onClick={async () => {
                                      const ok = await approveDevice({ deviceId: req._id, reason: "Approved by SUPER_ADMIN" });
                                      if (ok.ok) window.location.reload();
                                    }}
                                  >
                                    <Check className="size-3" /> Approve
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={async () => {
                                      const ok = await rejectDevice({ deviceId: req._id, reason: "Rejected by SUPER_ADMIN" });
                                      if (ok.ok) window.location.reload();
                                    }}
                                  >
                                    Reject
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
          )
        : null
      }

      {/* ---- Registration Links ---- */}
      {activeTab === "links"
        ? (
            <section className="mt-6">
              {/* Link generator */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Link2 className="size-4" />
                    Generate Device Registration Link
                  </CardTitle>
                  <CardDescription>
                    Create a single-use, time-limited registration link for a staff member. Example: https://kmcfinance.in/security/register/{`<token>`}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {genResult ? (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-ink bg-sky/20 p-4">
                        <p className="text-sm font-semibold">Link generated for {genResult.staffName} ({genResult.staffId})</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {genResult.deviceLabel} · {genResult.deviceType}
                          {genResult.immediateApproval ? " · Immediate approval" : ""}
                        </p>
                        <div className="relative mt-2">
                          <Input value={genResult.link} readOnly className="font-mono text-xs break-all" />
                          <Button size="sm" variant="outline" className="absolute right-1 top-1" onClick={handleCopyLink}>
                            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">Expires: {fmtDateTime(genResult.expiresAt)}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={handleCopyWhatsApp}>
                          <ExternalLink className="size-3" /> Share on WhatsApp
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setGenResult(null)}>
                          Generate Another
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleGenerateLink} className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="staffId">Staff ID</Label>
                          <Input
                            id="staffId"
                            value={genForm.staffId}
                            onChange={(e) => setGenForm({ ...genForm, staffId: e.target.value })}
                            placeholder="e.g. 0002"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="deviceType">Device Type</Label>
                          <Select value={genForm.deviceType} onValueChange={(v) => setGenForm({ ...genForm, deviceType: v })}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="Web">Web Browser</SelectItem>
                              <SelectItem value="Mobile">Mobile</SelectItem>
                              <SelectItem value="Desktop">Desktop</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="deviceLabel">Device Label</Label>
                        <Input
                          id="deviceLabel"
                          value={genForm.deviceLabel}
                          onChange={(e) => setGenForm({ ...genForm, deviceLabel: e.target.value })}
                          placeholder="e.g. Pankaj's laptop"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" id="immediateApproval" checked={genForm.immediateApproval} onChange={(e) => setGenForm({ ...genForm, immediateApproval: e.target.checked })} />
                        <Label htmlFor="immediateApproval">Approve immediately (skip pending queue)</Label>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="expiresInHours">Expiry (hours)</Label>
                        <Input id="expiresInHours" type="number" min={1} max={720} value={genForm.expiresInHours} onChange={(e) => setGenForm({ ...genForm, expiresInHours: Number(e.target.value) })} />
                      </div>
                      {genError && <p className="text-sm text-destructive">{genError}</p>}
                      <Button type="submit" disabled={generating || !genForm.staffId.trim()}>
                        {generating ? (
                          <>
                            <Loader2 className="size-3 animate-spin" /> Generating...
                          </>
                        ) : (
                          <>
                            <Link2 className="size-3" /> Generate Link
                          </>
                        )}
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>

              {/* Link list */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Registration Links</CardTitle>
                  <CardDescription>Single-use links. Used links cannot be reused. Expired and revoked links are marked accordingly.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-2 mb-3">
                    {LINK_STATUS_ALL.map((f) => (
                      <button
                        key={f}
                        onClick={() => setLinkFilter(f)}
                        className={cn(
                          "border px-2 py-1 text-xs font-black uppercase tracking-wider transition",
                          linkFilter === f ? "border-gold bg-gold/10 text-ink" : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  {links === undefined ? (
                    <RowSkeleton rows={3} />
                  ) : links.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No registration links found.</p>
                  ) : (
                    <div className="space-y-2">
                      {links.map((link) => (
                        <div key={link._id} className="flex items-center justify-between border border-ink rounded-lg p-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold">{link.staffName} ({link.staffId})</p>
                            <p className="text-xs text-muted-foreground">
                              {link.deviceLabel || "No label"} · {link.deviceType}
                              {link.immediateApproval ? " · Immediate approval" : ""}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Created: {fmtDateTime(link.generatedAt)}
                              {link.branchName ? ` · ${link.branchName}` : ""}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <StatusChip label={link.status} tone={statusTone(link.status)} />
                            {link.status === "UNUSED" && (
                              <Button variant="outline" size="sm" onClick={(e) => handleRevokeLink(link.token, e)}>
                                <Trash2 className="size-3" /> Revoke
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
          )
        : null
      }

      {/* ---- Device Registry ---- */}
      {activeTab === "devices"
        ? (
            <section className="mt-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Device Registry</CardTitle>
                  <CardDescription>All devices managed by SUPER_ADMIN. Filter by status.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-2 mb-3">
                    {FILTER_ALL.map((f) => (
                      <button
                        key={f}
                        onClick={() => setDeviceFilter(f)}
                        className={cn(
                          "border px-2 py-1 text-xs font-black uppercase tracking-wider transition",
                          deviceFilter === f ? "border-gold bg-gold/10 text-ink" : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  {devices === undefined ? (
                    <RowSkeleton rows={5} />
                  ) : devices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No devices found for this filter.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-ink">
                          <th className="text-left py-2 font-semibold">Staff</th>
                          <th className="text-left py-2 font-semibold">Device</th>
                          <th className="text-left py-2 font-semibold">Status</th>
                          <th className="text-left py-2 font-semibold">Last Seen</th>
                          <th className="text-left py-2 font-semibold">Requested</th>
                          <th className="text-left py-2 font-semibold">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {devices.map((device) => (
                          <tr key={device._id} className="border-b border-ink/50 hover:bg-muted/30">
                            <td className="py-2">
                              <p className="font-medium">{device.staffName}</p>
                              <p className="text-xs text-muted-foreground">{device.staffId} · {device.role}</p>
                            </td>
                            <td className="py-2">
                              <p className="flex items-center gap-1">
                                <Smartphone className="size-3" />
                                {device.label}
                              </p>
                              {device.browser && (
                                <p className="text-xs text-muted-foreground">
                                  {device.browser} {device.browserVersion} · {device.os}
                                </p>
                              )}
                            </td>
                            <td className="py-2">
                              <StatusChip label={device.status} tone={statusTone(device.status)} />
                            </td>
                            <td className="py-2 text-xs text-muted-foreground">{device.lastSeenAt ? fmtAgo(device.lastSeenAt) : "—"}</td>
                            <td className="py-2 text-xs text-muted-foreground">{device.requestedAt ? fmtDateTime(device.requestedAt) : "—"}</td>
                            <td className="py-2">
                              <div className="flex gap-1">
                                <Button variant="outline" size="sm" onClick={() => navigate(`/dashboard/security/device/${device._id}`)}>
                                  <Eye className="size-3" /> View
                                </Button>
                                {device.status === "PENDING" ? (
                                  <>
                                    <Button
                                      size="sm"
                                      onClick={async () => {
                                        const ok = await approveDevice({ deviceId: device._id, reason: "Approved by SUPER_ADMIN" });
                                        if (ok.ok) window.location.reload();
                                      }}
                                    >
                                      <Check className="size-3" /> Approve
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={async () => {
                                        const ok = await rejectDevice({ deviceId: device._id, reason: "Rejected by SUPER_ADMIN" });
                                        if (ok.ok) window.location.reload();
                                      }}
                                    >
                                      Reject
                                    </Button>
                                  </>
                                ) : device.status === "AUTHORIZED" ? (
                                  <>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={async () => {
                                        const ok = await blockDevice({ deviceId: device._id, reason: "Blocked by SUPER_ADMIN" });
                                        if (ok.ok) window.location.reload();
                                      }}
                                    >
                                      <Ban className="size-3" /> Block
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={async () => {
                                        const ok = await revokeDevice({ deviceId: device._id, reason: "Revoked by SUPER_ADMIN" });
                                        if (ok.ok) window.location.reload();
                                      }}
                                    >
                                      <RotateCcw className="size-3" /> Revoke
                                    </Button>
                                  </>
                                ) : device.status === "REVOKED" ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={async () => {
                                      const ok = await reactivateDevice({ deviceId: device._id, reason: "Reactivated by SUPER_ADMIN" });
                                      if (ok.ok) window.location.reload();
                                    }}
                                  >
                                    <RotateCcw className="size-3" /> Reactivate
                                  </Button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            </section>
          )
        : null
      }

      <div className="flex items-center gap-2 border border-ink bg-muted p-3 text-xs">
        <ShieldCheck className="size-4" />
        <p className="font-semibold">Backend-backed · All device actions are authenticated and audited</p>
        <ArrowRight className="size-3 ml-auto" />
      </div>
    </div>
  );
}
