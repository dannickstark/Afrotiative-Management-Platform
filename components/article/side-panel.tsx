"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ImagePanel, type ImageFields } from "./image-panel";
import { CategorySelect } from "./category-select";
import { TagsInput, type ArticleTag } from "./tags-input";
import { SourcesList } from "./sources-list";
import { ExcerptField } from "./excerpt-field";
import { HistoryPanel } from "./history-panel";
import type { ArticleDetail } from "@/lib/queries/article";

const SECTION_LABEL = "mb-1.5 text-xs font-medium text-muted-foreground";

// Fixed right column of the editor. Composes every editable "metadata" field
// (image, category, tags, excerpt) plus two read-only sections (sources,
// history) in a vertical stack that scrolls independently from the main
// title/body column — EditorShell owns all of this state, this component
// only renders + delegates to setters.
export function SidePanel({
  article, image, onImageChange, categoryId, onCategoryChange, tags, onTagsChange, wpTagNames,
  excerpt, onExcerptChange, readOnly,
}: {
  article: ArticleDetail;
  image: ImageFields;
  onImageChange: (fields: ImageFields) => void;
  categoryId: string | null;
  onCategoryChange: (id: string | null) => void;
  tags: ArticleTag[];
  onTagsChange: (tags: ArticleTag[]) => void;
  wpTagNames: string[];
  excerpt: string;
  onExcerptChange: (v: string) => void;
  readOnly: boolean;
}) {
  return (
    <Card className="flex w-full shrink-0 flex-col overflow-hidden lg:w-80">
      <CardHeader>
        <CardTitle className="text-sm text-muted-foreground">Détails de l'article</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 space-y-5 overflow-y-auto">
        <section>
          <p className={SECTION_LABEL}>Image à la une</p>
          <ImagePanel {...image} onImageChange={onImageChange} readOnly={readOnly} />
        </section>

        <Separator />

        <section>
          <p className={SECTION_LABEL}>Catégorie</p>
          <CategorySelect categories={article.categories} categoryId={categoryId} onChange={onCategoryChange} readOnly={readOnly} />
        </section>

        <Separator />

        <section>
          <p className={SECTION_LABEL}>Tags</p>
          <TagsInput tags={tags} onChange={onTagsChange} wpTagNames={wpTagNames} readOnly={readOnly} />
        </section>

        <Separator />

        <section>
          <p className={SECTION_LABEL}>Chapô</p>
          <ExcerptField value={excerpt} onChange={onExcerptChange} readOnly={readOnly} />
        </section>

        <Separator />

        <section>
          <p className={SECTION_LABEL}>Sources</p>
          <SourcesList sources={article.sources} />
        </section>

        <Separator />

        <section>
          <p className={SECTION_LABEL}>Historique</p>
          <HistoryPanel revisions={article.revisions} />
        </section>
      </CardContent>
    </Card>
  );
}
