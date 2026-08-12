// lib/diffusion/send-core.ts — D1 §4/§7's `sendToChannel` core. NOT a "use server" module (same
// plain-core split as lib/studio/template-core.ts / lib/diffusion/settings-core.ts): only reachable
// through the guarded lib/actions/diffusion-actions.ts action, which attaches actorId from the
// session and never trusts a client-supplied one.
//
// The ORDER below is the point of Task 5 (spec §4/§7):
//   1. article.status === 'published' — the social card may carry {{article.url}} as a QR code,
//      and that URL only exists after WordPress publication (same ordering CONTEXT_TOKENS already
//      encodes for the render itself — lib/studio/tokens.ts).
//   2. channel enabled (social_channel_settings).
//   3. renderForArticle(articleId, {context:'social_post', channel}) — {ok:false} refuses with the
//      engine's message; {ok:true,url:null} ALSO refuses (a social post with no image is not a
//      thing this product does) — see lib/studio/index.ts's RenderForArticleResult.
//   4. insert/update the distributions row (renderId/caption/triggeredBy/actorId).
//   5. channel.send — success -> sent/sentAt/externalId; failure -> failed/attempts+1/lastError.
//   6. article_revisions entry, either way — the audit trail, mirroring lib/wp/publish.ts.
//
// renderId is written ONCE and never rewritten on retry (db/schema.ts's own comment on
// distributions.renderId): a distributions row only ever gets created AFTER step 3 has already
// succeeded, so an EXISTING row always already carries a renderId — a retry reuses that row (and
// therefore that renderId) and skips step 3 entirely, rather than re-rendering and overwriting it.
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db, articles, distributions, renders, articleRevisions } from "@/db";
import { renderForArticle, type Channel } from "@/lib/studio";
import type { RenderStore } from "@/lib/studio/store";
import { SOCIAL_CHANNELS, type SocialChannel } from "./channels";
import { getChannelSettings } from "./settings-core";

export type SendToChannelInput = {
  articleId: string;
  channel: Channel;
  caption: string;
  triggeredBy: "manual" | "scheduled";
  actorId: string | null;
  // Test-only overrides, threaded straight through to renderForArticle — same convention as
  // lib/wp/publish.ts's buildPublishPayload(renderStore) and renderForArticle's own `store`/
  // `fetchImpl` (lib/studio/index.ts). Gated on NODE_ENV === "test" below so a future production
  // caller cannot accidentally short-circuit real storage or the SSRF guard by supplying one.
  renderStore?: RenderStore;
  fetchImpl?: typeof fetch;
  // Test-only: every REGISTERED channel's `send` currently delegates to StubChannel, which always
  // succeeds (lib/diffusion/channels.ts) — there is no way to exercise the failure/retry path
  // through the real registry. Never supplied by production callers (the guarded action always
  // omits it, so SOCIAL_CHANNELS[channel] is used).
  channelOverride?: SocialChannel;
};

export type SendToChannelResult =
  | { ok: true; distributionId: string; renderId: string; imageUrl: string; sentAt: Date; externalId: string }
  | { ok: false; message: string };

type Distribution = typeof distributions.$inferSelect;

// Drizzle wraps driver errors in DrizzleQueryError, so the pg SQLSTATE lives on `.cause` — walk
// the cause chain. Mirrors lib/pipeline/run.ts's / lib/actions/pipeline-actions.ts's own local
// copy of the same helper (documented there as intentionally NOT a shared util).
function pgErrorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

async function latestDistribution(articleId: string, channel: Channel): Promise<Distribution | null> {
  const [row] = await db.select().from(distributions)
    .where(and(eq(distributions.articleId, articleId), eq(distributions.channel, channel)))
    .orderBy(desc(distributions.at))
    .limit(1);
  return row ?? null;
}

