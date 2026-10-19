import { describe, expect, it } from "vitest";

import { formatId, initials, timeAgo } from "./format";

describe("formatId", () => {
  it("groups digits in threes", () => {
    expect(formatId("418203977")).toBe("418 203 977");
  });

  it("works on partial input and ignores anything but digits", () => {
    expect(formatId("4182")).toBe("418 2");
    expect(formatId("418 20a3")).toBe("418 203");
    expect(formatId("")).toBe("");
  });
});

describe("timeAgo", () => {
  const now = 1_700_000_000_000;

  it("says just now for the last 45 seconds", () => {
    expect(timeAgo(now - 30_000, now)).toBe("just now");
  });

  it("counts minutes, hours and days", () => {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    expect(timeAgo(now - 4 * 60_000, now)).toBe(rtf.format(-4, "minute"));
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe(rtf.format(-3, "hour"));
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe(rtf.format(-2, "day"));
  });

  it("shows a date after a week", () => {
    const then = now - 10 * 86_400_000;
    expect(timeAgo(then, now)).toBe(new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
  });
});

describe("initials", () => {
  it("uses first and last names", () => {
    expect(initials("Sam Rivera")).toBe("SR");
    expect(initials("  ada   lovelace  byron ")).toBe("AB");
  });

  it("handles one name or none", () => {
    expect(initials("jo")).toBe("JO");
    expect(initials("   ")).toBe("?");
  });
});
