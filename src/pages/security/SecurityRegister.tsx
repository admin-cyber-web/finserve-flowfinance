/** Device registration page — opened by a single-use registration link.

 * 1. Validates the single-use, staff-bound registration token server-side.
 * 2. Generates a non-exportable ECDSA P-256 key in the browser.
 * 3. Requests a server ENROLL challenge bound to the link's intended staff ID.
 * 4. Signs the challenge and completes enrollment → a real PENDING device row
 *    with a cryptographic key fingerprint is created.
 * 5. Burns (marks USED) the registration link so it cannot be reused and logs
 *    the audit event.
 *
 * If any step fails, the user sees a clear, honest error — never a fake
 * "scan complete" or misleading security claim.
 */

import { useParams, useNavigate } from "react-router";
import { Loader2, ShieldCheck, ShieldAlert, ArrowRight } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState } from "react";
import { deviceDescriptor } from "@/lib/security/deviceCrypto";
import { deviceFingerprint } from "@/lib/security/client";
import { ensureDeviceKey, signChallenge } from "@/lib/security/deviceCrypto";

type Status =
  | "idle"
  | "validating"
  | "enrolling-key"
  | "requesting-challenge"
  | "signing"
  | "completing-enrollment"
  | "redeeming-link"
  | "done"
  | "error";

const stepLabel: Record<Status, string> = {
  idle: "Awaiting registration",
  validating: "Validating registration link…",
  "enrolling-key": "Preparing device key…",
  "requesting-challenge": "Requesting enrollment challenge…",
  signing: "Signing challenge…",
  "completing-enrollment": "Completing device enrollment…",
  "redeeming-link": "Burning registration link…",
  done: "Registration complete",
  error: "Registration failed",
};

