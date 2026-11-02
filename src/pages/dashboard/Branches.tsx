import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Building, MapPin, Phone, Briefcase, Trash2, AlertTriangle } from "lucide-react";
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
import { toast } from "sonner";

export default function Branches() {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const branches = useQuery(api.admin.branches);
  const createBranch = useMutation(api.admin.createBranch);
  const updateBranch = useMutation(api.admin.updateBranch);
  const deleteBranch = useMutation(api.admin.deleteBranch);
  const isSuperAdmin = profile?.role === "SUPER_ADMIN";

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: "",
    city: "",
    state: "",
    status: "ACTIVE" as "ACTIVE" | "INACTIVE",
    address: "",
    contactNumber: "",
  });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((s) => ({ ...s, [k]: e.target.value }));

  const handleCreate = async () => {
    if (!form.name.trim() || !form.city.trim() || !form.state.trim()) {
      return;
    }
    setSaving(true);
    try {
      const result = await createBranch({
        name: form.name.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        status: form.status,
        address: form.address.trim() || undefined,
        contactNumber: form.contactNumber.trim() || undefined,
      });
      toast.success(`Branch "${form.name.trim()}" created — ID ${fmtId(String(result.branchIdCode))}`);
      setCreating(false);
      setForm({ name: "", city: "", state: "", status: "ACTIVE", address: "", contactNumber: "" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create branch");
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (branchId: string) => {
    setSaving(true);
    try {
      await updateBranch({ branchId: branchId as any, name: editForm.name, city: editForm.city, state: editForm.state, status: editForm.status, address: editForm.address, contactNumber: editForm.contactNumber });
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (b: any) => {
    setEditForm({
      name: b.name,
      city: b.city,
      state: b.state,
      status: b.status,
      address: b.address || "",
      contactNumber: b.contactNumber || "",
    });
    setEditing(b._id);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await deleteBranch({ branchId: deleteTarget._id });
      toast.success(`Branch "${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
      setConfirmingDelete(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete branch");
      throw err;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black uppercase tracking-wider">Branches</h1>
        {true && (
          <Button size="lg" onClick={() => setCreating(true)}>
            <Plus className="mr-2 size-4" /> Create branch
          </Button>
        )}
      </div>

      {creating && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="size-4" /> Create branch
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label className="text-xs font-black uppercase">Branch name *</Label>
              <Input value={form.name} onChange={set("name")} placeholder="KNP" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-black uppercase">City *</Label>
              <Input value={form.city} onChange={set("city")} placeholder="Kanpur" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-black uppercase">State *</Label>
              <Input value={form.state} onChange={set("state")} placeholder="Uttar Pradesh" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-xs font-black uppercase">Status</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.status}
                  onChange={(e) => setForm((s) => ({ ...s, status: e.target.value as any }))}
                >
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INACTIVE">INACTIVE</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-black uppercase">Contact number</Label>
                <Input value={form.contactNumber} onChange={set("contactNumber")} placeholder="9876543210" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-black uppercase">Address</Label>
              <Input value={form.address} onChange={set("address")} placeholder="Optional address" />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleCreate} disabled={saving} className="flex-1">
                {saving ? "Saving..." : "Create"}
              </Button>
              <Button variant="outline" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(branches ?? []).map((b) => (
          <Card key={b._id}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2">
                <Building className="size-4 text-muted-foreground" />
                <CardTitle className="text-base font-black">{b.name}</CardTitle>
              </div>
              <Badge variant={b.status === "ACTIVE" ? "default" : "secondary"}>{b.status}</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <MapPin className="size-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">{b.city}, {b.state}</span>
              </div>
              {b.address && (
                <div className="flex items-start gap-2 text-sm">
                  <Briefcase className="size-3.5 text-muted-foreground mt-0.5" />
                  <span>{b.address}</span>
                </div>
              )}
              {b.contactNumber && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="size-3.5 text-muted-foreground" />
                  <span>{b.contactNumber}</span>
                </div>
              )}
              <div className="flex items-center justify-between pt-2 border-t">
                <span className="text-xs font-mono font-bold">
                  Branch ID: <span className="text-amber-600">{fmtId(String(b.branchIdCode))}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {b.code} {b.managerName ? ` · ${b.managerName}` : ""}
                </span>
              </div>
              {editing === b._id ? (
                <div className="space-y-2 pt-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={editForm.name} onChange={(e) => setEditForm((s: any) => ({ ...s, name: e.target.value }))} />
                    <Input value={editForm.city} onChange={(e) => setEditForm((s: any) => ({ ...s, city: e.target.value }))} />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => handleEdit(b._id)} disabled={saving}>
                      {saving ? "Saving..." : "Save"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => startEdit(b)}>
                    Edit
                  </Button>
                  {isSuperAdmin && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleteTarget(b)}
                      disabled={saving}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {(!branches || branches.length === 0) && (
        <div className="text-center py-12">
          <Building className="mx-auto size-12 text-muted-foreground" />
          <p className="mt-4 text-lg font-bold">No branches yet</p>
          <p className="text-sm text-muted-foreground">Create your first branch to get started.</p>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-destructive" />
              Delete Branch
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the branch &quot;{deleteTarget?.name}&quot;?
              <br />
              <span className="text-[11px]">This action cannot be undone.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={saving}>
              {saving ? "Deleting..." : "Delete Branch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