export async function sendToChannelCore(input: SendToChannelInput): Promise<SendToChannelResult> {
  const { articleId, channel, caption, triggeredBy, actorId } = input;
  const socialChannel = input.channelOverride ?? SOCIAL_CHANNELS[channel];
  const label = socialChannel.label;
  const renderStore = process.env.NODE_ENV === "test" ? input.renderStore : undefined;
  const fetchImpl = process.env.NODE_ENV === "test" ? input.fetchImpl : undefined;

  // 0. Available? Channels without a real adapter (StubChannel) must never reach send() — that
  //    would fabricate a "sent" distribution row with a fake externalId (plan 001's whole point).
  //    The UI already disables the button for these (computeSendDisabledReason), but this is the
  //    server-side backstop: reachable directly via the server action, or via the scheduler if an
  //    operator enables autoEnabled for one of these channels.
  if (!socialChannel.available) {
    return { ok: false, message: `Canal non disponible : aucun adaptateur réel.` };
  }

  // 1. Published?
  const [article] = await db.select({ status: articles.status }).from(articles).where(eq(articles.id, articleId));
  if (!article) return { ok: false, message: "Article introuvable." };
  if (article.status !== "published") {
    return { ok: false, message: "L'article doit d'abord être publié sur WordPress avant d'être diffusé sur les réseaux sociaux." };
  }

  // 2. Channel enabled?
  const settings = await getChannelSettings(channel);
  if (!settings.enabled) {
    return { ok: false, message: `Le canal ${label} est désactivé dans les réglages de diffusion.` };
  }

  const existing = await latestDistribution(articleId, channel);
  if (existing?.status === "sent") {
    return { ok: false, message: `Cet article a déjà été diffusé sur ${label}.` };
  }
  if (existing?.status === "pending") {
    return { ok: false, message: `Un envoi est déjà en cours pour ${label}.` };
  }

  // 3. Render — SKIPPED on retry. An existing row (necessarily 'failed' at this point — 'sent' and
  //    'pending' were refused above) can only exist because a PRIOR call already reached step 4,
  //    which only ever happens after step 3 succeeded — so existing.renderId is always already set.
  let renderId: string;
  let imageUrl: string;
  if (existing?.renderId) {
    const [render] = await db.select({ url: renders.url }).from(renders).where(eq(renders.id, existing.renderId));
    if (!render) {
      // Defensive only — no code path in this codebase ever deletes a renders row. Refuse rather
      // than silently re-rendering, which would break the "renderId never rewritten" guarantee
      // without telling anyone.
      return { ok: false, message: "Le visuel déjà généré pour cet envoi est introuvable. Contactez un administrateur." };
    }
    renderId = existing.renderId;
    imageUrl = render.url;
  } else {
    // Chantier D, Tâche 6 — `socialChannel.format` (lib/diffusion/channels.ts) est LE format que ce
    // canal attend (ex. "story" pour tiktok, "wa_square" pour whatsapp) : le gabarit résolu — qui
    // peut très bien être le gabarit PAR DÉFAUT du contexte, partagé par plusieurs canaux dont les
    // formats diffèrent — est désormais RELAYOUTÉ (relayoutToFormat, T2) vers CE format avant rendu,
    // au lieu d'être rendu à ses dimensions natives quel que soit le canal demandeur.
    const rendered = await renderForArticle(articleId, {
      context: "social_post", channel, store: renderStore, fetchImpl, format: socialChannel.format,
    });
    if (!rendered.ok) return { ok: false, message: rendered.message };
    if (rendered.url === null) {
      return {
        ok: false,
        message: `Aucun gabarit « post social » n'est configuré pour ${label}. Configurez-en un dans le Studio avant de diffuser.`,
      };
    }
    renderId = rendered.renderId;
    imageUrl = rendered.url;
  }

  // 4. Insert/update the distributions row, occupying the 'pending' slot BEFORE calling send() —
  //    this is what the distributions_one_active_per_article_channel partial unique index (D1 §1)
  //    actually protects: two concurrent sends racing to INSERT the first row for this
  //    (article, channel) can only have one winner, and a concurrent RETRY of the SAME failed row
  //    is closed off by the conditional UPDATE below (status <> 'pending').
  //
  //    Known limitation, not solved here (out of scope for D1 Lot 2): a process crash between this
  //    write and step 5's final status update would leave the row stuck at 'pending' forever,
  //    permanently blocking further retries with a "send already in progress" message. D1 Lot 4's
  //    scheduler groundwork would be the natural place for a staleness reaper, mirroring
  //    RUN_STALE_MINUTES for pipeline_runs.
  let distributionId: string;
  if (existing) {
    const [updated] = await db.update(distributions)
      .set({ renderId, caption, triggeredBy, actorId, status: "pending", at: new Date() })
      .where(and(eq(distributions.id, existing.id), ne(distributions.status, "pending")))
      .returning({ id: distributions.id });
    if (!updated) return { ok: false, message: `Un envoi est déjà en cours pour ${label}.` };
    distributionId = updated.id;
  } else {
    try {
      const [inserted] = await db.insert(distributions).values({
        articleId, channel, status: "pending", renderId, caption, triggeredBy, actorId,
      }).returning({ id: distributions.id });
      distributionId = inserted.id;
    } catch (e) {
      if (pgErrorCode(e) === "23505") {
        return { ok: false, message: `Un envoi est déjà en cours ou a déjà réussi pour ${label}.` };
      }
      throw e;
    }
  }

  // 5. Send.
  const sendResult = await socialChannel.send({ articleId, imageUrl, caption });

  let result: SendToChannelResult;
  if (sendResult.ok) {
    const sentAt = new Date();
    await db.update(distributions)
      .set({ status: "sent", sentAt, externalId: sendResult.externalId, lastError: null })
      .where(eq(distributions.id, distributionId));
    result = { ok: true, distributionId, renderId, imageUrl, sentAt, externalId: sendResult.externalId };
  } else {
    await db.update(distributions)
      .set({ status: "failed", attempts: sql`${distributions.attempts} + 1`, lastError: sendResult.message })
      .where(eq(distributions.id, distributionId));
    result = { ok: false, message: sendResult.message };
  }

  // 6. Audit trail — always, success or failure, mirroring lib/wp/publish.ts's own article_revisions writes.
  await db.insert(articleRevisions).values({
    articleId,
    actorId,
    action: sendResult.ok ? `diffusé sur ${label}` : `échec de diffusion sur ${label}`,
    detail: sendResult.ok ? null : sendResult.message,
  });

  return result;
}
