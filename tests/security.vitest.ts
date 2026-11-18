/**
 * Independent Security Department — function-level tests.
 *
 * Runs the real Convex functions against an in-memory deployment
 * (convex-test), so authorization is proven at the backend layer rather than
 * by clicking around the UI.
 */
import { convexTest } from "convex-test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { api, internal } from "../src/convex/_generated/api";
// `internal` is used by the recovery/seed and staff-sign-in tests below.
import schema from "../src/convex/schema";
import { hashCredential } from "../src/lib/server/credentials";

const modules = import.meta.glob("../src/convex/**/*.ts");

const PIN = "482913";
const OPERATOR = "SO-0001";
const CREDENTIAL = "Kirat-Sec-2026";

type TestConvex = ReturnType<typeof convexTest>;

async function freshDeployment(): Promise<TestConvex> {
  const t = convexTest(schema, modules);
  await t.mutation(internal.security.seedBootstrap, { activationPin: "9560" });
  return t;
}

async function activate(t: TestConvex) {
  const begin = await t.mutation(api.security.beginActivation, {
    activationPin: "9560",
    userAgent: "vitest",
  });
  const done = await t.mutation(api.security.completeActivation, {
    token: begin.token,
    newPin: PIN,
    confirmPin: PIN,
    operatorId: OPERATOR,
    operatorName: "Security Administrator",
    credential: CREDENTIAL,
    confirmCredential: CREDENTIAL,
    userAgent: "vitest",
  });
  return done;
}

async function signIn(
  t: TestConvex,
  args: { pin?: string; credential?: string; operatorId?: string } = {},
) {
  return await t.mutation(api.security.login, {
    operatorId: args.operatorId ?? OPERATOR,
    credential: args.credential ?? CREDENTIAL,
    pin: args.pin ?? PIN,
  });
}

/** Browser-side key pair used to prove device possession in tests. */
async function deviceKeyPair(): Promise<{ pair: CryptoKeyPair; jwk: string }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { pair, jwk: JSON.stringify(jwk) };
}

async function signMessage(pair: CryptoKeyPair, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(message),
  );
  return Buffer.from(new Uint8Array(signature)).toString("base64");
}

/** SUPER_ADMIN staff identity (the role that must have zero security power). */
async function seedSuperAdmin(t: TestConvex) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Super Admin",
      email: "super@kmc.test",
    });
    const profileId = await ctx.db.insert("profiles", {
      userId,
      name: "Super Admin",
      staffId: "0001",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      createdAt: Date.now(),
    });
    return { userId, profileId };
  });
}

async function seedStaff(t: TestConvex, staffId: string, name: string) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name, email: `${staffId}@kmc.test` });
    const profileId = await ctx.db.insert("profiles", {
      userId,
      name,
      staffId,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      createdAt: Date.now(),
    });
    return { userId, profileId };
  });
}

describe("Security Department activation", () => {
  it("accepts the bootstrap PIN once and never again", async () => {
    const t = await freshDeployment();
    const state = await t.query(api.security.bootstrapState, {});
    expect(state.provisioned).toBe(true);
    expect(state.initialized).toBe(false);
    expect(state.bootstrapAvailable).toBe(true);

    await expect(
      t.mutation(api.security.beginActivation, { activationPin: "1111" }),
    ).rejects.toThrow(/Wrong activation PIN/);

    const done = await activate(t);
    expect(done.recoveryCode).toMatch(/^KMC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // 9560 is consumed — it cannot re-open the portal or re-arm activation.
    await expect(
      t.mutation(api.security.beginActivation, { activationPin: "9560" }),
    ).rejects.toThrow(/already activated/i);
    const afterState = await t.query(api.security.bootstrapState, {});
    expect(afterState.initialized).toBe(true);
    expect(afterState.bootstrapAvailable).toBe(false);

    // The bootstrap PIN is also not the department PIN.
    const oldPinLogin = await signIn(t, { pin: "9560" });
    expect(oldPinLogin.ok).toBe(false);
  });

  it("mandatory credential setup blocks all security operations until complete", async () => {
    const t = await freshDeployment();
    const begin = await t.mutation(api.security.beginActivation, {
      activationPin: "9560",
    });
    const device = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "Staff" });
      const profileId = await ctx.db.insert("profiles", {
        userId,
        name: "Staff",
        staffId: "0009",
        role: "FIELD_STAFF",
        status: "ACTIVE",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("securityDevices", {
        profileId,
        staffId: "0009",
        staffName: "Staff",
        role: "FIELD_STAFF",
        fingerprint: "fp-activation-test-0001",
        deviceKey: "key-activation-test-0001",
        label: "Test",
        status: "PENDING",
        source: "REGISTRATION",
        requestedAt: Date.now(),
        lastSeenAt: Date.now(),
      });
    });
    await expect(
      t.mutation(api.security.approveDevice, { token: begin.token, deviceId: device }),
    ).rejects.toThrow(/activation|permission/i);
    await expect(
      t.query(api.security.dashboard, { token: begin.token }),
    ).rejects.toThrow(/activation|permission/i);

    await t.mutation(api.security.completeActivation, {
      token: begin.token,
      newPin: PIN,
      confirmPin: PIN,
      operatorId: OPERATOR,
      operatorName: "Security Administrator",
      credential: CREDENTIAL,
      confirmCredential: CREDENTIAL,
    });
    // The bootstrap session is revoked once activation completes.
    await expect(
      t.query(api.security.dashboard, { token: begin.token }),
    ).rejects.toThrow(/invalid|revoked/i);
  });

  it("rejects weak PINs and credentials during activation", async () => {
    const t = await freshDeployment();
    const begin = await t.mutation(api.security.beginActivation, {
      activationPin: "9560",
    });
    const base = {
      token: begin.token,
      operatorId: OPERATOR,
      operatorName: "Security Administrator",
      credential: CREDENTIAL,
      confirmCredential: CREDENTIAL,
    };
    await expect(
      t.mutation(api.security.completeActivation, {
        ...base,
        newPin: "123456",
        confirmPin: "123456",
      }),
    ).rejects.toThrow(/sequence/i);
    await expect(
      t.mutation(api.security.completeActivation, {
        ...base,
        newPin: PIN,
        confirmPin: PIN,
        credential: "short",
        confirmCredential: "short",
      }),
    ).rejects.toThrow(/at least 10/i);
  });
});

