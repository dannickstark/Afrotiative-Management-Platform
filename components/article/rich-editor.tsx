"use client";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { EditorToolbar } from "./editor-toolbar";
import { HighlightMark } from "./highlight-mark";

// Constrained rich-text editor: bold, H2/H3, link, bullet & ordered lists only.
// `immediatelyRender: false` avoids Tiptap v3's SSR hydration-mismatch warning
// under Next.js (the editor mounts empty on the server, then hydrates content
// on the client).
//
// italic/strike/underline are disabled explicitly: StarterKit v3 registers all
// three by default, each with a keyboard shortcut (Cmd+I, Cmd+U, Cmd+Shift+S)
// and markdown input rules (*x*, ~~x~~) — so without disabling them a user
// could still produce those marks despite no toolbar button. link:false is
// also passed because StarterKit v3 bundles its own Link extension; leaving it
// on would duplicate the explicit @tiptap/extension-link below (Tiptap logs a
// "Duplicate extension names" warning and the duplicate can defeat
// openOnClick:false).
export function RichEditor({
  value,
  onChange,
  editable,
  allowHighlight,
  className,
}: {
  value: string;
  onChange: (html: string) => void;
  editable: boolean;
  allowHighlight?: boolean;
  className?: string;
}) {
  const editor = useEditor({
    editable, immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        blockquote: false, codeBlock: false, code: false, horizontalRule: false,
        italic: false, strike: false, underline: false, link: false,
      }),
      Link.configure({ openOnClick: false }),
      ...(allowHighlight ? [HighlightMark] : []),
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: {
        class:
          className ??
          "font-editorial prose prose-neutral dark:prose-invert max-w-none min-h-[420px] focus:outline-none",
      },
    },
  });
  if (!editor) return null;
  return (
    <div className="rounded-md border">
      {editable && <EditorToolbar editor={editor} allowHighlight={allowHighlight} />}
      <EditorContent editor={editor} className="p-4" />
    </div>
  );
}
