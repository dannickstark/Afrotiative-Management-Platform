import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { LoginForm } from "@/components/login-form";
import { BrandMark } from "@/components/shell/brand-mark";

// Plan 012 — editorial split-screen: a terracotta brand panel (hidden on small screens) paired with
// the form. Layout only — LoginForm keeps 100% of its auth logic (signIn, error handling) untouched.
export default async function LoginPage() {
  const s = await getSession();
  if (s?.user) redirect("/dashboard");
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-accent-brand p-10 text-accent-brand-foreground lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.12),transparent_55%),linear-gradient(160deg,rgba(0,0,0,0.18),transparent_60%)]"
        />
        <BrandMark variant="full" className="relative [&_*]:text-accent-brand-foreground" />
        <p className="relative font-heading max-w-sm text-3xl font-semibold leading-tight">
          L&apos;actualité africaine, orchestrée.
        </p>
        <p className="relative text-sm opacity-80">Console éditoriale interne</p>
      </aside>
      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6">
          <BrandMark variant="mark" className="lg:hidden" />
          <LoginForm />
        </div>
      </main>
    </div>
  );
}
