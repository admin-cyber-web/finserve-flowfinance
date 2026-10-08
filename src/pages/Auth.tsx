import { api } from "@/convex/_generated/api";
import { useMutation } from "convex/react";
import { useAuth } from "@/hooks/use-auth";
import { Logo } from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, Mail, ArrowRight, CreditCard, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

/* ---------------------------------------------------------------------------
 * Auth — real sign-in via email OTP only.
 *
 * Once the session is verified, profiles.linkByEmail attaches the workspace
 * profile (bootstrapping the SUPER ADMIN account on its first sign-in) and
 * the user goes straight to their role's dashboard. The demo persona,
 * workspace-selection and guest login paths were removed.
 * --------------------------------------------------------------------------- */

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirect(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) return returnTo;
  return fallback;
}

/** Convex surfaces thrown AppErrors with stack context — show only the message. */
function prettyError(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : "Sign-in failed. Please try again.";
  const match = raw.match(/Uncaught AppError: ([^\n]*)/);
  return match?.[1]?.trim() || raw;
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn, signOut } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirect(searchParams.get("returnTo"), redirectAfterAuth ?? "/dashboard");

  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [mode, setMode] = useState<"email" | "system">("email");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linkProfile = useMutation(api.profiles.linkByEmail);

  // Real authentication only: once a session exists, link it to its
  // workspace profile and go straight to the destination dashboard.
  // No persona/workspace selection step exists anywhere in this flow.
  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await linkProfile({});
        if (cancelled) return;
        if (result.ok) {
          navigate(redirect);
          return;
        }
        setStep("signIn");
        setError(
          result.reason === "no-workspace"
            ? "No account is registered for this email. Ask your administrator to create your user."
            : "This sign-in has no verified email address. Use the email your administrator registered.",
        );
        await signOut();
      } catch (err) {
        if (cancelled) return;
        setStep("signIn");
        setError(
          err instanceof Error ? err.message : "Sign-in could not be completed. Please try again.",
        );
        await signOut();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, isAuthenticated, linkProfile, navigate, redirect, signOut]);

  const signInEmail = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      setStep({ email: formData.get("email") as string });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to send verification code. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  // System ID + PIN sign-in for admin-created staff. Reuses the same Convex
  // Auth session as email OTP — on success the link effect above attaches the
  // profile and routes by the user's actual role (no persona/workspace step).
  const signInSystem = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("staff-credentials", {
        systemId: String(formData.get("systemId") ?? ""),
        credential: String(formData.get("credential") ?? ""),
      });
    } catch (err) {
      setError(prettyError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const submitOtp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      // Navigation happens in the link effect above, after the session has
      // been attached to its workspace profile.
      await signIn("email-otp", formData);
    } catch {
      setError("The verification code you entered is incorrect.");
      setOtp("");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper">
      {/* Top ink bar — neobrutalist framing */}
      <div className="border-b-2 border-ink bg-navy px-4 py-3 sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <Logo className="text-paper" />
          <p className="text-[11px] font-bold uppercase tracking-widest text-gold">
            FinServe — Empowering Growth Together
          </p>
        </div>
      </div>

      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg">
          {/* Eyebrow */}
          <div className="mb-4 flex items-center justify-center gap-2 text-[11px] font-black uppercase tracking-widest text-muted-foreground">
            <span className="size-2 animate-pulse-block bg-gold" />
            Secure staff sign-in
            <span className="size-2 animate-pulse-block bg-gold" />
          </div>

          <Card className="border-2 border-ink bg-card shadow-hard">
            {step === "signIn" ? (
              <>
                <CardHeader className="text-center border-b-2 border-ink">
                  <CardTitle className="text-xl font-black uppercase tracking-tight">
                    Welcome back
                  </CardTitle>
                  <CardDescription className="text-sm font-semibold">
                    {mode === "email"
                      ? "Sign in with the email registered to your account."
                      : "Staff sign-in with your System ID and PIN."}
                  </CardDescription>
                </CardHeader>

                <CardContent className="space-y-5 pt-5">
                  {/* Sign-in method tabs */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setMode("email");
                        setError(null);
                      }}
                      className={`border-2 border-ink px-3 py-2 text-[11px] font-black uppercase tracking-widest shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none ${
                        mode === "email" ? "bg-navy text-paper" : "bg-white"
                      }`}
                    >
                      Email code
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMode("system");
                        setError(null);
                      }}
                      className={`border-2 border-ink px-3 py-2 text-[11px] font-black uppercase tracking-widest shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none ${
                        mode === "system" ? "bg-navy text-paper" : "bg-white"
                      }`}
                    >
                      System ID + PIN
                    </button>
                  </div>

                  {mode === "email" ? (
                    <>
                      {/* Email OTP */}
                      <form onSubmit={signInEmail}>
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                            <Input
                              name="email"
                              placeholder="you@finserve.in"
                              type="email"
                              className="pl-9 h-12"
                              disabled={isLoading}
                              required
                            />
                          </div>
                          <Button type="submit" size="icon" disabled={isLoading}>
                            {isLoading ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <ArrowRight className="size-4" />
                            )}
                          </Button>
                        </div>
                        {error && (
                          <p className="mt-2 text-sm font-bold text-danger">{error}</p>
                        )}
                      </form>

                      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground text-center">
                        We email you a one-time code — no passwords to remember.
                      </p>
                    </>
                  ) : (
                    <form onSubmit={signInSystem} className="space-y-3">
                      <div className="relative">
                        <CreditCard className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                        <Input
                          name="systemId"
                          placeholder="System ID (e.g. BM-10002)"
                          className="pl-9 h-12 uppercase"
                          autoCapitalize="characters"
                          autoComplete="username"
                          disabled={isLoading}
                          required
                        />
                      </div>
                      <div className="relative">
                        <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                        <Input
                          name="credential"
                          type="password"
                          placeholder="PIN / password"
                          className="pl-9 h-12"
                          autoComplete="current-password"
                          disabled={isLoading}
                          required
                        />
                      </div>
                      {error && (
                        <p className="text-sm font-bold text-danger">{error}</p>
                      )}
                      <Button
                        type="submit"
                        className="w-full h-12 shadow-hard-sm uppercase"
                        disabled={isLoading}
                      >
                        {isLoading ? (
                          <>
                            <Loader2 className="mr-2 size-4 animate-spin" />
                            Signing in…
                          </>
                        ) : (
                          <>
                            Sign in
                            <ArrowRight className="ml-2 size-4" />
                          </>
                        )}
                      </Button>
                      <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground text-center">
                        Your System ID and PIN are issued by your administrator.
                      </p>
                    </form>
                  )}
                </CardContent>
              </>
            ) : (
              <>
                <CardHeader className="text-center border-b-2 border-ink">
                  <CardTitle className="text-xl font-black uppercase tracking-tight">
                    Check your email
                  </CardTitle>
                  <CardDescription className="text-sm font-semibold">
                    We sent a code to {step.email}
                  </CardDescription>
                </CardHeader>

                <form onSubmit={submitOtp}>
                  <CardContent className="space-y-4 pt-4">
                    <input type="hidden" name="email" value={step.email} />
                    <input type="hidden" name="code" value={otp} />

                    <div className="flex justify-center">
                      <Input
                        value={otp}
                        onChange={(e) => setOtp(e.target.value.replace(/[^\d]/g, ""))}
                        maxLength={6}
                        disabled={isLoading}
                        className="h-14 text-center text-2xl font-black tracking-[0.5em] font-mono"
                        inputMode="numeric"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && otp.length === 6 && !isLoading) {
                            (e.target as HTMLElement).closest("form")?.requestSubmit();
                          }
                        }}
                      />
                    </div>

                    {error && (
                      <p className="text-sm font-bold text-danger text-center">{error}</p>
                    )}

                    <p className="text-center text-xs font-bold uppercase tracking-widest text-muted-foreground">
                      Did not receive a code?{" "}
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-royal font-black"
                        onClick={() => setStep("signIn")}
                      >
                        Try again
                      </Button>
                    </p>
                  </CardContent>

                  <CardContent className="flex flex-col gap-2 pb-4">
                    <Button
                      type="submit"
                      className="w-full h-12 shadow-hard-sm uppercase"
                      disabled={isLoading || otp.length !== 6}
                    >
                      {isLoading ? (
                        <>
                          <Loader2 className="mr-2 size-4 animate-spin" />
                          Verifying…
                        </>
                      ) : (
                        <>
                          Verify code
                          <ArrowRight className="ml-2 size-4" />
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full h-12 uppercase"
                      onClick={() => setStep("signIn")}
                      disabled={isLoading}
                    >
                      Use a different email
                    </Button>
                  </CardContent>
                </form>
              </>
            )}
          </Card>

          {/* Footer note */}
          <div className="mt-4 border-t-2 border-ink bg-muted/40 px-4 py-3 text-center">
            <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Every sign-in is email-verified and authorized by role on the server.
            </p>
            <p className="mt-1 text-[10px] font-medium text-muted-foreground">
              Field staff run offline-ready collections, cash handovers and receipts.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return <Auth {...props} />;
}