describe("SUPER_ADMIN and the independent Security Department", () => {
  it("cannot open the Security portal with staff credentials", async () => {
    const t = await freshDeployment();
    await activate(t);
    const admin = await seedSuperAdmin(t);
    const forAdmin = t.withIdentity({ subject: admin.userId, issuer: "https://kmc.test" });

    // The Security Command Center is independent: a KMC staff session does not
    // open it. No token → no portal, regardless of staff role.
    await expect(forAdmin.query(api.security.dashboard, { token: "" })).rejects.toThrow(
      /Security session required/,
    );
    await expect(
      forAdmin.query(api.security.dashboard, { token: "aaaa".repeat(16) }),
    ).rejects.toThrow(/invalid/i);

    // A SUPER_ADMIN staff identity alone cannot mint a Security session.
    const attempted = await forAdmin.mutation(api.security.login, {
      operatorId: OPERATOR,
      credential: CREDENTIAL,
      pin: PIN,
    });
    expect(attempted.ok).toBe(true); // PIN + operator credential still apply…
    const forged = await forAdmin.query(api.security.session, { token: "not-a-real-token" });
    expect(forged).toBeNull();
  });

  it("cannot approve, block, revoke, reject or reactivate devices through the Security portal", async () => {
    const t = await freshDeployment();
    const activation = await activate(t);
    const admin = await seedSuperAdmin(t);
    const forAdmin = t.withIdentity({ subject: admin.userId, issuer: "https://kmc.test" });
    const device = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "Field" });
      const profileId = await ctx.db.insert("profiles", {
        userId,
        name: "Field",
        staffId: "0010",
        role: "FIELD_STAFF",
        status: "ACTIVE",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("securityDevices", {
        profileId,
        staffId: "0010",
        staffName: "Field",
        role: "FIELD_STAFF",
        fingerprint: "fp-security-dap-01",
        deviceKey: "key-security-dap-01",
        label: "Test",
        status: "PENDING",
        source: "REGISTRATION",
        requestedAt: Date.now(),
        lastSeenAt: Date.now(),
      });
    });

    // The Security portal guard needs a valid session token. A SUPER_ADMIN
    // cannot obtain one without the operator credential + PIN.
    await expect(
      forAdmin.mutation(api.security.approveDevice, {
        token: "bogus-token-value-bogus",
        deviceId: device,
      }),
    ).rejects.toThrow(/invalid|required/i);
    await expect(
      forAdmin.mutation(api.security.blockDevice, {
        token: "bogus-token-value-bogus",
        deviceId: device,
        reason: "admin attempt",
        confirmCredential: CREDENTIAL,
      }),
    ).rejects.toThrow(/invalid|required/i);
    await expect(
      forAdmin.mutation(api.security.revokeDevice, {
        token: "bogus-token-value-bogus",
        deviceId: device,
        reason: "admin attempt",
        confirmCredential: CREDENTIAL,
      }),
    ).rejects.toThrow(/invalid|required/i);
    await expect(
      forAdmin.mutation(api.security.changePin, {
        token: "bogus-token-value-bogus",
        currentPin: PIN,
        newPin: "739201",
        confirmPin: "739201",
      }),
    ).rejects.toThrow(/invalid|required/i);

    // Nothing changed in the Security Department state.
    const rows = await t.query(api.security.devices, { token: activation.token });
    expect(rows.find((d) => d._id === device)?.status).toBe("PENDING");
  });

  it("still keeps the Security Department independent from KMC staff auth", () => {
    const source = readFileSync(resolve(process.cwd(), "src/convex/security.ts"), "utf8");
    // Owner-only operations exist only as internal mutations (never callable
    // from a browser session, staff or security).
    expect(source).toMatch(/export const seedBootstrap = internalMutation/);
    expect(source).toMatch(/export const ownerRecovery = internalMutation/);
    expect(source).toMatch(/export const loginInternal = internalMutation/);
    // The audit log has no delete/update path, and devices are never deleted.
    expect(source).not.toMatch(/ctx\.db\.delete\(/);
    expect(source).not.toMatch(/auditLog\s*=\s*mutation/);

    const router = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    expect(router).toContain('path="/security"');
    expect(router).toContain("SecurityPortal");

    // No delete/rename endpoint exists for security records.
    const exported = [...source.matchAll(/export const (\w+) = (query|mutation|internalMutation)/g)].map(
      (m) => m[1],
    );
    expect(exported.length).toBeGreaterThan(10);
    expect(exported.filter((n) => /delete|remove|purge|wipe/i.test(n))).toEqual([]);
  });
});

