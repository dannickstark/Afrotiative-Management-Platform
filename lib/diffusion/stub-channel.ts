// lib/diffusion/stub-channel.ts — D1 ships with ZERO real network adapters (spec: "socle de
// diffusion... zéro adaptateur réel"). Exactly like V1 shipped its render engine headless,
// StubChannel records a send WITHOUT calling any network: it logs, marks the send synthetic, and
// returns a fake externalId. This is what makes the whole socle (registry → panel → réessais →
// planificateur → audit, D1 Lots 2-4) verifiable end to end before a single real adapter exists.
// D2 → D6 each replace ONE channel's `send` (lib/diffusion/channels.ts) with a real adapter behind
// this SAME SendInput/SendResult contract — this file itself is not touched by that work.
import type { Channel } from "@/lib/studio";
import type { SendInput, SendResult } from "./channels";

export class StubChannel {
  constructor(private readonly channel: Channel) {}

  // No `fetch`, no I/O of any kind — the "no network call" test (tests/diffusion-channels.test.ts)
  // injects a fetch that throws if invoked, to prove this beyond just reading the source.
  async send(input: SendInput): Promise<SendResult> {
    const externalId = `stub-${this.channel}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const previewCaption = input.caption.length > 60 ? `${input.caption.slice(0, 60)}…` : input.caption;
    console.log(
      `[diffusion:stub] canal=${this.channel} article=${input.articleId} externalId=${externalId} ` +
      `légende="${previewCaption}" image=${input.imageUrl}`,
    );
    return { ok: true, externalId };
  }
}