export default function SecurityRegister() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);

  const validate = useQuery(
    api.securityAdmin.validateRegistrationToken,
    token && status !== "error" ? { token } : "skip",
  );
  const requestChallenge = useMutation(api.securityDevice.deviceChallenge);
  const completeEnrollment = useMutation(api.securityDevice.completeEnrollment);
  const redeem = useMutation(api.securityAdmin.redeemRegistrationLink);

  const run = async () => {
    if (!token) {
      setStatus("error");
      setMessage("No registration token provided.");
      return;
    }

    if (validate === undefined) {
      // Still loading the link state — do not treat this as an error or
      // navigate away. Waiting for the query to resolve avoids the mount race
      // where the page briefly sees `undefined` and re-renders.
      return;
    }
    if (!validate) {
      setStatus("error");
      setMessage("Could not reach the Security Department. Try again.");
      return;
    }

    setStatus("validating");
    setMessage(null);
    setEnrollmentId(null);

    if (validate.status !== "UNUSED") {
      setStatus("error");
      setMessage(
        `This registration link has already been ${validate.status.toLowerCase()}. Ask SUPER_ADMIN for a new link.`,
      );
      return;
    }
    if (validate.expiresAt <= Date.now()) {
      setStatus("error");
      setMessage("This registration link has expired. Ask SUPER_ADMIN for a new link.");
      return;
    }

    // 2. Obtain a non-exportable device key (once per browser, stored in the
    //    security device store).  Nothing here grants access — it just prepares
    //    the browser to prove possession of a key during enrollment.
    setStatus("enrolling-key");
    let keyPair;
    try {
      keyPair = await ensureDeviceKey();
    } catch (err) {
      setStatus("error");
      setMessage(
        err instanceof Error
          ? err.message
          : "This browser could not prepare a device key. Try a different browser or clear site data.",
      );
      return;
    }

    // 3. Request an ENROLL challenge bound to the link's intended staff ID and
    //    the public key we just generated.  The backend looks up the staff
    //    account and rate-limits enrollment per staff ID.
    setStatus("requesting-challenge");
    let challenge;
    try {
      challenge = await requestChallenge({
        purpose: "ENROLL",
        staffId: validate.staffId,
        publicKeyJwk: JSON.stringify(keyPair.publicKeyJwk),
      });
    } catch (err) {
      setStatus("error");
      setMessage(
        err instanceof Error
          ? err.message
          : "Could not request a device enrollment challenge.",
      );
      return;
    }

    if (!challenge.ok) {
      setStatus("error");
      setMessage(
        challenge.reason === "unknown-device"
          ? "The Security Department does not recognize this enrollment request. Ask SUPER_ADMIN to regenerate the registration link."
          : "Device enrollment challenge was refused.",
      );
      return;
    }

    // 4. Sign the server challenge with the private key and complete enrollment.
    setStatus("signing");
    let signature;
    try {
      signature = await signChallenge(challenge.challenge);
    } catch (err) {
      setStatus("error");
      setMessage(
        err instanceof Error
          ? err.message
          : "This browser could not sign the device challenge.",
      );
      return;
    }

    setStatus("completing-enrollment");
    let enrollment;
    try {
      const descriptor = deviceDescriptor();
      enrollment = await completeEnrollment({
        challengeRef: challenge.ref,
        signature,
        label: `${challenge.enrolledStaffId ?? validate.staffId} device`,
        platform: descriptor.platform,
        browser: descriptor.browser,
        browserVersion: descriptor.browserVersion,
        os: descriptor.os,
        category: descriptor.category,
        userAgent: descriptor.userAgent,
        ip: undefined,
      });
    } catch (err) {
      setStatus("error");
      setMessage(
        err instanceof Error
          ? err.message
          : "Device enrollment was not accepted by the Security Department.",
      );
      return;
    }

    if (!enrollment.ok) {
      setStatus("error");
      setMessage(
        "Device enrollment was not accepted. Try again or ask SUPER_ADMIN to regenerate the link.",
      );
      return;
    }

    setEnrollmentId(enrollment.enrollmentId);

    // 5. Burn the registration link (mark USED) and log the event.  This is the
    //    step that makes the link single-use: after this the link status is USED
    //    and any further attempt fails validation.
    setStatus("redeeming-link");
    try {
      const descriptor = deviceDescriptor();
      const result = await redeem({
        token,
        deviceId: enrollment.enrollmentId as any,
        fingerprint: deviceFingerprint(),
        label: `${challenge.enrolledStaffId ?? validate.staffId} device`,
        platform: descriptor.platform,
        browser: descriptor.browser,
        browserVersion: descriptor.browserVersion,
        os: descriptor.os,
        category: descriptor.category,
        userAgent: descriptor.userAgent,
        ip: undefined,
      });

      if (!result.ok) {
        setStatus("error");
        setMessage(result.message ?? "The registration link could not be redeemed.");
        return;
      }

      setStatus("done");
      setMessage(
        `Device registered as "${challenge.enrolledStaffId ?? validate.staffId} device". ` +
          `Enrollment ID: ${enrollmentId}. ` +
          `Awaiting Security Department approval.`,
      );
    } catch (err) {
      // Enrollment succeeded, but link redemption failed (likely already used).
      setStatus("error");
      setMessage(
        err instanceof Error
          ? err.message
          : "The device was enrolled, but the registration link could not be redeemed. The link may have been used already — ask SUPER_ADMIN to check and regenerate it.",
      );
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0a0c0f] p-6">
      <div className="mx-auto w-full max-w-md border border-[#1f232a] bg-[#0b0d10] p-8">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-[#1c0808] text-[#f87171]">
          <ShieldAlert className="size-6" />
        </div>
        <p className="text-center text-[10px] font-black uppercase tracking-[0.2em] text-zinc-600">
          Independent Security Department
        </p>
        <h1 className="mt-3 text-center text-lg font-black uppercase tracking-wide text-zinc-50">
          Register This Device
        </h1>
        <p className="mt-2 text-center text-xs text-zinc-400">
          Use the single-use link SUPER_ADMIN sent you to enroll this device.
        </p>

        {status === "idle" && (
          <div className="mt-6 space-y-3 text-center">
            <p className="text-xs text-zinc-500">
              This link is single-use and time-limited. Once used, it cannot be reused.
            </p>
            <button
              onClick={run}
              className="inline-flex items-center justify-center gap-2 border border-[#b91c1c] bg-[#dc2626] px-6 py-2 text-xs font-black uppercase tracking-wider text-white hover:bg-[#b91c1c] transition"
            >
              <ShieldCheck className="size-3" />
              Register this device
            </button>
          </div>
        )}

        {(status === "validating" ||
          status === "enrolling-key" ||
          status === "requesting-challenge" ||
          status === "signing" ||
          status === "completing-enrollment" ||
          status === "redeeming-link") && (
          <div className="mt-6 flex flex-col items-center gap-3 text-center">
            <Loader2 className="size-5 animate-spin text-[#dc2626]" />
            <p className="text-xs text-zinc-400">{stepLabel[status]}</p>
          </div>
        )}

        {status === "done" && (
          <div className="mt-6 border border-[#2c2f36] bg-[#0a0c0f] p-4 text-center">
            <div className="mx-auto mb-3 flex size-8 items-center justify-center rounded-full bg-[#0a0c0f] text-[#4ade80]">
              <ShieldCheck className="size-4" />
            </div>
            <p className="text-sm font-semibold text-zinc-200">{message}</p>
            {enrollmentId && (
              <p className="mt-2 font-mono text-[10px] text-zinc-500 break-all">
                {enrollmentId}
              </p>
            )}
            <p className="mt-2 text-xs text-zinc-500">
              This request is pending. Contact the Security Department to approve it or use the Security Command Center.
            </p>
            <button
              onClick={() => navigate("/security")}
              className="mt-4 inline-flex items-center justify-center gap-2 border border-zinc-700 bg-white px-4 py-2 text-xs font-black uppercase tracking-wider text-zinc-800 hover:bg-zinc-100 transition"
            >
              <ArrowRight className="size-3" />
              Back to Security Command Center
            </button>
          </div>
        )}

        {status === "error" && (
          <div className="mt-6 border border-[#b91c1c]/50 bg-[#1b0808] p-4 text-center">
            <ShieldAlert className="mx-auto mb-2 size-5 text-[#fca5a5]" />
            <p className="text-sm text-[#fca5a5]">{message}</p>
            <button
              onClick={() => navigate("/security")}
              className="mt-4 inline-flex items-center justify-center gap-2 border border-zinc-700 bg-white px-4 py-2 text-xs font-black uppercase tracking-wider text-zinc-800 hover:bg-zinc-100 transition"
            >
              <ArrowRight className="size-3" />
              Back to Security Command Center
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
