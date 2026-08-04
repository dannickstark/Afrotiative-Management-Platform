"use client";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { EditorToolbar } from "./editor-toolbar";

// Constrained rich-text editor: bold, H2/H3, link, bullet & ordered lists only.
// `immediatelyRender: false` avoids Tiptap v3's SSR hydration-mismatch warning
// under Next.js (the editor mounts empty on the server, then hydrates content
// on the client).
export function RichEditor({ value, onChange, editable }: { value: string; onChange: (html: string) => void; editable: boolean }) {
  const editor = useEditor({
    editable, immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, blockquote: false, codeBlock: false, code: false, horizontalRule: false }),
      Link.configure({ openOnClick: false }),
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: { attributes: { class: "font-editorial prose prose-neutral dark:prose-invert max-w-none min-h-[420px] focus:outline-none" } },
  });
  if (!editor) return null;
  return (
    <div className="rounded-md border">
      {editable && <EditorToolbar editor={editor} />}
      <EditorContent editor={editor} className="p-4" />
    </div>
  );
}