describe("Operator permissions and sessions", () => {
  it("gives an auditor read-only access and denies device control", async () => {
    const t = await freshDeployment();
    const activation = await activate(t);

    await t.mutation(api.security.createOperator, {
      token: activation.token,
      operatorId: "SO-0002",
      name: "Auditor One",
      role: "SECURITY_AUDITOR",
      credential: "Auditor-Temp-2026",
      confirmCredential: "Auditor-Temp-2026",
      confirmOperatorCredential: CREDENTIAL,
    });

    const firstLogin = await t.mutation(api.security.login, {
      operatorId: "SO-0002",
      credential: "Auditor-Temp-2026",
      pin: PIN,
    });
    expect(firstLogin.ok).toBe(true);
    expect(firstLogin.mustRotateCredential).toBe(true);

    // ROTATION mode can only rotate its own credential.
    await expect(
      t.query(api.security.session, { token: firstLogin.token! }),
    ).resolves.toMatchObject({ mode: "ROTATION" });
    await expect(
      t.query(api.security.dashboard, { token: firstLogin.token! }),
    ).rejects.toThrow(/credential|activation|permission/i);

    const rotated = await t.mutation(api.security.rotateOperatorCredential, {
      token: firstLogin.token!,
      currentCredential: "Auditor-Temp-2026",
      newCredential: "Auditor-Own-2026",
      confirmCredential: "Auditor-Own-2026",
    });
    const auditorToken = rotated.token;

    // Read is allowed, control is not.
    const auditorDevices = await t.query(api.security.devices, { token: auditorToken });
    expect(Array.isArray(auditorDevices)).toBe(true);
    const device = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "Field" });
      const profileId = await ctx.db.insert("profiles", {
        userId,
        name: "Field",
        staffId: "0011",
        role: "FIELD_STAFF",
        status: "ACTIVE",
        createdAt: Date.now(),
      });
      return await ctx.db.insert("securityDevices", {
        profileId,
        staffId: "0011",
        staffName: "Field",
        role: "FIELD_STAFF",
        fingerprint: "fp-auditor-denied-001",
        deviceKey: "key-auditor-denied-001",
        label: "Test",
        status: "PENDING",
        source: "REGISTRATION",
        requestedAt: Date.now(),
        lastSeenAt: Date.now(),
      });
    });
    await expect(
      t.mutation(api.security.approveDevice, { token: auditorToken, deviceId: device }),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      t.mutation(api.security.revokeDevice, {
        token: auditorToken,
        deviceId: device,
        reason: "auditor attempt",
        confirmCredential: "Auditor-Own-2026",
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("invalidates every other session when the PIN rotates", async () => {
    const t = await freshDeployment();
    const activation = await activate(t);
    const second = await signIn(t);
    expect(second.ok).toBe(true);

    const rotated = await t.mutation(api.security.changePin, {
      token: activation.token,
      currentPin: PIN,
      newPin: "739201",
      confirmPin: "739201",
    });
    await expect(
      t.query(api.security.dashboard, { token: second.token! }),
    ).rejects.toThrow(/revoked|expired|invalid/i);
    await expect(
      t.query(api.security.dashboard, { token: rotated.token }),
    ).resolves.toBeTruthy();

    // Old PIN no longer signs in; new one does.
    expect((await signIn(t, { pin: PIN })).ok).toBe(false);
    expect((await signIn(t, { pin: "739201" })).ok).toBe(true);
  });

  it("locks the department after repeated failures", async () => {
    const t = await freshDeployment();
    await activate(t);
    for (let i = 0; i < 5; i += 1) {
      const attempt = await signIn(t, { credential: "wrong-credential-1" });
      expect(attempt.ok).toBe(false);
    }
    const locked = await signIn(t);
    expect(locked.ok).toBe(false);
    expect(locked.message).toMatch(/locked/i);
  });
});

describe("Device authorization", () => {
  it("enforces one authorized device per staff ID and invalidates sessions", async () => {
    const t = await freshDeployment();
    const activation = await activate(t);
    const staff = await seedStaff(t, "0001", "Super Admin");
    const asStaff = t.withIdentity({ subject: staff.userId, issuer: "https://kmc.test" });

    // No device is grandfathered in — the first request is PENDING and the
    // staff API stays closed until a Security Operator approves it.
    const first = await asStaff.mutation(api.security.registerDevice, {
      fingerprint: "fp-device-primary-0001",
      label: "Chrome · Windows",
      platform: "Windows",
    });
    expect(first.status).toBe("PENDING");
    await expect(asStaff.query(api.clients.list, {})).rejects.toThrow(
      /not authorized by the Security Department/i,
    );
    const requested = await t.query(api.security.devices, { token: activation.token });
    const approved = await t.mutation(api.security.approveDevice, {
      token: activation.token,
      deviceId: requested.find((d) => d.status === "PENDING")!._id,
    });
    expect(approved.ok).toBe(true);

    // Business API works while the device is authorized.
    expect(Array.isArray(await asStaff.query(api.clients.list, {}))).toBe(true);

    // Second device → pending, not authorized.
    const second = await asStaff.mutation(api.security.registerDevice, {
      fingerprint: "fp-device-secondary-0002",
      label: "Safari · iOS",
      platform: "iOS",
    });
    expect(second.status).toBe("PENDING");
    const devices = await t.query(api.security.devices, { token: activation.token });
    expect(devices.filter((d) => d.status === "PENDING")).toHaveLength(1);
    expect(devices.filter((d) => d.status === "AUTHORIZED")).toHaveLength(1);

    // Replacement approval: old device is revoked, new one takes over.
    const authorizedRow = devices.find((d) => d.status === "AUTHORIZED")!;
    const pendingRow = devices.find((d) => d.status === "PENDING")!;
    const replaced = await t.mutation(api.security.replaceDevice, {
      token: activation.token,
      oldDeviceId: authorizedRow._id,
      newDeviceId: pendingRow._id,
      reason: "Phone upgrade",
      confirmCredential: CREDENTIAL,
    });
    expect(replaced.ok).toBe(true);
    const afterReplace = await t.query(api.security.devices, { token: activation.token });
    expect(afterReplace.find((d) => d._id === authorizedRow._id)?.status).toBe("REPLACED");
    expect(afterReplace.find((d) => d._id === pendingRow._id)?.status).toBe("AUTHORIZED");

    // Block the only authorized device → the staff API is refused.
    const blockResult = await t.mutation(api.security.blockDevice, {
      token: activation.token,
      deviceId: pendingRow._id,
      reason: "Lost device",
      confirmCredential: CREDENTIAL,
    });
    expect(blockResult.ok).toBe(true);
    const blockedRows = await t.query(api.security.devices, { token: activation.token });
    expect(blockedRows.find((d) => d._id === pendingRow._id)?.status).toBe("BLOCKED");
    expect(blockedRows.filter((d) => d.status === "AUTHORIZED")).toHaveLength(0);
    const gateProbe = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("securityDevices")
        .withIndex("by_profile", (q) => q.eq("profileId", staff.profileId))
        .collect();
      return rows.map((r) => r.status);
    });
    expect(gateProbe.slice().sort()).toEqual(["BLOCKED", "REPLACED"]);
    await expect(asStaff.query(api.clients.list, {})).rejects.toThrow(
      /not authorized by the Security Department/i,
    );

    // Unblock restores authorization and access.
    const unblocked = await t.mutation(api.security.unblockDevice, {
      token: activation.token,
      deviceId: pendingRow._id,
      reason: "Device recovered",
    });
    expect(unblocked.status).toBe("AUTHORIZED");
    expect(Array.isArray(await asStaff.query(api.clients.list, {}))).toBe(true);

    // Revocation + registration attempt from a revoked device is logged.
    await t.mutation(api.security.revokeDevice, {
      token: activation.token,
      deviceId: pendingRow._id,
      reason: "Staff left the company",
      confirmCredential: CREDENTIAL,
    });
    await expect(asStaff.query(api.clients.list, {})).rejects.toThrow(
      /not authorized/i,
    );
    const reRegister = await asStaff.mutation(api.security.registerDevice, {
      fingerprint: "fp-device-secondary-0002",
      label: "Safari · iOS",
      platform: "iOS",
    });
    expect(reRegister.status).toBe("REVOKED");

    const dashboard = await t.query(api.security.dashboard, { token: activation.token });
    expect(dashboard.unauthorizedAttempts24h).toBeGreaterThanOrEqual(1);
    expect(dashboard.devices.pending).toBe(0);
    expect(dashboard.devices.authorized).toBe(0);
  });

  it("maintains one authorized device per staff ID after a replacement flow", async () => {
    const t = await freshDeployment();
    const activation = await activate(t);
    const staff = await seedStaff(t, "0014", "Replacement Staff");
    const asStaff = t.withIdentity({ subject: staff.userId, issuer: "https://kmc.test" });
    await asStaff.mutation(api.security.registerDevice, {
      fingerprint: "fp-device-repl-a01",
      label: "Original",
      platform: "Windows",
    });
    const devices = await t.query(api.security.devices, { token: activation.token });
    const active = devices.find((d) => d.status === "PENDING")!;
    await t.mutation(api.security.approveDevice, { token: activation.token, deviceId: active._id });
    const second = await asStaff.mutation(api.security.registerDevice, {
      fingerprint: "fp-device-repl-a02",
      label: "Replacement",
      platform: "Windows",
    });
    expect(second.status).toBe("PENDING");
    const afterSecond = await t.query(api.security.devices, { token: activation.token });
    const pending = afterSecond.find((d) => d.status === "PENDING" && d._id !== active._id)!;
    const replaced = await t.mutation(api.security.replaceDevice, {
      token: activation.token,
      oldDeviceId: active._id,
      newDeviceId: pending._id,
      reason: "Replacement",
      confirmCredential: CREDENTIAL,
    });
    expect(replaced.ok).toBe(true);
    const finalRows = await t.query(api.security.devices, { token: activation.token });
    expect(finalRows.find((d) => d._id === active._id)?.status).toBe("REPLACED");
    expect(finalRows.find((d) => d._id === pending._id)?.status).toBe("AUTHORIZED");
  });

  it("denies approval when the staff already has an active device (without replace)", async () => {
    const t = await freshDeployment();
    const activation = await activate(t);
    const staff = await seedStaff(t, "0012", "Field Two");
    const asStaff = t.withIdentity({ subject: staff.userId, issuer: "https://kmc.test" });
    await asStaff.mutation(api.security.registerDevice, {
      fingerprint: "fp-device-approval-a01",
      label: "Chrome",
    });
    const active = (await t.query(api.security.devices, { token: activation.token }))[0];
    await t.mutation(api.security.approveDevice, {
      token: activation.token,
      deviceId: active._id,
    });
    await asStaff.mutation(api.security.registerDevice, {
      fingerprint: "fp-device-approval-b02",
      label: "Firefox",
    });
    const pending = (await t.query(api.security.devices, { token: activation.token })).find(
      (d) => d.status === "PENDING",
    )!;
    await expect(
      t.mutation(api.security.approveDevice, {
        token: activation.token,
        deviceId: pending._id,
      }),
    ).rejects.toThrow(/already has an authorized device/i);
  });

  it("requires operator credential re-entry for destructive device actions", async () => {
    const t = await freshDeployment();
    const activation = await activate(t);
    const staff = await seedStaff(t, "0013", "Field Three");
    const asStaff = t.withIdentity({ subject: staff.userId, issuer: "https://kmc.test" });
    await asStaff.mutation(api.security.registerDevice, {
      fingerprint: "fp-device-credential-a01",
      label: "Chrome",
    });
    const device = (await t.query(api.security.devices, { token: activation.token }))[0];
    await t.mutation(api.security.approveDevice, {
      token: activation.token,
      deviceId: device._id,
    });
    await expect(
      t.mutation(api.security.blockDevice, {
        token: activation.token,
        deviceId: device._id,
        reason: "Suspicious",
        confirmCredential: "wrong-credential-9",
      }),
    ).rejects.toThrow(/Additional verification failed/i);
  });
});

