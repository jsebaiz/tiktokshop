import { describe, expect, it } from "vitest";
import { AGENTS } from "../src/shared/catalog";
import {
  attentionRank,
  completionStreak,
  jobSummary,
  jobTone,
  levelProgress,
  wordCount,
} from "../src/shared/progress";

describe("real progress math", () => {
  it("starts at level 1 with an empty bar when nothing is completed", () => {
    expect(levelProgress(0)).toEqual({ level: 1, current: 0, goal: 3 });
    expect(completionStreak([], Date.parse("2026-11-09T12:00:00.000Z"))).toBe(0);
  });

  it("levels up from completed jobs only", () => {
    expect(levelProgress(2)).toEqual({ level: 1, current: 2, goal: 3 });
    expect(levelProgress(3)).toEqual({ level: 2, current: 0, goal: 3 });
    expect(levelProgress(4)).toEqual({ level: 2, current: 1, goal: 3 });
  });

  it("counts a streak of UTC days and drops it when a day is missed", () => {
    const now = Date.parse("2026-11-09T18:00:00.000Z");
    expect(
      completionStreak(["2026-11-09T01:00:00.000Z", "2026-11-08T23:00:00.000Z"], now),
    ).toBe(2);
    expect(completionStreak(["2026-11-08T12:00:00.000Z"], now)).toBe(1);
    expect(completionStreak(["2026-11-06T12:00:00.000Z"], now)).toBe(0);
    expect(
      completionStreak(["2026-11-09T12:00:00.000Z", "2026-11-07T12:00:00.000Z"], now),
    ).toBe(1);
  });
});

describe("glanceable status", () => {
  it("maps jobs to red, amber, blue, and green without treating a fresh request as done", () => {
    expect(jobTone("failed", false)).toBe("red");
    expect(jobTone("needs input", false)).toBe("red");
    expect(jobTone("unknown", false)).toBe("amber");
    expect(jobTone("running", true)).toBe("amber");
    expect(jobTone("requested", false)).toBe("blue");
    expect(jobTone("running", false)).toBe("blue");
    expect(jobTone("completed", false)).toBe("green");
    expect(attentionRank("failed", false)).toBeLessThan(attentionRank("needs input", false) ?? 9);
    expect(attentionRank("requested", false)).toBeNull();
    expect(attentionRank("completed", false)).toBeNull();
  });

  it("keeps every task summary to eight words", () => {
    const statuses = ["requested", "running", "needs input", "completed", "failed", "unknown"];
    for (const agent of AGENTS) {
      for (const task of agent.tasks) {
        for (const status of statuses) {
          for (const stale of [false, true]) {
            const line = jobSummary(task.key, task.label, status, stale);
            expect(wordCount(line), line).toBeLessThanOrEqual(8);
          }
        }
      }
    }
  });
});
