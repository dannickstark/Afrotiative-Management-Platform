import { db, distributions, renders } from "@/db";
import { desc, eq, inArray } from "drizzle-orm";
import { CHANNELS, type Channel } from "@/lib/studio";
import { SOCIAL_CHANNELS } from "@/lib/diffusion/channels";
import { getChannelSettings } from "@/lib/diffusion/settings-core";

export type DistributionRow = typeof distributions.$inferSelect;

// Every distribution row for one article, most recent first, across every channel (including
// 'wordpress') — the raw feed the Diffusion panel (D1 Lot 2, spec §4) groups per channel to show
// "jamais envoyé / envoyé le … / échec". No RBAC check here: like every other lib/queries/*.ts
// read (getFeeds, getTaxonomy, getPipelineSettings — see lib/queries/settings.ts), access is gated
// at the page/layout level, not inside the query itself.
export async function listDistributionsForArticle(articleId: string): Promise<DistributionRow[]> {
  return db.select().from(distributions)
    .where(eq(distributions.articleId, articleId))
    .orderBy(desc(distributions.at));
}

// One entry per ENABLED social channel (spec §4: "une carte par canal activé") — the Diffusion
// panel's server-side read (Task 6). getChannelSettings lazily creates a channel's settings row
// on first read (Task 3), so a channel nobody has ever visited /settings/social/[channel] for
// still shows up here with its registry defaults, exactly as settings-core.ts documents.
//
// `imageUrl` is resolved from `renders` for any channel whose latest distribution row already
// carries a renderId — the card's preview shows the FROZEN render that was (or will be, on retry)
// actually sent, never a fresh on-load render (spec §4: "L'envoi génère l'image à ce moment-là,
// pas avant" — rendering on every article-page view, for every enabled channel, would be exactly
// the "model call nobody asked for" cost Task 6 explicitly avoids for captions too).
export type ChannelDiffusionState = {
  channel: Channel;
  label: string;
  captionMaxChars: number;
  distribution: (DistributionRow & { imageUrl: string | null }) | null;
};

export async function getEnabledChannelsForArticle(articleId: string): Promise<ChannelDiffusionState[]> {
  const [rows, ...settingsList] = await Promise.all([
    listDistributionsForArticle(articleId),
    ...CHANNELS.map((c) => getChannelSettings(c)),
  ]);

  const byChannel = new Map<Channel, DistributionRow>();
  for (const row of rows) {
    if (row.channel === "wordpress") continue;
    // `rows` is most-recent-first (orderBy desc) and this codebase's sendToChannelCore only ever
    // keeps ONE row per (article, non-wordpress channel) — update-in-place on retry, refused past
    // a 'sent' row (lib/diffusion/send-core.ts) — but guard defensively with "first wins" in case
    // that invariant is ever relaxed (e.g. a future scheduler inserting its own row).
    if (!byChannel.has(row.channel as Channel)) byChannel.set(row.channel as Channel, row);
  }

  const renderIds = [...byChannel.values()].map((d) => d.renderId).filter((id): id is string => !!id);
  const renderRows = renderIds.length
    ? await db.select({ id: renders.id, url: renders.url }).from(renders).where(inArray(renders.id, renderIds))
    : [];
  const urlByRenderId = new Map(renderRows.map((r) => [r.id, r.url]));

  return CHANNELS
    .map((channel, i) => ({ channel, settings: settingsList[i] }))
    .filter(({ settings }) => settings.enabled)
    .map(({ channel, settings }) => {
      const distribution = byChannel.get(channel) ?? null;
      return {
        channel,
        label: SOCIAL_CHANNELS[channel].label,
        captionMaxChars: settings.captionMaxChars,
        distribution: distribution
          ? { ...distribution, imageUrl: distribution.renderId ? urlByRenderId.get(distribution.renderId) ?? null : null }
          : null,
      };
    });
}