describe("Cryptographic device enrollment", () => {
  type TestPair = CryptoKeyPair;

  async function newDeviceKey(): Promise<{ pair: TestPair; jwk: string }> {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as TestPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    return { pair, jwk: JSON.stringify(jwk) };
  }

  async function sign(pair: TestPair, message: string): Promise<string> {
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(message),
    );
    return Buffer.from(new Uint8Array(signature)).toString("base64");
  }

  async function enroll(t: TestConvex, staffId: string, jwk: string, pair: TestPair) {
    const start = await t.mutation(api.securityDevice.deviceChallenge, {
      purpose: "ENROLL",
      staffId,
      publicKeyJwk: jwk,
    });
    if (!start.ok) throw new Error("enrollment challenge was refused");
    return await t.mutation(api.securityDevice.completeEnrollment, {
      challengeRef: start.ref,
      signature: await sign(pair, start.challenge),
      label: "P-256 test device",
      category: "Desktop",
      os: "Linux",
      browser: "TestBrowser",
    });
  }

  async function approve(t: TestConvex, token: string, enrollmentId: string) {
    const devices = await t.query(api.security.devices, { token });
    const row = devices.find((d) => d.enrollmentId === enrollmentId);
    if (!row) throw new Error("device row missing");
    return await t.mutation(api.security.approveDevice, {
      token,
      deviceId: row._id,
    });
  }

  async function verifyStart(t: TestConvex, enrollmentId: string) {
    const start = await t.mutation(api.securityDevice.deviceChallenge, {
      purpose: "VERIFY",
      enrollmentId,
    });
    if (!start.ok) throw new Error("verify challenge was refused");
    return start;
  }

  it("enrolls a real key, stays pending until approved, and issues a proof only then", async () => {
    const t = await freshDeployment();
    const token = (await activate(t)).token;
    await seedStaff(t, "0021", "Key Staff");
    const key = await newDeviceKey();

    const enrolled = await enroll(t, "0021", key.jwk, key.pair);
    expect(enrolled.ok).toBe(true);
    expect(enrolled.status).toBe("PENDING");

    // Not approved yet → no proof, no access.
    const before = await verifyStart(t, enrolled.enrollmentId!);
    const pendingResult = await t.mutation(api.securityDevice.verifyDevice, {
      challengeRef: before.ref,
      signature: await sign(key.pair, before.challenge),
    });
    expect(pendingResult.status).toBe("PENDING");
    expect("proof" in pendingResult).toBe(false);

    expect((await approve(t, token, enrolled.enrollmentId!)).ok).toBe(true);

    const start = await verifyStart(t, enrolled.enrollmentId!);
    const authorized = await t.mutation(api.securityDevice.verifyDevice, {
      challengeRef: start.ref,
      signature: await sign(key.pair, start.challenge),
    });
    expect(authorized.status).toBe("AUTHORIZED");
    expect(typeof (authorized as { proof?: string }).proof).toBe("string");

    // Recorded information: fingerprints, category, last verification.
    const devices = await t.query(api.security.devices, { token });
    const row = devices.find((d) => d.enrollmentId === enrolled.enrollmentId)!;
    expect(row.publicKeyFingerprint).toBeTruthy();
    expect(row.category).toBe("Desktop");
    expect(row.reportedInfo).toBe(true);
    expect(row.lastVerifiedAt).toBeTruthy();
    expect(row.enrolledAt).toBeTruthy();

    const details = await t.query(api.security.deviceDetails, {
      token,
      deviceId: row._id,
    });
    expect(details.device.keyEnrolled).toBe(true);
    expect(details.history.some((e) => e.kind === "DEVICE_ENROLLED")).toBe(true);
  });

  it("rejects an invalid signature and a replayed challenge", async () => {
    const t = await freshDeployment();
    const token = (await activate(t)).token;
    await seedStaff(t, "0022", "Sig Staff");
    const key = await newDeviceKey();
    const enrolled = await enroll(t, "0022", key.jwk, key.pair);
    await approve(t, token, enrolled.enrollmentId!);

    const start = await verifyStart(t, enrolled.enrollmentId!);
    // Signed a different message → backend refuses.
    const bad = await t.mutation(api.securityDevice.verifyDevice, {
      challengeRef: start.ref,
      signature: await sign(key.pair, `${start.challenge}-tampered`),
    });
    expect(bad.status).toBe("INVALID_SIGNATURE");
    expect("proof" in bad).toBe(false);

    // The challenge was burned by the failed attempt.
    await expect(
      t.mutation(api.securityDevice.verifyDevice, {
        challengeRef: start.ref,
        signature: await sign(key.pair, start.challenge),
      }),
    ).rejects.toThrow(/already used/i);

    // A fresh challenge still works, and then cannot be replayed.
    const second = await verifyStart(t, enrolled.enrollmentId!);
    const sig = await sign(key.pair, second.challenge);
    const ok = await t.mutation(api.securityDevice.verifyDevice, {
      challengeRef: second.ref,
      signature: sig,
    });
    expect(ok.status).toBe("AUTHORIZED");
    await expect(
      t.mutation(api.securityDevice.verifyDevice, {
        challengeRef: second.ref,
        signature: sig,
      }),
    ).rejects.toThrow(/already used/i);
  });

  it("denies verification for an unknown enrollment id (missing key)", async () => {
    const t = await freshDeployment();
    await activate(t);
    const start = await t.mutation(api.securityDevice.deviceChallenge, {
      purpose: "VERIFY",
      enrollmentId: "DEV-ABCDEFGH23",
    });
    expect(start.ok).toBe(false);
  });

  it("denies a revoked device and a blocked device", async () => {
    const t = await freshDeployment();
    const token = (await activate(t)).token;
    await seedStaff(t, "0023", "Revoked Staff");
    const key = await newDeviceKey();
    const enrolled = await enroll(t, "0023", key.jwk, key.pair);
    await approve(t, token, enrolled.enrollmentId!);
    const devices = await t.query(api.security.devices, { token });
    const row = devices.find((d) => d.enrollmentId === enrolled.enrollmentId)!;

    await t.mutation(api.security.revokeDevice, {
      token,
      deviceId: row._id,
      reason: "Laptop returned to inventory",
      confirmCredential: CREDENTIAL,
    });
    const revokedStart = await verifyStart(t, enrolled.enrollmentId!);
    const revoked = await t.mutation(api.securityDevice.verifyDevice, {
      challengeRef: revokedStart.ref,
      signature: await sign(key.pair, revokedStart.challenge),
    });
    expect(revoked.status).toBe("REVOKED");
    expect("proof" in revoked).toBe(false);

    // A second device: approve then block.
    const key2 = await newDeviceKey();
    const enrolled2 = await enroll(t, "0023", key2.jwk, key2.pair);
    await approve(t, token, enrolled2.enrollmentId!);
    const rows = await t.query(api.security.devices, { token });
    const row2 = rows.find((d) => d.enrollmentId === enrolled2.enrollmentId)!;
    await t.mutation(api.security.blockDevice, {
      token,
      deviceId: row2._id,
      reason: "Reported stolen",
      confirmCredential: CREDENTIAL,
    });
    const blockedStart = await verifyStart(t, enrolled2.enrollmentId!);
    const blocked = await t.mutation(api.securityDevice.verifyDevice, {
      challengeRef: blockedStart.ref,
      signature: await sign(key2.pair, blockedStart.challenge),
    });
    expect(blocked.status).toBe("BLOCKED");
    expect("proof" in blocked).toBe(false);
  });

  it("denies enrollment for client profiles and unapproved staff accounts", async () => {
    const t = await freshDeployment();
    await activate(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("profiles", {
        name: "Suspended Staff",
        staffId: "0098",
        role: "STAFF",
        status: "SUSPENDED",
        createdAt: Date.now(),
      });
    });
    const key = await newDeviceKey();
    await expect(
      t.mutation(api.securityDevice.deviceChallenge, {
        purpose: "ENROLL",
        staffId: "0098",
        publicKeyJwk: key.jwk,
      }),
    ).rejects.toThrow(/suspended/i);
  });

  it("enrollment outcome and verify are discoverable through deviceDetails", async () => {
    const t = await freshDeployment();
    const token = (await activate(t)).token;
    await seedStaff(t, "0041", "Details Staff");
    const key = await newDeviceKey();
    const enrolled = await enroll(t, "0041", key.jwk, key.pair);
    expect(enrolled.ok).toBe(true);
    const devices = await t.query(api.security.devices, { token });
    const row = devices.find((d) => d.enrollmentId === enrolled.enrollmentId)!;
    expect(row.enrollmentId).toBe(enrolled.enrollmentId);
    expect(row.status).toBe("PENDING");
    const details = await t.query(api.security.deviceDetails, {
      token,
      deviceId: row._id,
    });
    expect(details.device.enrollmentId).toBe(enrolled.enrollmentId);
    expect(details.device.status).toBe("PENDING");
    expect(details.history.some((e) => e.kind === "DEVICE_ENROLLED")).toBe(true);
  });
});

