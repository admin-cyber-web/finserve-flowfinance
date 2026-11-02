import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building, MapPin, Search, Trash2, AlertTriangle, Plus } from "lucide-react";
import { can, type Permission } from "@/lib/finance/permissions";
import { useProfile } from "@/hooks/use-profile";
import { fmtId } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/fs/primitives";
import { toast } from "sonner";

export default function Centres() {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const centres = useQuery(api.clients.centres);
  const deleteCenter = useMutation(api.admin.deleteCenter);
  const isSuperAdmin = profile?.role === "SUPER_ADMIN";

  const [q, setQ] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleDelete = async () => {
    if (!deleteTarget) {
      toast.error('No centre selected for deletion');
      return;
    }
    if (!deleteTarget._id) {
      toast.error('Invalid centre data');
      return;
    }
    setSaving(true);
    try {
      await deleteCenter({ centerId: deleteTarget._id });
      toast.success(`Centre "${deleteTarget.name}" deleted`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete centre";
      toast.error(message);
    } finally {
      setDeleteTarget(null);
      setConfirmingDelete(false);
      setSaving(false);
    }
  };

  // Wrapper to prevent unhandled promise rejections from React event handlers
  const onDeleteClick = () => {
    void handleDelete().catch(() => {
      // Errors are already handled in handleDelete via toast
    });
  };

  const centerList = centres?.map((c) => ({
    _id: c.center._id,
    code: c.center.code,
    name: c.center.name,
    village: c.center.village,
    branchId: c.center.branchId,
    clientCount: c.groups.reduce((acc: number, g: any) => acc + (g.members?.length || 0), 0),
    groupCount: c.groups.length,
  })) || [];

  const filteredCentres = q.trim()
    ? centerList.filter(
        (c) =>
          c.name.toLowerCase().includes(q.toLowerCase()) ||
          c.code.toLowerCase().includes(q.toLowerCase())
      )
    : centerList;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black uppercase tracking-wider">Centres</h1>
        {isSuperAdmin && (
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter centres..."
                className="h-10 w-48 rounded-md border border-input bg-background pl-9 pr-3 text-sm focus:border-ink focus:outline-none"
              />
            </div>
          </div>
        )}
      </div>

      {isSuperAdmin && (
        <div className="flex items-center justify-between border-2 border-ink bg-gold p-3">
          <span className="text-xs font-black uppercase">SUPER_ADMIN</span>
          <span className="text-[10px] text-muted-foreground">
            You can delete centres. Deletion is blocked if clients are linked.
          </span>
        </div>
      )}

      {filteredCentres.length === 0 ? (
        <div className="text-center py-12">
          <Building className="mx-auto size-12 text-muted-foreground" />
          <p className="mt-4 text-lg font-bold">
            {q.trim() ? "No matching centres found." : "No centres yet"}
          </p>
          {isSuperAdmin && !q.trim() && (
            <p className="text-sm text-muted-foreground">
              Create centres from the New Client flow.
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredCentres.map((c) => (
            <Card key={c._id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="flex items-center gap-2">
                  <Building className="size-4 text-muted-foreground" />
                  <CardTitle className="text-base font-black">{c.name}</CardTitle>
                </div>
                <Badge variant="default">{fmtId(c.code)}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <MapPin className="size-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">{c.village || "—"}</span>
                </div>
                <div className="flex items-center justify-between pt-2 border-t">
                  <span className="text-xs text-muted-foreground">
                    {c.clientCount} client{c.clientCount !== 1 ? "s" : ""} · {c.groupCount} group{c.groupCount !== 1 ? "s" : ""}
                  </span>
                </div>
                {isSuperAdmin && (
                  <div className="flex gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => { setDeleteTarget(c); setConfirmingDelete(true); }}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-destructive" />
              Delete Centre
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the centre "{deleteTarget?.name}" ({fmtId(deleteTarget?.code)})?
              <br />
              <span className="text-[11px]">
                This action cannot be undone. Deletion is blocked if clients are linked to this centre.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onDeleteClick} disabled={saving}>
              {saving ? "Deleting..." : "Delete Centre"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
