import { describe, it, expect } from "bun:test";
import { sceneToElement } from "@/lib/studio/element";
import type { Scene } from "@/lib/studio/scene";

const base = { visible: true, locked: false };
const font = { family: "Noto Sans", size: 40, weight: 700 };

const scene: Scene = {
  schemaVersion: 1,
  canvas: { width: 1200, height: 675, background: "#101010" },
  layers: [
    { ...base, id: "bg", name: "Fond", frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "image", source: { kind: "url", url: "https://x.test/a.png" }, fit: "cover" },
    { ...base, id: "bar", name: "Bordure", frame: { x: 0, y: 0, w: 1200, h: 675 },
      type: "shape", shape: "rect", fill: "transparent", border: { width: 12, color: "#1B7F4A" } },
    { ...base, id: "title", name: "Titre", frame: { x: 80, y: 420, w: 1040, h: 180 },
      type: "text", content: "Bonjour", font, color: "#FFFFFF", align: "left", vAlign: "bottom",
      lineHeight: 1.1, maxLines: 3 },
    { ...base, id: "hidden", name: "Masqué", visible: false, frame: { x: 0, y: 0, w: 10, h: 10 },
      type: "shape", shape: "rect", fill: "#FF0000" },
  ],
};

// Properties Pro P1, Tâche 3 — la map associe désormais un ID à une `PreparedImage` (`{ uri, w, h }`),
// pas à une simple URI : le chemin de rendu d'une IMAGE (fond CSS) a besoin de la taille intrinsèque.
const images = new Map([["bg", { uri: "data:image/png;base64,AAAA", w: 1200, h: 675 }]]);

