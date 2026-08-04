export function LockBanner({ holder }: { holder: string }) {
  return (
    <div className="rounded-md border border-[var(--status-pending)]/40 bg-[var(--status-pending)]/10 px-4 py-2 text-sm">
      Cet article est en cours d'édition par <strong>{holder}</strong>. Il est en lecture seule pour éviter d'écraser son travail.
    </div>
  );
}
