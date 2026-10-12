export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper p-6">
      <div className="w-full max-w-md border-2 border-ink bg-card p-6 text-center shadow-hard">
        <div className="mx-auto mb-4 w-fit">
          <span className="inline-flex items-center gap-2">
            <span className="grid size-9 place-items-center border-2 border-ink bg-gold font-black text-ink shadow-hard-sm">
              ₹
            </span>
            <span className="leading-none tracking-tight">
              <span className="block text-base font-black">KIRAT</span>
              <span className="block text-[10px] font-black uppercase tracking-[0.22em]">
                Micro Credit
              </span>
            </span>
          </span>
        </div>
        <h1 className="mx-auto mb-3 text-lg font-black uppercase tracking-tight text-ink">
          Page not found
        </h1>
        <p className="mb-5 text-sm font-semibold text-muted-foreground">
          This page does not exist in KIRAT MICRO CREDIT.
        </p>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            className="w-full border-2 border-ink bg-gold px-4 py-2.5 text-sm font-black uppercase tracking-wide shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none hover:bg-gold/90"
            onClick={() => (window.location.href = "/")}
          >
            Back to home
          </button>
          <button
            type="button"
            className="w-full border-2 border-ink bg-white px-4 py-2.5 text-sm font-black uppercase tracking-wide shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none hover:bg-muted"
            onClick={() => (window.location.href = "/auth")}
          >
            Sign in
          </button>
        </div>
      </div>
    </main>
  );
}
