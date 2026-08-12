// Plan 012 — reusable brand lockup: monogram ("A" in the serif on the terracotta accent chip) +
// wordmark. Replaces the placeholder "A" square previously hardcoded in app-sidebar.tsx and gives
// the login page a real identity to build the editorial split-screen around. `variant="mark"` is the
// monogram alone (icon-mode sidebar, small-screen login); `variant="full"` adds the wordmark + tagline.
export function BrandMark({
  variant = "full",
  className,
}: {
  variant?: "full" | "mark";
  className?: string;
}) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-brand text-accent-brand-foreground font-heading text-lg font-semibold leading-none">
        A
      </span>
      {variant === "full" && (
        <span className="grid leading-tight">
          <span className="font-heading text-base font-semibold tracking-tight">Afrotiative</span>
          <span className="text-xs text-muted-foreground">Console éditoriale</span>
        </span>
      )}
    </span>
  );
}