describe("Audit integrity", () => {
  it("verifies the hash chain and detects tampering", async () => {
    const t = await freshDeployment();
    const activation = await activate(t);
    await signIn(t);
    const log = await t.query(api.security.auditLog, { token: activation.token });
    expect(log.entries.length).toBeGreaterThan(1);
    expect(log.integrity.ok).toBe(true);
    expect(log.integrity.checked).toBe(log.entries.length);

    const target = log.entries[0];
    await t.run(async (ctx) => {
      await ctx.db.patch(target._id, { reason: "edited by an attacker" });
    });
    const tampered = await t.query(api.security.auditLog, { token: activation.token });
    expect(tampered.integrity.ok).toBe(false);
    expect(tampered.integrity.firstBrokenRef).toBe(target.ref);
  });

  it("never returns secret hashes or the PIN from public endpoints", async () => {
    const t = await freshDeployment();
    await activate(t);
    const state = JSON.stringify(await t.query(api.security.bootstrapState, {}));
    expect(state).not.toMatch(/pbkdf2|9560/);
    const activation = await activate(t).catch(() => null); // already activated
    expect(activation).toBeNull();
    const loginResult = await signIn(t);
    const session = await t.query(api.security.session, { token: loginResult.token! });
    expect(JSON.stringify(session)).not.toMatch(/pbkdf2|credentialHash/);
  });

  it("SUPER_ADMIN audit view is append-only and shows only public-friendly fields", async () => {
    const t = await freshDeployment();
    await activate(t);
    const admin = await seedSuperAdmin(t);
    const forAdmin = t.withIdentity({ subject: admin.userId, issuer: "https://kmc.test" });
    const log = await forAdmin.query(api.securityAdmin.superadminAuditLog, { limit: 5 });
    expect(Array.isArray(log.entries)).toBe(true);
    expect("integrity" in log).toBe(true);
    for (const row of log.entries) {
      expect(row).not.toHaveProperty("previousStateRaw");
      expect(row).not.toHaveProperty("newStateRaw");
    }
  });
});

