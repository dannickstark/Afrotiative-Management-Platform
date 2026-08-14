// Réessai borné avec backoff exponentiel — pour les frontières I/O TRANSITOIRES (R2/S3 : socket
// reset, timeout, 5xx/429). aws4fetch (lib/storage/r2.ts) réessaie déjà les STATUTS HTTP 5xx/429,
// mais PAS une erreur réseau LEVÉE (`fetch` qui rejette) ; `putObject` s'en remet à ce helper pour
// combler ce trou — c'est la cause du message « le stockage R2 est momentanément indisponible » qui
// apparaissait « parfois » (asset-core.ts). PUR hors du `sleep` injectable (no-op en test → pas
// d'attente réelle, déterministe).

export type RetryOptions = {
  /** Nombre TOTAL de tentatives (≥ 1). Défaut 3. */
  attempts?: number;
  /** Backoff de base en ms ; le délai vaut `baseMs · 2^i · jitter`. Défaut 150. */
  baseMs?: number;
  /** Injecté par les tests (no-op) pour éliminer l'attente réelle. Défaut = `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Décide si une erreur levée est TRANSITOIRE (réessayable). Défaut : toujours réessayer. */
  shouldRetry?: (err: unknown) => boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function retryTransient<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const baseMs = opts.baseMs ?? 150;
  const sleep = opts.sleep ?? defaultSleep;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Dernière tentative, ou erreur permanente : on relance sans réessayer.
      if (i === attempts - 1 || !shouldRetry(e)) throw e;
      // Backoff exponentiel avec jitter (0.5–1.0×) pour ne pas synchroniser des réessais concurrents.
      const delay = baseMs * 2 ** i * (0.5 + Math.random() * 0.5);
      await sleep(delay);
    }
  }
  // Inatteignable (la boucle relance toujours à la dernière itération), mais TS veut un retour.
  throw lastErr;
}
