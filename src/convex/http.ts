import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

/**
 * Security Department sign-in edge.
 *
 * The portal posts here instead of calling the mutation directly so the
 * deployment edge can supply the real client IP (x-forwarded-for /
 * cf-connecting-ip). The mutation behind it is `internal`, so this is the only
 * way to get an IP-attributed attempt row. No cookies or CORS credentials are
 * used: the returned token is a bearer value the portal stores itself, which
 * keeps this endpoint unusable from a normal KMC staff session.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "600",
};

http.route({
  path: "/security/login",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })),
});

http.route({
  path: "/security/login",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ ok: false, message: "Invalid request body." }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
    const forwarded = request.headers.get("x-forwarded-for") ?? "";
    const ip =
      request.headers.get("cf-connecting-ip") ??
      forwarded.split(",")[0]?.trim() ??
      undefined;
    const result = await ctx.runMutation(internal.security.loginInternal, {
      operatorId: String(body.operatorId ?? ""),
      credential: String(body.credential ?? ""),
      pin: String(body.pin ?? ""),
      ip: ip || undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 401,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }),
});

export default http;
