import { publishArticle, unpublishArticle, republishArticle, type PublishResult, type ActionResult } from "./publish";

// Pluggable publish-target adapter (spec §5): WordPress today, other channels (WhatsApp/social —
// SP6) later, all driven through the same `distributions` table (channel + status + externalId).
// Each method operates on an articleId — the channel implementation is responsible for loading
// whatever it needs, mapping the payload, and recording the outcome in `distributions`.
export interface PublishChannel {
  publish(articleId: string, actorId?: string | null): Promise<PublishResult>;
  unpublish(articleId: string, actorId?: string | null): Promise<ActionResult>;
  republish(articleId: string, actorId?: string | null): Promise<ActionResult>;
}

// Delegates straight to lib/wp/publish.ts's functions — this class exists so callers can depend
// on the `PublishChannel` interface rather than the WordPress-specific functions directly.
export class WordPressChannel implements PublishChannel {
  publish(articleId: string, actorId?: string | null): Promise<PublishResult> {
    return publishArticle(articleId, actorId);
  }
  unpublish(articleId: string, actorId?: string | null): Promise<ActionResult> {
    return unpublishArticle(articleId, actorId);
  }
  republish(articleId: string, actorId?: string | null): Promise<ActionResult> {
    return republishArticle(articleId, actorId);
  }
}