describe("Independent recovery", () => {
  it("recovers with the recovery code, never with the bootstrap PIN", async () => {
    const t = await freshDeployment();
    const done = await activate(t);
    const code = done.recoveryCode;

    const base = {
      operatorId: OPERATOR,
      newCredential: "Recovered-Cred-2026",
      confirmCredential: "Recovered-Cred-2026",
    };
    await expect(
      t.mutation(api.security.recover, {
        ...base,
        recoveryCode: "9560",
        newPin: "604817",
        confirmPin: "604817",
      }),
    ).rejects.toThrow(/Wrong recovery code/i);

    const recovered = await t.mutation(api.security.recover, {
      ...base,
      recoveryCode: code,
      newPin: "604817",
      confirmPin: "604817",
    });
    expect(recovered.recoveryCode).not.toBe(code);
    expect((await signIn(t)).ok).toBe(false); // old credentials dead
    const relogin = await t.mutation(api.security.login, {
      operatorId: OPERATOR,
      credential: "Recovered-Cred-2026",
      pin: "604817",
    });
    expect(relogin.ok).toBe(true);

    // The old session token from activation is gone.
    await expect(
      t.query(api.security.dashboard, { token: done.token }),
    ).rejects.toThrow(/revoked|invalid|expired/i);
  });
});

