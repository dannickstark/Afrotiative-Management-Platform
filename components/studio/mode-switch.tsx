"use client";

import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { isModeToggleShortcut, toggleMode, type StudioMode } from "@/lib/studio/studio-mode";

// components/studio/mode-switch.tsx — Tâche 5 (U1, spec §5) : le contrôle segmenté flottant,
// centré au-dessus du canevas, présent dans les DEUX états (« Montage ⇄ Rendu réel »). Le raccourci
// clavier « R » est un écouteur DOCUMENT (window), comme editor-shell.tsx:COLLAPSE_PANEL_KEY (⌘/,
// Tâche 1) — mais toute la DÉCISION (faut-il basculer ?) vit dans isModeToggleShortcut,
// lib/studio/studio-mode.ts, une fonction PURE testée séparément (tests/studio-mode.test.ts) : ce
// composant ne fait que traduire l'événement RÉEL du navigateur en le littéral qu'elle attend.
export interface ModeSwitchProps {
  mode: StudioMode;
  onChange: (mode: StudioMode) => void;
  className?: string;
}

export function ModeSwitch({ mode, onChange, className }: ModeSwitchProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const shortcutEvent = {
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        target: target ? { tagName: target.tagName, isContentEditable: target.isContentEditable } : null,
      };
      if (!isModeToggleShortcut(shortcutEvent)) return;
      e.preventDefault();
      onChange(toggleMode(mode));
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, onChange]);

  // Correctif revue finale (Minor) : `role="tablist"`/`role="tab"` promettait une sémantique de tabs
  // (tabpanel associé via `aria-controls`, flèches gauche/droite pour naviguer, `aria-selected`) que
  // ce contrôle ne tient PAS — il ne pilote aucun `tabpanel` (Montage/Rendu réel sont deux ARBRES DE
  // COMPOSANTS entièrement différents rendus par editor-shell.tsx, jamais deux panneaux d'un même
  // conteneur `role="tabpanel"`), et n'a jamais eu de gestion des flèches clavier. Un lecteur d'écran
  // annonçant « onglet » pour un contrôle qui n'en est pas un est PIRE que deux boutons ordinaires —
  // `role="radiogroup"` + `aria-pressed` (un groupe de bascules mutuellement exclusives, exactement
  // ce que ce contrôle EST réellement) ne prétend à aucune capacité absente.
  return (
    <div
      role="radiogroup"
      aria-label="Mode d'édition"
      data-testid="mode-switch"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border bg-background p-0.5 shadow-sm",
        className,
      )}
    >
      <button
        type="button"
        aria-pressed={mode === "montage"}
        data-action="mode-montage"
        onClick={() => onChange("montage")}
        className={cn(
          "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
          mode === "montage" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        Montage
      </button>
      <button
        type="button"
        aria-pressed={mode === "rendu"}
        data-action="mode-rendu"
        onClick={() => onChange("rendu")}
        className={cn(
          "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
          mode === "rendu" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        Rendu réel
      </button>
    </div>
  );
}
