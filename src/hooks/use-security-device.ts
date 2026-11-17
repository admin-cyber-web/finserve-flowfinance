import { api } from "@/convex/_generated/api";
import {
  deviceDescriptor,
  ensureDeviceKey,
  getStoredIdentity,
  signChallenge,
  storeIdentity,
  type DeviceIdentity,
} from "@/lib/security/deviceCrypto";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";

/**
 * Orchestrates the cryptographic device handshake for the KMC login flow:
 * ensure a non-exportable key pair → ask for a server challenge → sign it →
 * enroll or verify on the backend.
 *
 * Nothing here decides authorization: the backend checks the signature and the
 * device status, and only an AUTHORIZED device receives a single-use proof.
 */

export type DeviceResultStatus =
  | "AUTHORIZED"
  | "PENDING"
  | "BLOCKED"
  | "REVOKED"
  | "REPLACED"
  | "REJECTED"
  | "UNKNOWN"
  | "NOT_ENROLLED"
  | "INVALID_SIGNATURE"
  | "UNVERIFIED";

export interface DeviceResult {
  status: DeviceResultStatus | "ERROR";
  message: string;
  enrollmentId?: string;
  proof?: string;
}

const errorMessage = (err: unknown): string => {
  if (!(err instanceof Error)) return "Device verification failed.";
  const raw = err.message;
  const match = raw.match(/Uncaught (?:Convex)?Error: ([^\n]*)/);
  return (match?.[1] ?? raw).replace(/^\[CONVEX[^\]]*\]\s*/, "").slice(0, 300);
};

export function useSecurityDevice() {
  const requestChallenge = useMutation(api.securityDevice.deviceChallenge);
  const completeEnrollment = useMutation(api.securityDevice.completeEnrollment);
  const verifyDevice = useMutation(api.securityDevice.verifyDevice);
  const [identity, setIdentity] = useState<DeviceIdentity | null>(() =>
    getStoredIdentity(),
  );

  const status = useQuery(
    api.securityDevice.deviceEnrollmentStatus,
    identity ? { enrollmentId: identity.enrollmentId } : "skip",
  );

  const enroll = useCallback(
    async (claim: { staffId?: string; staffEmail?: string }): Promise<DeviceResult> => {
      try {
        const keyPair = await ensureDeviceKey();
        const start = await requestChallenge({
          purpose: "ENROLL",
          staffId: claim.staffId,
          staffEmail: claim.staffEmail,
          publicKeyJwk: JSON.stringify(keyPair.publicKeyJwk),
        });
        if (!start.ok) {
          return {
            status: "ERROR",
            message:
              "This browser could not start device enrollment. Clearing site data can leave a stale key — try again or use another browser.",
          };
        }
        const signature = await signChallenge(start.challenge);
        const descriptor = deviceDescriptor();
        const done = await completeEnrollment({
          challengeRef: start.ref,
          signature,
          label: descriptor.label,
          platform: descriptor.platform,
          userAgent: descriptor.userAgent,
          browser: descriptor.browser,
          browserVersion: descriptor.browserVersion,
          os: descriptor.os,
          category: descriptor.category,
        });
        if (!done.ok) {
          return { status: "ERROR", message: "Device enrollment was not accepted." };
        }
        const next: DeviceIdentity = {
          enrollmentId: done.enrollmentId,
          staffId: start.enrolledStaffId ?? claim.staffId ?? "",
        };
        storeIdentity(next);
        setIdentity(next);
        return {
          status: (done.status as DeviceResultStatus) ?? "PENDING",
          message: done.message,
          enrollmentId: done.enrollmentId,
        };
      } catch (err) {
        return { status: "ERROR", message: errorMessage(err) };
      }
    },
    [completeEnrollment, requestChallenge],
  );

  const verify = useCallback(async (): Promise<DeviceResult> => {
    const current = identity ?? getStoredIdentity();
    if (!current) {
      return {
        status: "NOT_ENROLLED",
        message: "This browser is not enrolled with the Security Department.",
      };
    }
    try {
      const start = await requestChallenge({
        purpose: "VERIFY",
        enrollmentId: current.enrollmentId,
      });
      if (!start.ok) {
        // The backend no longer knows this enrollment (cleared/replaced).
        storeIdentity(null);
        setIdentity(null);
        return {
          status: "UNKNOWN",
          message: "This device is no longer enrolled. Enrollment is required.",
        };
      }
      const signature = await signChallenge(start.challenge);
      const result = await verifyDevice({
        challengeRef: start.ref,
        signature,
        userAgent: deviceDescriptor().userAgent,
      });
      return {
        status: result.status as DeviceResultStatus,
        message: result.message,
        proof: "proof" in result ? result.proof : undefined,
        enrollmentId: "enrollmentId" in result ? result.enrollmentId : undefined,
      };
    } catch (err) {
      return { status: "ERROR", message: errorMessage(err) };
    }
  }, [identity, requestChallenge, verifyDevice]);

  const forget = useCallback(() => {
    storeIdentity(null);
    setIdentity(null);
  }, []);

  return { identity, status, enroll, verify, forget };
}
