// Couleur de marque utilisée quand une catégorie n'a pas de couleur propre. Isolée dans son propre
// module SANS AUCUN AUTRE IMPORT — contrairement à lib/studio/bindings.ts (qui importe @/db, donc
// le pool `pg`, côté Node uniquement) — pour rester importable depuis un composant "use client"
// (voir components/settings/taxonomy-tables.tsx, qui l'utilise pour la pastille de couleur) sans
// tirer la chaîne DB dans le bundle navigateur. lib/studio/bindings.ts réexporte cette même
// constante pour ne rien changer à son point d'import existant (tests/studio-bindings.test.ts).
export const DEFAULT_CATEGORY_COLOR = "#1B7F4A";
