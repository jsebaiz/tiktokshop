import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedWebhookUrl, isPublishedPostUrl } from "../src/shared/urls";
import { evaluateStale } from "../src/shared/status";

const PRIVATE_IDS = [
  "1IcxeyGUA6Hg-FWu5Ux_R2EZy4M1aVN7AHep8EhxOy0U",
  "1GBC2osWqB3gFY1w7raqYfOo1joOnBsmH",
  "1QNagh1F0zewpplTgd-BikS4WrIoRqVft",
  "0314d30a-41ba-49ad-b164-6cfa42fe0b5f",
  "0ce484ce-4233-41d5-b7a4-ff45bc986423",
  "3a010ad4-fe0f-40a2-b53c-d586151c59f0",
  "791315b7-2cab-42d5-aa4d-e2f918636447",
  "aaf3776f-342f-46f5-bdc5-a60b6acaab37",
  "f2ea00b8-03fc-4f41-9c80-e95ba6e5692a",
];

describe("public assets", () => {
  it("keeps sheet, folder, and agent ids out of the browser bundle", () => {
    for (const file of walk("public").concat(walk("src/client"), walk("src/shared"))) {
      const text = readFileSync(file, "utf8");
      for (const id of PRIVATE_IDS) {
        expect(text.includes(id), file).toBe(false);
      }
    }
  });
});

describe("status rules", () => {
  it("accepts a live TikTok video or photo URL and rejects lookalikes", () => {
    expect(isPublishedPostUrl("https://www.tiktok.com/@jesse/video/1234567890")).toBe(true);
    expect(isPublishedPostUrl("https://www.tiktok.com/@jesse/photo/1234567890")).toBe(true);
    expect(isPublishedPostUrl("https://vm.tiktok.com/Zabc123")).toBe(true);
    expect(isPublishedPostUrl("https://example.com/@jesse/video/123")).toBe(false);
    expect(isPublishedPostUrl("http://www.tiktok.com/@jesse/video/123")).toBe(false);
  });

  it("allowlists only the Grok Bot webhook host", () => {
    expect(isAllowedWebhookUrl("https://api2.cursor.sh/automations/webhook/abc_123")).toBe(true);
    expect(isAllowedWebhookUrl("https://api2.cursor.sh.evil.com/automations/webhook/abc")).toBe(false);
    expect(isAllowedWebhookUrl("http://api2.cursor.sh/automations/webhook/abc")).toBe(false);
    expect(isAllowedWebhookUrl("https://user:pass@api2.cursor.sh/automations/webhook/abc")).toBe(false);
  });

  it("turns a quiet requested job into unknown and leaves a quiet running job running", () => {
    const requested = evaluateStale(
      { status: "requested", updated_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() },
      Date.now(),
      { requested: 15 * 60 * 1000, running: 2 * 60 * 60 * 1000 },
    );
    expect(requested).toEqual({ status: "unknown", stale: true });
    const running = evaluateStale(
      { status: "running", updated_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
      Date.now(),
      { requested: 15 * 60 * 1000, running: 2 * 60 * 60 * 1000 },
    );
    expect(running).toEqual({ status: "running", stale: true });
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}
