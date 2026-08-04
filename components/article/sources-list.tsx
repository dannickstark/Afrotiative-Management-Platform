import { ExternalLink } from "lucide-react";

// Read-only: sources are captured by the pipeline (SP3), not hand-edited
// here. Rendered exactly as they'll appear in the article footer.
export function SourcesList({ sources }: { sources: { mediaName: string; url: string }[] }) {
  if (sources.length === 0) {
    return <p className="text-xs text-muted-foreground">Aucune source.</p>;
  }
  return (
    <ul className="space-y-1">
      {sources.map((s) => (
        <li key={s.url}>
          <a
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-2 hover:underline"
          >
            {s.mediaName} <ExternalLink className="size-3 text-muted-foreground" />
          </a>
        </li>
      ))}
    </ul>
  );
}
