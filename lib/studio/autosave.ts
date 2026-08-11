// lib/studio/autosave.ts — contrôleur d'enregistrement automatique en différé (Tâche 9, spec §3).
//
// PUR au sens de hooks/use-layer-drag.ts:createGestureEngine — aucune dépendance à React ni au DOM,
// donc testable directement sous `bun test` sans monter de composant (voir tests/studio-autosave.test.ts
// et la même convention documentée en tête de hooks/use-layer-drag.ts : « pas de DOM dans bun test »).
// components/studio/editor-shell.tsx (Tâche 9) ne fait qu'appeler notifyChange() à chaque scène
// produite par le réducteur, dans un useEffect, et refléter getState() dans son JSX.
//
// `delayMs` est un paramètre injectable (comme lib/pipeline/timeout.ts:withTimeout) : la production
// utilise le défaut de la spec (1500 ms), les tests injectent une valeur courte pour rester rapides
// sans réimplémenter d'horloge factice.
export type SaveStatus = "idle" | "saving" | "saved" | "error";

export type SaveResult = { ok: true } | { ok: false; message: string };

export interface AutosaveState {
  status: SaveStatus;
  message: string | null;
  // « sale » : le serveur ne détient PAS encore la dernière valeur notifiée — soit parce qu'un
  // enregistrement est en attente/en cours, soit parce que le dernier enregistrement a échoué. Ne
  // redevient false QUE sur un enregistrement RÉUSSI de la valeur la plus récente.
  dirty: boolean;
}

export interface AutosaveOptions<T> {
  save: (value: T) => Promise<SaveResult>;
  delayMs?: number;
  onChange?: (state: AutosaveState) => void;
}

export interface AutosaveController<T> {
  /** Notifie un changement de valeur : (ré)arme le différé. N appels rapprochés ne produisent
   * qu'UN SEUL appel à `save`, avec la DERNIÈRE valeur notifiée. */
  notifyChange(value: T): void;
  /** Force l'enregistrement immédiat de la valeur en attente (annule le différé), et ATTEND tout
   * enregistrement déjà en cours avant de le faire. `null` si rien n'était en attente. Utilisé par
   * *Publier* (spec §3 : la publication doit voir le tout dernier brouillon, pas un instantané
   * périmé par le différé encore en attente). */
  flush(): Promise<SaveResult | null>;
  /** Tâche 7 (U1, spec §8) : ré-attaque EXACTEMENT la même valeur que le DERNIER enregistrement en
   * échec, SANS exiger de nouvelle notification (`notifyChange`) entre-temps — c'est le défaut
   * différé de V2 que components/studio/save-indicator.tsx ferme (« Échec — réessayer »). Réutilise
   * runPendingSave(), le MÊME chemin qu'un enregistrement déclenché par le différé ou par flush(),
   * plutôt que d'appeler `opts.save` une seconde fois depuis un endroit séparé. `null` si l'état
   * courant n'est PAS "error" (rien à réessayer) — un double-clic sur *Réessayer* après un succès
   * entre-temps, par exemple, ne redéclenche donc rien. */
  retry(): Promise<SaveResult | null>;
  getState(): AutosaveState;
  /** Annule tout différé en attente sans enregistrer — démontage du composant. */
  destroy(): void;
}

const INITIAL_STATE: AutosaveState = { status: "idle", message: null, dirty: false };

export function createAutosaveController<T>(opts: AutosaveOptions<T>): AutosaveController<T> {
  const delayMs = opts.delayMs ?? 1500;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingValue: T | undefined;
  let hasPending = false;
  let inFlight: Promise<SaveResult> | null = null;
  let state: AutosaveState = INITIAL_STATE;

  function setState(patch: Partial<AutosaveState>) {
    state = { ...state, ...patch };
    opts.onChange?.(state);
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // Lance RÉELLEMENT un enregistrement de la valeur actuellement en attente. N'est appelée que
  // depuis fireTimer() (jamais deux fois en concurrence : voir sa garde `if (inFlight) return`) et
  // depuis flush() (qui attend déjà tout `inFlight` avant de s'en servir) — un seul enregistrement
  // en vol à la fois, toujours.
  function runPendingSave(): Promise<SaveResult> {
    const value = pendingValue as T;
    hasPending = false;
    setState({ status: "saving" });

    const p = (async (): Promise<SaveResult> => {
      try {
        return await opts.save(value);
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Erreur inconnue." };
      }
    })();

    inFlight = p;
    void p.then((res) => {
      inFlight = null;
      if (res.ok) {
        // Un changement plus récent a pu arriver PENDANT cet enregistrement (hasPending redevenu
        // true par un notifyChange concurrent) : le serveur ne détient alors PAS encore la toute
        // dernière valeur, donc `dirty` doit rester true et un nouveau cycle doit être programmé —
        // sans quoi cette dernière modification ne serait jamais enregistrée.
        setState(hasPending ? { status: "idle", message: null } : { status: "saved", message: null, dirty: false });
        if (hasPending) armTimer();
      } else {
        // Échec : NE PAS effacer `dirty` — c'est exactement la garantie testée par
        // tests/studio-autosave.test.ts (« un enregistrement en échec … n'efface pas l'état sale »).
        setState({ status: "error", message: res.message, dirty: true });
      }
    });

    return p;
  }

  function fireTimer() {
    timer = null;
    if (inFlight) return; // un enregistrement est déjà en vol ; sa résolution reprogrammera si besoin
    if (!hasPending) return;
    void runPendingSave();
  }

  function armTimer() {
    clearTimer();
    timer = setTimeout(fireTimer, delayMs);
  }

  function notifyChange(value: T) {
    pendingValue = value;
    hasPending = true;
    setState({ dirty: true });
    armTimer();
  }

  async function flush(): Promise<SaveResult | null> {
    clearTimer();
    if (inFlight) await inFlight.catch(() => undefined);
    if (!hasPending) return null;
    return runPendingSave();
  }

  // `pendingValue` n'est JAMAIS effacée par runPendingSave() (voir plus haut : seul `hasPending`
  // repasse à false) — elle continue donc de porter la DERNIÈRE valeur tentée même après un échec.
  // C'est ce qui permet à retry() de rejouer runPendingSave() SANS qu'aucun appelant n'ait besoin de
  // repasser une valeur : `status === "error"` garantit qu'au moins un notifyChange() a eu lieu par
  // le passé (voir la documentation de l'interface), donc `pendingValue` est bien de type T ici,
  // jamais `undefined`.
  async function retry(): Promise<SaveResult | null> {
    if (state.status !== "error") return null;
    clearTimer();
    if (inFlight) await inFlight.catch(() => undefined);
    return runPendingSave();
  }

  function getState(): AutosaveState {
    return state;
  }

  function destroy() {
    clearTimer();
  }

  return { notifyChange, flush, retry, getState, destroy };
}
