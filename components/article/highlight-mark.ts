import { Mark, mergeAttributes } from "@tiptap/core";
import { classForColor, colorForClass, type HighlightColor } from "@/lib/highlight";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    highlight: {
      setHighlight: (color: HighlightColor) => ReturnType;
      unsetHighlight: () => ReturnType;
    };
  }
}

export const HighlightMark = Mark.create({
  name: "highlight",
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => colorForClass((el as HTMLElement).getAttribute("class") ?? ""),
        renderHTML: (attrs) =>
          attrs.color ? { class: classForColor(attrs.color as HighlightColor) } : {},
      },
    };
  },
  parseHTML() {
    return [{
      tag: "mark",
      getAttrs: (el) => (colorForClass((el as HTMLElement).getAttribute("class") ?? "") ? {} : false),
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setHighlight: (color) => ({ commands }) => commands.setMark(this.name, { color }),
      unsetHighlight: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});