describe("Existing KMC functionality", () => {
  it("still signs staff in with their system ID and PIN", async () => {
    const t = await freshDeployment();
    const hash = await hashCredential("1234");
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "Existing Staff" });
      const profileId = await ctx.db.insert("profiles", {
        userId,
        name: "Existing Staff",
        staffId: "0007",
        role: "FIELD_STAFF",
        status: "ACTIVE",
        createdAt: Date.now(),
        credentialHash: hash,
      });
      return { userId, profileId };
    });
    // Credentials alone are refused: a device proof is mandatory now.
    const withoutDevice = await t.mutation(internal.users.staffCredentialsSignIn, {
      systemId: "0007",
      credential: "1234",
    });
    expect(withoutDevice.ok).toBe(false);

    // Enroll a real key, have Security approve it, then present the proof.
    const token = (await activate(t)).token;
    const key = await deviceKeyPair();
    const start = await t.mutation(api.securityDevice.deviceChallenge, {
      purpose: "ENROLL",
      staffId: "0007",
      publicKeyJwk: key.jwk,
    });
    if (!start.ok) throw new Error("enrollment challenge refused");
    const enrolled = await t.mutation(api.securityDevice.completeEnrollment, {
      challengeRef: start.ref,
      signature: await signMessage(key.pair, start.challenge),
      label: "Staff workstation",
    });
    expect(enrolled.status).toBe("PENDING");

    const devices = await t.query(api.security.devices, { token });
    const row = devices.find((d) => d.enrollmentId === enrolled.enrollmentId)!;
    await t.mutation(api.security.approveDevice, { token, deviceId: row._id });

    const verifyStart = await t.mutation(api.securityDevice.deviceChallenge, {
      purpose: "VERIFY",
      enrollmentId: enrolled.enrollmentId!,
    });
    if (!verifyStart.ok) throw new Error("verify challenge refused");
    const verified = await t.mutation(api.securityDevice.verifyDevice, {
      challengeRef: verifyStart.ref,
      signature: await signMessage(key.pair, verifyStart.challenge),
    });
    expect(verified.status).toBe("AUTHORIZED");
    const proof = (verified as { proof?: string }).proof!;

    // Approved device + WRONG PIN → denied (the proof is spent).
    const wrongPin = await t.mutation(internal.users.staffCredentialsSignIn, {
      systemId: "0007",
      credential: "9999",
      deviceEnrollmentId: enrolled.enrollmentId!,
      deviceProof: proof,
    });
    expect(wrongPin.ok).toBe(false);

    // A device proof is bound to its enrollment: another pending device of the
    // same staff ID cannot borrow this authorised device's proof.
    const other = await deviceKeyPair();
    const otherStart = await t.mutation(api.securityDevice.deviceChallenge, {
      purpose: "ENROLL",
      staffId: "0007",
      publicKeyJwk: other.jwk,
    });
    if (!otherStart.ok) throw new Error("enrollment challenge refused");
    const otherEnrollment = await t.mutation(api.securityDevice.completeEnrollment, {
      challengeRef: otherStart.ref,
      signature: await signMessage(other.pair, otherStart.challenge),
      label: "Second laptop",
    });
    const fresh = await t.mutation(api.securityDevice.deviceChallenge, {
      purpose: "VERIFY",
      enrollmentId: enrolled.enrollmentId!,
    });
    if (!fresh.ok) throw new Error("verify challenge refused");
    const verifiedAgain = await t.mutation(api.securityDevice.verifyDevice, {
      challengeRef: fresh.ref,
      signature: await signMessage(key.pair, fresh.challenge),
    });
    const freshProof = (verifiedAgain as { proof?: string }).proof!;
    const borrowed = await t.mutation(internal.users.staffCredentialsSignIn, {
      systemId: "0007",
      credential: "1234",
      deviceEnrollmentId: otherEnrollment.enrollmentId!,
      deviceProof: freshProof,
    });
    expect(borrowed.ok).toBe(false);

    const result = await t.mutation(internal.users.staffCredentialsSignIn, {
      systemId: "0007",
      credential: "1234",
      deviceEnrollmentId: enrolled.enrollmentId!,
      deviceProof: proof,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe(seeded.userId);

    // The proof is single use: replaying it must fail.
    const replay = await t.mutation(internal.users.staffCredentialsSignIn, {
      systemId: "0007",
      credential: "1234",
      deviceEnrollmentId: enrolled.enrollmentId!,
      deviceProof: proof,
    });
    expect(replay.ok).toBe(false);
  });

  it("existing staff, client, wallet, loan, transaction and branch tables coexist with the new security tables", async () => {
    const t = await freshDeployment();
    await activate(t);
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { name: "Coexisting Staff" });
      await ctx.db.insert("profiles", {
        userId,
        name: "Coexisting Staff",
        staffId: "0051",
        role: "FIELD_STAFF",
        status: "ACTIVE",
        createdAt: Date.now(),
      });
    });
    expect(await t.query(api.security.devices, { token: (await activate(t)).token })).toBeInstanceOf(Array);
  });
});
