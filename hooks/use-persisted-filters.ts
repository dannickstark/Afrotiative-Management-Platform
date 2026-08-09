"use client";
import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Le suffixe de version permet d'invalider proprement le contenu mémorisé si la forme des
// filtres change un jour — un ancien « status=… » incompatible serait alors simplement ignoré.
export const QUEUE_FILTERS_KEY = "afrotiative.queue.filters.v1";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

// Toute lecture est enveloppée : localStorage lève en navigation privée sur certains
// navigateurs, et un échec doit dégrader vers « pas de restauration », jamais casser la page.
export function readStored(key: string, storage: ReadableStorage | null): string | null {
  if (!storage) return null;
  try {
    const v = storage.getItem(key);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string, storage: WritableStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Quota dépassé ou stockage refusé — la mémorisation est un confort, jamais une exigence.
  }
}

// On ne restaure que sur une arrivée NUE : une URL déjà porteuse de paramètres (partagée, mise
// en favori, ou produite en vidant les filtres) l'emporte toujours sur la mémoire.
export function shouldRestore(currentSearch: string, stored: string | null): boolean {
  return currentSearch.length === 0 && stored !== null && stored.length > 0;
}

/**
 * Miroir bidirectionnel entre les paramètres d'URL et localStorage.
 *
 * Le garde `restoredRef` limite la restauration à UNE fois par montage : sans lui, un
 * utilisateur qui remettrait volontairement l'URL à nu se verrait réimposer ses anciens filtres
 * en boucle. Combiné au fait que la barre de filtres écrit toujours `status`, l'action « vider
 * les filtres » produit une URL non vide et écrase donc bien la mémoire.
 */
export function usePersistedFilters(key: string): void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const restoredRef = useRef(false);

  useEffect(() => {
    const storage = typeof window === "undefined" ? null : window.localStorage;

    if (!restoredRef.current) {
      restoredRef.current = true;
      const stored = readStored(key, storage);
      if (shouldRestore(search, stored)) {
        // replace et non push : restaurer une préférence ne doit pas créer une entrée
        // d'historique dont le « Précédent » ramènerait sur la même page.
        router.replace(`${pathname}?${stored}`);
        return;
      }
    }

    if (search.length > 0) writeStored(key, search, storage);
  }, [key, search, pathname, router]);
}
