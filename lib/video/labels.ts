// Libellés français des plateformes (enum `video_platform`, db/schema.ts). Sortis de
// components/video/project-list.tsx (round de correction 1, Task 5 du SP1 bis) : le brief remis à un
// agent MCP et celui affiché à l'humain se construisent désormais par la MÊME fonction
// (lib/queries/video.ts#briefVarsFor), qui est un module serveur sans rapport avec les composants —
// elle n'a pas à importer un fichier de rendu pour connaître un libellé.
export const PLATFORM_LABEL: Record<string, string> = {
  youtube_long: "YouTube long",
  youtube_short: "Short YouTube",
  tiktok: "TikTok",
  reel: "Reel",
  interview: "Interview",
};

export const BEAT_KIND_LABEL: Record<string, string> = {
  narration: "Narration", question: "Question", reponse: "Réponse", insert: "Insert",
  broll: "B-roll", transition: "Transition", texte_ecran: "Texte écran", son: "Son", note: "Note",
};

export const INSERT_KIND_LABEL: Record<string, string> = {
  image: "Image", video: "Vidéo", extrait: "Extrait", graphique: "Graphique", fichier: "Fichier",
};

export const LINK_STATUS_LABEL: Record<string, string> = {
  non_verifie: "À vérifier", ok: "OK", mort: "Mort", interdit: "Interdit",
};

export const TAKE_STATUS_LABEL: Record<string, string> = {
  bonne: "Bonne", mauvaise: "Mauvaise", a_revoir: "À revoir",
};
