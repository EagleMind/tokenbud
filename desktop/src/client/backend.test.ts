import { describe, expect, it } from "vitest";

import fixtures from "../../../tests/fixtures/memory.json";
import { buildContext, buildHistory, cleanFact, MAX_FACT_CHARS, MAX_FACTS, type Memory, normalizeChats, normalizeMemory, splitSuggestions, titleOf } from "./backend";

// The same cases the Rust client checks (apps/tokenbud-client/src/memory.rs), so the two can't drift.
describe("shared fixtures", () => {
  it.each(fixtures.titles)("titleOf($prompt)", ({ prompt, title }) => {
    expect(titleOf(prompt)).toBe(title);
  });

  it.each(fixtures.contexts)("buildContext #%#", ({ memory, context }) => {
    expect(buildContext(memory as Memory)).toBe(context);
  });
});

describe("splitSuggestions", () => {
  it("takes out every suggestion and keeps the answer", () => {
    const r = splitSuggestions("Sure.\n<remember>Writes Go</remember>\n<remember>  Likes\n tabs </remember>");
    expect(r).toEqual({ text: "Sure.", suggestions: ["Writes Go", "Likes tabs"] });
  });

  it("treats an unclosed tag as running to the end", () => {
    expect(splitSuggestions("Done. <remember>Uses Vim")).toEqual({ text: "Done.", suggestions: ["Uses Vim"] });
  });

  it("drops empty suggestions", () => {
    expect(splitSuggestions("Hi <remember>   </remember>")).toEqual({ text: "Hi", suggestions: [] });
  });

  it("leaves an answer without tags alone", () => {
    expect(splitSuggestions("  plain  ")).toEqual({ text: "plain", suggestions: [] });
  });
});

describe("cleanFact", () => {
  it("makes one trimmed line", () => {
    expect(cleanFact("  a\n\tb  ")).toBe("a b");
  });

  it("cuts by characters, never inside an emoji", () => {
    const fact = cleanFact("x".repeat(MAX_FACT_CHARS - 1) + "😀😀");
    expect(Array.from(fact)).toHaveLength(MAX_FACT_CHARS);
    expect(fact.endsWith("😀")).toBe(true);
  });
});

describe("buildHistory", () => {
  it("keeps answered exchanges, without suggestions", () => {
    const history = buildHistory([
      { prompt: "q1", state: "done", answer: "a1 <remember>x</remember>", error: null, at: 0 },
      { prompt: "q2", state: "error", answer: null, error: "nope", at: 1 },
      { prompt: "q3", state: "running", answer: null, error: null, at: 2 },
    ]);
    expect(history).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });
});

describe("normalizeMemory", () => {
  it("gives defaults for missing or broken data", () => {
    for (const v of [undefined, null, "x", 3, []]) expect(normalizeMemory(v)).toEqual({ enabled: true, facts: [], dismissed: [] });
  });

  it("keeps valid facts and drops the rest", () => {
    const m = normalizeMemory({
      enabled: false,
      facts: [{ id: "a", text: " ok ", at: 5 }, { id: "", text: "no id" }, { id: "b", text: "" }, null, "x", { id: "c", text: "no time" }],
      dismissed: ["d", 4, null],
    });
    expect(m).toEqual({
      enabled: false,
      facts: [
        { id: "a", text: "ok", at: 5 },
        { id: "c", text: "no time", at: 0 },
      ],
      dismissed: ["d"],
    });
  });

  it("caps the number of facts", () => {
    const facts = Array.from({ length: MAX_FACTS + 5 }, (_, i) => ({ id: `f${i}`, text: `fact ${i}`, at: i }));
    expect(normalizeMemory({ facts }).facts).toHaveLength(MAX_FACTS);
  });
});

describe("normalizeChats", () => {
  it("drops chats without an id and repairs messages", () => {
    const chats = normalizeChats([
      { id: "c1", messages: [{ prompt: "hi", state: "weird", answer: 3, at: "x" }, "junk"] },
      { title: "no id" },
      null,
    ]);
    expect(chats).toEqual([{ id: "c1", title: "Chat", messages: [{ prompt: "hi", state: "error", answer: null, error: null, at: 0 }] }]);
  });

  it("returns nothing for something that isn't a list", () => {
    expect(normalizeChats({ id: "c1" })).toEqual([]);
  });
});
