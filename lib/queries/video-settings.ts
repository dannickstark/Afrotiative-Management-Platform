import { db, videoSettings } from "@/db";
import { DEFAULT_BRIEF_TEMPLATE } from "@/lib/video/brief";
import { DEFAULT_WPM } from "@/lib/video/duration";

// Ligne unique, créée à la volée : le module reste utilisable sur une base non semée (déploiement
// neuf, base de test), sans exiger une étape de seed préalable.
export async function getVideoSettings(): Promise<{ briefTemplate: string; wordsPerMinute: number }> {
  const rows = await db.select().from(videoSettings).limit(1);
  if (rows[0]) return { briefTemplate: rows[0].briefTemplate, wordsPerMinute: rows[0].wordsPerMinute };
  const [created] = await db
    .insert(videoSettings)
    .values({ briefTemplate: DEFAULT_BRIEF_TEMPLATE, wordsPerMinute: DEFAULT_WPM })
    .returning();
  return { briefTemplate: created.briefTemplate, wordsPerMinute: created.wordsPerMinute };
}
