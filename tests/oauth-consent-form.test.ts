import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentForm } from "@/components/oauth/consent-form";

test("le formulaire affiche le nom du client et les deux axes, écriture cochée / articles non", () => {
  const html = renderToStaticMarkup(
    React.createElement(ConsentForm, { clientName: "Claude (web)", clientId: "c1", consentCode: "code1" }),
  );
  expect(html).toContain("Claude (web)");
  expect(html).toContain("Écriture");
  expect(html).toContain("Lire les articles");
  expect(html).toContain("Autoriser");
  expect(html).toContain("Refuser");
});