describe("sceneToElement", () => {
  it("produit une racine aux dimensions du canevas", () => {
    const root = sceneToElement(scene, images);
    expect(root.type).toBe("div");
    const style = (root.props as { style: Record<string, unknown> }).style;
    expect(style.width).toBe(1200);
    expect(style.height).toBe(675);
    expect(style.backgroundColor).toBe("#101010");
  });

  it("respecte l'ordre de peinture : index 0 en premier enfant", () => {
    const root = sceneToElement(scene, images);
    const children = (root.props as { children: { props: { "data-layer": string } }[] }).children;
    expect(children.map((c) => c.props["data-layer"])).toEqual(["bg", "bar", "title"]);
  });

  it("omet les calques invisibles", () => {
    const root = sceneToElement(scene, images);
    const children = (root.props as { children: unknown[] }).children;
    expect(children).toHaveLength(3);
  });

  it("omet un calque image dont l'URI n'a pas été préparée", () => {
    const root = sceneToElement(scene, new Map());
    const children = (root.props as { children: { props: { "data-layer": string } }[] }).children;
    expect(children.map((c) => c.props["data-layer"])).toEqual(["bar", "title"]);
  });

  it("positionne chaque calque en absolu selon son cadre", () => {
    const root = sceneToElement(scene, images);
    const children = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children;
    expect(children[2].props.style.position).toBe("absolute");
    expect(children[2].props.style.left).toBe(80);
    expect(children[2].props.style.top).toBe(420);
  });

  it("traduit maxLines en lineClamp", () => {
    const root = sceneToElement(scene, images);
    const children = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children;
    expect(children[2].props.style.lineClamp).toBe(3);
  });

  // Additional coverage tests
  it("n'ajoute aucune clé backgroundColor pour un remplissage transparent", () => {
    const transparentScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "#FFF" },
      layers: [
        {
          visible: true, locked: false, id: "trans", name: "Transparent",
          frame: { x: 0, y: 0, w: 100, h: 100 },
          type: "shape", shape: "rect", fill: "transparent",
        },
      ],
    };
    const root = sceneToElement(transparentScene, new Map());
    const children = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children;
    const shapeStyle = children[0].props.style;
    expect("backgroundColor" in shapeStyle).toBe(false);
  });

  it("applique un dégradé linéaire comme backgroundImage", () => {
    const gradientScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "#FFF" },
      layers: [
        {
          visible: true, locked: false, id: "grad", name: "Gradient",
          frame: { x: 0, y: 0, w: 100, h: 100 },
          type: "shape", shape: "rect",
          fill: { angle: 45, stops: [{ color: "#FF0000", at: 0 }, { color: "#0000FF", at: 1 }] },
        },
      ],
    };
    const root = sceneToElement(gradientScene, new Map());
    const children = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children;
    const shapeStyle = children[0].props.style;
    expect(shapeStyle.backgroundImage).toContain("linear-gradient");
    expect(shapeStyle.backgroundImage).toContain("45deg");
    expect(shapeStyle.backgroundImage).toContain("#FF0000");
    expect(shapeStyle.backgroundImage).toContain("#0000FF");
  });

  it("applique une rotation à un calque", () => {
    const rotatedScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "#FFF" },
      layers: [
        {
          visible: true, locked: false, id: "rot", name: "Rotated",
          frame: { x: 10, y: 10, w: 50, h: 50 },
          type: "shape", shape: "rect", fill: "#000", rotation: 45,
        },
      ],
    };
    const root = sceneToElement(rotatedScene, new Map());
    const children = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children;
    expect(children[0].props.style.transform).toBe("rotate(45deg)");
  });

  it("applique une opacité à un calque", () => {
    const opacityScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "#FFF" },
      layers: [
        {
          visible: true, locked: false, id: "opac", name: "Opacity",
          frame: { x: 0, y: 0, w: 100, h: 100 },
          type: "shape", shape: "rect", fill: "#000", opacity: 0.5,
        },
      ],
    };
    const root = sceneToElement(opacityScene, new Map());
    const children = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children;
    expect(children[0].props.style.opacity).toBe(0.5);
  });

  it("applique les bordures pour un sous-ensemble de côtés", () => {
    const partialBorderScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "#FFF" },
      layers: [
        {
          visible: true, locked: false, id: "border", name: "Border",
          frame: { x: 0, y: 0, w: 100, h: 100 },
          type: "shape", shape: "rect", fill: "#000",
          border: { width: 2, color: "#FFF", sides: ["top", "bottom"] },
        },
      ],
    };
    const root = sceneToElement(partialBorderScene, new Map());
    const children = (root.props as { children: { props: { style: Record<string, unknown> } }[] }).children;
    const shapeStyle = children[0].props.style;
    expect(shapeStyle.borderTop).toBe("2px solid #FFF");
    expect(shapeStyle.borderBottom).toBe("2px solid #FFF");
    expect("borderLeft" in shapeStyle).toBe(false);
    expect("borderRight" in shapeStyle).toBe(false);
  });

  it("applique le border-radius sur une couche image, rendue en FOND (Tâche 3 : plus de <img> interne)", () => {
    const radiusImageScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "#FFF" },
      layers: [
        {
          visible: true, locked: false, id: "img", name: "Image with radius",
          frame: { x: 10, y: 10, w: 80, h: 80 },
          type: "image", source: { kind: "url", url: "https://x.test/img.png" },
          fit: "cover", radius: 16,
        },
      ],
    };
    const imgMap = new Map([["img", { uri: "data:image/png;base64,AAAA", w: 80, h: 80 }]]);
    const root = sceneToElement(radiusImageScene, imgMap);
    const children = (root.props as { children: { props: Record<string, unknown> }[] }).children;
    const containerProps = children[0].props;
    const containerStyle = containerProps.style as Record<string, unknown>;
    expect(containerStyle.borderRadius).toBe(16);
    // CHEMIN UNIQUE : une IMAGE est un `<div>` de FOND — plus AUCUN `<img>` interne (le rayon vit sur
    // le conteneur, l'image elle-même est peinte via `background-image`).
    expect("children" in containerProps).toBe(false);
    expect(containerStyle.backgroundImage).toBe("url(data:image/png;base64,AAAA)");
    expect(containerStyle.backgroundSize).toBe("cover");
  });

  it("maintient l'ordre d'apparition des calques visibles seulement", () => {
    const orderScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "#FFF" },
      layers: [
        { visible: true, locked: false, id: "a", name: "A", frame: { x: 0, y: 0, w: 10, h: 10 },
          type: "shape", shape: "rect", fill: "#000" },
        { visible: false, locked: false, id: "b", name: "B", frame: { x: 0, y: 0, w: 10, h: 10 },
          type: "shape", shape: "rect", fill: "#000" },
        { visible: true, locked: false, id: "c", name: "C", frame: { x: 0, y: 0, w: 10, h: 10 },
          type: "shape", shape: "rect", fill: "#000" },
        { visible: true, locked: false, id: "d", name: "D", frame: { x: 0, y: 0, w: 10, h: 10 },
          type: "shape", shape: "rect", fill: "#000" },
      ],
    };
    const root = sceneToElement(orderScene, new Map());
    const children = (root.props as { children: { props: { "data-layer": string } }[] }).children;
    const ids = children.map((c) => c.props["data-layer"]);
    expect(ids).toEqual(["a", "c", "d"]);
    // Verify it's an exact order, not just a subset
    expect(ids.length).toBe(3);
    expect(ids[0]).toBe("a");
    expect(ids[1]).toBe("c");
    expect(ids[2]).toBe("d");
  });

  it("omet la clé backgroundColor du canevas quand le fond est transparent", () => {
    const transparentCanvasScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "transparent" },
      layers: [],
    };
    const root = sceneToElement(transparentCanvasScene, new Map());
    const style = (root.props as { style: Record<string, unknown> }).style;
    expect("backgroundColor" in style).toBe(false);
  });

  it("inclut backgroundColor du canevas quand le fond est une couleur réelle", () => {
    const realBackgroundScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 100, height: 100, background: "#ABC123" },
      layers: [],
    };
    const root = sceneToElement(realBackgroundScene, new Map());
    const style = (root.props as { style: Record<string, unknown> }).style;
    expect("backgroundColor" in style).toBe(true);
    expect(style.backgroundColor).toBe("#ABC123");
  });

  it("rend les calques QR avec fit par défaut « contain » et sans radius", () => {
    const qrScene: Scene = {
      schemaVersion: 1,
      canvas: { width: 200, height: 200, background: "#FFF" },
      layers: [
        {
          visible: true, locked: false, id: "qr1", name: "QR Code",
          frame: { x: 50, y: 50, w: 100, h: 100 },
          type: "qr", slot: "contact", fg: "#000", bg: "#FFF", margin: 2,
        },
      ],
    };
    const qrMap = new Map([["qr1", { uri: "data:image/png;base64,QRCODE", w: 0, h: 0 }]]);
    const root = sceneToElement(qrScene, qrMap);
    const children = (root.props as { children: { props: { "data-layer": string; style: Record<string, unknown> } }[] }).children;
    expect(children).toHaveLength(1);
    expect(children[0].props["data-layer"]).toBe("qr1");
    const qrContainerProps = children[0].props as Record<string, unknown>;
    const qrStyle = qrContainerProps.style as Record<string, unknown>;
    const imgChild = qrContainerProps.children as { props: { style: Record<string, unknown> } };
    expect(imgChild.props.style.objectFit).toBe("contain");
    expect("borderRadius" in qrStyle).toBe(false);
  });
});
