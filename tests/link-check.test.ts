import { expect, test } from "bun:test";
import { verifyUrl } from "@/lib/video/link-check";

const fetchStatus = (status: number): typeof fetch =>
  (async () => new Response(null, { status })) as unknown as typeof fetch;

test("2xx → ok", async () => {
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(206) })).status).toBe("ok");
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(200) })).status).toBe("ok");
});
test("401/403 → interdit", async () => {
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(403) })).status).toBe("interdit");
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(401) })).status).toBe("interdit");
});
test("autre 4xx/5xx → mort", async () => {
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(404) })).status).toBe("mort");
  expect((await verifyUrl("https://x.test/a", { fetchImpl: fetchStatus(500) })).status).toBe("mort");
});
test("exception → mort", async () => {
  const boom = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
  expect((await verifyUrl("https://x.test/a", { fetchImpl: boom })).status).toBe("mort");
});
test("url privée/non-http → mort SANS fetch", async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
  expect((await verifyUrl("http://127.0.0.1/x", { fetchImpl: spy })).status).toBe("mort");
  expect((await verifyUrl(null, { fetchImpl: spy })).status).toBe("mort");
  expect(called).toBe(false);
});
