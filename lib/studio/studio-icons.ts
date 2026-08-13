// lib/studio/studio-icons.ts — Chantier E, Tâche 5 : la convention d'icône PARTAGÉE du chrome
// studio — une taille et une graisse de trait UNIQUES, pour que le rail, l'inspecteur, les barres
// et le menu se ressemblent, plutôt que chaque composant ne redéclarant sa propre valeur ad hoc
// (`size-4` en dur ici, `size-3.5` là, le trait par défaut lucide — 2 — ailleurs). Icônes lucide
// INCHANGÉES : aucun nouveau dessin, seulement leur taille/trait unifiés.
//
// Module PUR (deux constantes, aucun React) — importable aussi bien par un composant client que par
// un futur test qui n'a pas besoin de monter de DOM pour vérifier son existence.
export const STUDIO_ICON = "size-4"; // 16px — taille de base des icônes d'action du studio
export const STUDIO_ICON_STROKE = 1.75; // graisse de trait cohérente (lucide défaut = 2)
