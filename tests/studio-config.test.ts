import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { getStudioConfig } from "@/lib/studio/config";
import { publicUrlFor } from "@/lib/storage/r2";

const KEYS = ["R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET","R2_PUBLIC_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

function setAll(v: string | undefined) {
  for (const k of KEYS) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

describe("getStudioConfig", () => {
  beforeEach(() => setAll(undefined));
  afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

  it("renvoie null quand aucune variable n'est posée", () => {
    expect(getStudioConfig()).toBeNull();
  });

  it("renvoie null quand une seule variable manque", () => {
    setAll("x");
    delete process.env.R2_BUCKET;
    expect(getStudioConfig()).toBeNull();
  });

  it("renvoie la configuration quand les cinq sont posées", () => {
    setAll("x");
    expect(getStudioConfig()).toEqual({
      accountId: "x", accessKeyId: "x", secretAccessKey: "x", bucket: "x", publicBaseUrl: "x",
    });
  });

  it("construit une URL publique sans double slash", () => {
    const cfg = { accountId:"a", accessKeyId:"b", secretAccessKey:"c", bucket:"d", publicBaseUrl:"https://media.test/" };
    expect(publicUrlFor(cfg, "renders/2026/08/abc.jpg")).toBe("https://media.test/renders/2026/08/abc.jpg");
  });
});
