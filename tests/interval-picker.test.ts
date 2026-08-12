import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntervalPicker } from "@/components/settings/interval-picker";

function render(value: number) {
  return renderToStaticMarkup(React.createElement(IntervalPicker, { value, onChange: () => {} }));
}

describe("IntervalPicker", () => {
  it("renders a preset value (6h) without throwing", () => {
    expect(() => render(6)).not.toThrow();
    expect(render(6)).toMatch(/heure/i);
  });

  it("shows the custom numeric input when value is not a preset", () => {
    const html = render(5); // 5 is not in [1,2,3,6,12,24]
    expect(html).toContain("5");
  });
});
