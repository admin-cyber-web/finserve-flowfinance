import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import type { ConvexCredentialsConfig } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import { AppError } from "../../lib/server/convexHelpers";

/**
 * System ID + PIN sign-in for admin-created staff (BRANCH_MANAGER,
 * FIELD_STAFF, ACCOUNTANT, SUPER_ADMIN — every non-CLIENT profile with a
 * configured credential).
 *
 * This is a standard Convex Auth credentials provider: on success the
 * library issues the SAME session/refresh/access tokens the email-OTP flow
 * uses, so there is only one authentication architecture in the app.
 *
 * All validation (system-ID lookup, account status, failed-attempt lockout,
 * credential hash verification) happens server-side in
 * `users.staffCredentialsSignIn` — the stored hash never leaves the server.
 * On failure that mutation throws, which fails this sign-in with the same
 * message; nothing demo/persona related is involved.
 */
export const staffCredentials: ConvexCredentialsConfig = ConvexCredentials({
  id: "staff-credentials",
  async authorize(credentials, ctx) {
    const systemId =
      typeof credentials.systemId === "string" ? credentials.systemId : "";
    const credential =
      typeof credentials.credential === "string" ? credentials.credential : "";
    const deviceEnrollmentId =
      typeof credentials.deviceEnrollmentId === "string"
        ? credentials.deviceEnrollmentId
        : "";
    const deviceProof =
      typeof credentials.deviceProof === "string" ? credentials.deviceProof : "";

    const result = await ctx.runMutation(
      internal.users.staffCredentialsSignIn,
      { systemId, credential, deviceEnrollmentId, deviceProof },
    );
    if (!result.ok) {
      // Thrown in the action (outside the mutation's transaction), so the
      // failed-attempt counter written above stays committed.
      throw new AppError(result.message);
    }
    return { userId: result.userId };
  },
});
