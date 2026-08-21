/** Numéro de prise suivant pour un beat : max+1, ou 1 si aucune prise. Ne comble pas les trous. */
export function nextTakeNumber(existing: number[]): number {
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

// Les seules transitions de statut wirées par SP4 (phase tournage). Tout le reste est refusé.
const TRANSITIONS: Record<string, string[]> = {
  en_ecriture: ["pret_a_tourner"],
  pret_a_tourner: ["tourne"],
  tourne: ["en_montage"],
};

export function estTransitionAutorisee(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}
