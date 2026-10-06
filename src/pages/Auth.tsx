import { api } from "@/convex/_generated/api";
import { useMutation } from "convex/react";
import { useAuth } from "@/hooks/use-auth";
import { Logo } from "@/components/fs/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, Mail, ArrowRight, UserCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

/* ---------------------------------------------------------------------------
 * Auth — branded neobrutalist sign-in with one-click demo persona login.
 * Template paths (email-OTP + anonymous) are preserved; demo quick-login is
 * layered on top via api.profiles.attachPersona.
 * --------------------------------------------------------------------------- */

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirect(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) return returnTo;
  return fallback;
}

const DEMOS = [
  {
    persona: "admin",
    label: "Admin",
    hint: "admin@finserve.in",
    role: "SUPER_ADMIN",
    tone: "bg-navy text-paper",
  },
  {
    persona: "bm",
    label: "Branch Manager",
    hint: "bm@finserve.in",
    role: "BRANCH_MANAGER",
    tone: "bg-royal text-white",
  },
  {
    persona: "accountant",
    label: "Accountant",
    hint: "accounts@finserve.in",
    role: "ACCOUNTANT",
    tone: "bg-mint",
  },
  {
    persona: "staff",
    label: "Field staff",
    hint: "rahul@finserve.in · ST10025",
    role: "FIELD_STAFF",
    tone: "bg-gold text-ink",
  },
  {
    persona: "client",
    label: "Client",
    hint: "ramesh@client.finserve.in",
    role: "CLIENT",
    tone: "bg-sky",
  },
];

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirect(searchParams.get("returnTo"), redirectAfterAuth ?? "/dashboard");

  const [step, setStep] = useState<"signIn" | { email: string }>("signIn");
  const [otp, setOtp] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // After auth finishes, go to the intended destination.
  useEffect(() => {
    if (!authLoading && isAuthenticated) navigate(redirect);
  }, [authLoading, isAuthenticated, navigate, redirect]);

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

  const submitOtp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      await signIn("email-otp", formData);
      navigate(redirect);
    } catch {
      setError("The verification code you entered is incorrect.");
      setOtp("");
    } finally {
      setIsLoading(false);
    }
  };

  const guestLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await signIn("anonymous");
      navigate(redirect);
    } catch (err) {
      setError(`Failed to sign in as guest: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsLoading(false);
    }
  };

  const attachMutation = useMutation(api.profiles.attachPersona);

  const loginAsPersona = async (persona: string) => {
    setIsLoading(true);
    setError(null);
    try {
      await attachMutation({ persona, device: "demo-login" });
      navigate(redirect);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Demo sign-in failed. Try email OTP instead.",
      );
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
            Sign in to the demo workspace
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
                    Choose a quick demo login, or use email OTP.
                  </CardDescription>
                </CardHeader>

                <CardContent className="space-y-5">
                  {/* Demo quick logins */}
                  <div className="space-y-2">
                    <p className="text-[11px] font-black uppercase tracking-widest text-muted-foreground">
                      One-click demo roles
                    </p>
                    <div className="grid grid-cols-1 gap-2">
                      {DEMOS.map((d) => (
                        <button
                          key={d.persona}
                          type="button"
                          onClick={() => loginAsPersona(d.persona)}
                          disabled={isLoading}
                          className={`flex w-full items-center justify-between gap-3 border-2 border-ink bg-white p-3 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-50 ${
                            isLoading ? "" : ""
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`inline-flex size-3 shrink-0 rounded-full border-2 border-ink bg-white ${d.tone.split(" ")[0]}`} />
                              <span className="text-sm font-black uppercase tracking-tight">{d.label}</span>
                            </div>
                            <p className="truncate text-[11px] font-mono font-bold text-muted-foreground">
                              {d.hint}
                            </p>
                          </div>
                          <ArrowRight className="shrink-0 size-4 stroke-[3]" />
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-ink/40" />
                    </div>
                    <div className="relative flex justify-center text-[11px] font-black uppercase tracking-widest">
                      <span className="bg-card px-2 text-muted-foreground">or</span>
                    </div>
                  </div>

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

                  <div className="space-y-3 pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full h-12 shadow-hard-sm uppercase"
                      onClick={guestLogin}
                      disabled={isLoading}
                    >
                      <UserCheck className="mr-2 size-4" />
                      Continue as guest
                    </Button>
                    <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground text-center">
                      Guest access skips the demo workspace
                    </p>
                  </div>
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
              Demo personas are pre-seeded with wallets, clients and loans.
            </p>
            <p className="mt-1 text-[10px] font-medium text-muted-foreground">
              Staff login runs offline-ready collections, cash handovers and receipts.
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
