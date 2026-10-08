import { Button } from "@/components/ui/button";
import { Logo } from "@/components/fs/primitives";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper p-6">
      <div className="w-full max-w-md border-2 border-ink bg-card p-6 text-center shadow-hard">
        <div className="mx-auto mb-4 w-fit">
          <Logo />
        </div>
        <h1 className="mx-auto mb-3 text-lg font-black uppercase tracking-tight text-ink">
          Page not found
        </h1>
        <p className="mb-5 text-sm font-semibold text-muted-foreground">
          This page does not exist in FinServe.
        </p>
        <div className="flex flex-col gap-3">
          <Button className="w-full" onClick={() => (window.location.href = "/")}>
            Back to home
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => (window.location.href = "/auth")}
          >
            Sign in
          </Button>
        </div>
      </div>
    </main>
  );
}
