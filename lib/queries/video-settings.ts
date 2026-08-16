import { db, videoSettings } from "@/db";
import { DEFAULT_BRIEF_TEMPLATE } from "@/lib/video/brief";
import { DEFAULT_WPM } from "@/lib/video/duration";

// Source unique des champs projetés par getVideoSettings : un champ absent d'ici est un champ que
// personne ne lira jamais, quel que soit ce qui a été ajouté à la table (voir mcpEnabled).
export const VIDEO_SETTINGS_KEYS = ["briefTemplate", "wordsPerMinute", "mcpEnabled"] as const;

type VideoSettingsProjection = Pick<typeof videoSettings.$inferSelect, (typeof VIDEO_SETTINGS_KEYS)[number]>;

function project(row: typeof videoSettings.$inferSelect): VideoSettingsProjection {
  return {
    briefTemplate: row.briefTemplate,
    wordsPerMinute: row.wordsPerMinute,
    mcpEnabled: row.mcpEnabled,
  };
}

// Ligne unique, créée à la volée : le module reste utilisable sur une base non semée (déploiement
// neuf, base de test), sans exiger une étape de seed préalable.
export async function getVideoSettings(): Promise<VideoSettingsProjection> {
  const rows = await db.select().from(videoSettings).limit(1);
  if (rows[0]) return project(rows[0]);
  const [created] = await db
    .insert(videoSettings)
    .values({ briefTemplate: DEFAULT_BRIEF_TEMPLATE, wordsPerMinute: DEFAULT_WPM })
    .returning();
  return project(created);
}
