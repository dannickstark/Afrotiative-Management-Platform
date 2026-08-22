"use client";
import { useEditorState, type Editor } from "@tiptap/react";
import { Bold, Eraser, Heading2, Heading3, Link2, List, ListOrdered } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HIGHLIGHT_COLORS } from "@/lib/highlight";

// Constrained toolbar: bold, H2, H3, link, bullet list, ordered list — nothing
// else (matches the StarterKit configuration in rich-editor.tsx, which
// disables blockquote/codeBlock/code/horizontalRule and limits headings to
// levels 2–3). The highlight palette (surlignage) is prop-gated by
// `allowHighlight` — only the video prompteur editor (beat-inspector.tsx)
// enables it; the article editor never passes the prop, so no palette shows.
export function EditorToolbar({ editor, allowHighlight }: { editor: Editor; allowHighlight?: boolean }) {
  // `useEditorState` subscribes to the editor's "transaction"/"update" events
  // directly, so the active-state highlights stay correct even for
  // selection-only changes (e.g. clicking into a heading) — a plain re-render
  // driven by the parent's onChange would miss those.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      h2: editor.isActive("heading", { level: 2 }),
      h3: editor.isActive("heading", { level: 3 }),
      link: editor.isActive("link"),
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
    }),
  });

  function setLink() {
    const previousUrl = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("URL du lien", previousUrl ?? "https://");
    if (url === null) return; // cancelled
    if (url.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  }

  const buttons: { label: string; active: boolean; onClick: () => void; icon: typeof Bold }[] = [
    { label: "Gras", active: state.bold, icon: Bold, onClick: () => editor.chain().focus().toggleBold().run() },
    { label: "Titre 2", active: state.h2, icon: Heading2, onClick: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Titre 3", active: state.h3, icon: Heading3, onClick: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: "Lien", active: state.link, icon: Link2, onClick: setLink },
    { label: "Liste à puces", active: state.bulletList, icon: List, onClick: () => editor.chain().focus().toggleBulletList().run() },
    { label: "Liste numérotée", active: state.orderedList, icon: ListOrdered, onClick: () => editor.chain().focus().toggleOrderedList().run() },
  ];

  return (
    <div className="flex items-center gap-1 border-b p-1.5">
      {buttons.map(({ label, active, onClick, icon: Icon }) => (
        <Button
          key={label}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(active && "bg-muted text-foreground")}
        >
          <Icon />
        </Button>
      ))}
      {allowHighlight && (
        <>
          <div className="mx-1 h-5 w-px bg-border" aria-hidden />
          {HIGHLIGHT_COLORS.map((couleur) => (
            <Button
              key={couleur}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Surligner ${couleur}`}
              aria-pressed={editor.isActive("highlight", { color: couleur })}
              onClick={() => editor.chain().focus().setHighlight(couleur).run()}
              className={cn(editor.isActive("highlight", { color: couleur }) && "bg-muted")}
            >
              <span className={cn("size-3.5 rounded-full border border-border/60", `hl-${couleur}`)} />
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Retirer le surlignage"
            onClick={() => editor.chain().focus().unsetHighlight().run()}
          >
            <Eraser />
          </Button>
        </>
      )}
    </div>
  );
}
