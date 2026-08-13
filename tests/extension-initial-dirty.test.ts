import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import fastGrepExtension, {
  FAST_GREP_PROMPT_GUIDELINES,
  FAST_GREP_PROMPT_SNIPPET,
  parseInitialDirtyPathsFlag,
} from "../src/extension.js";

describe("--fast-grep-initial-dirty-paths", () => {
  const root = path.join(path.parse(process.cwd()).root, "trusted-repository");

  test("registers the exact opt-in string flag without a default snapshot", () => {
    const flags = new Map<string, unknown>();
    fastGrepExtension({
      registerFlag: (name: string, options: unknown) => flags.set(name, options),
      registerTool: () => undefined,
      getFlag: () => undefined,
      on: () => undefined,
    } as unknown as ExtensionAPI);

    expect(flags.get("fast-grep-initial-dirty-paths")).toMatchObject({ type: "string" });
    expect(flags.get("fast-grep-initial-dirty-paths")).not.toHaveProperty("default");
  });

  test("advertises regex/file filters and a bounded indexed-result escape hatch", () => {
    const tools: Array<Record<string, unknown>> = [];
    fastGrepExtension({
      registerFlag: () => undefined,
      registerTool: (tool: unknown) => tools.push(tool as Record<string, unknown>),
      getFlag: () => undefined,
      on: () => undefined,
    } as unknown as ExtensionAPI);

    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).toMatch(/regex and path\/glob filters/u);
    expect(tools[0]?.promptSnippet).toBe(FAST_GREP_PROMPT_SNIPPET);
    expect(tools[0]?.promptGuidelines).toEqual(FAST_GREP_PROMPT_GUIDELINES);
    expect(FAST_GREP_PROMPT_GUIDELINES.join("\n")).toMatch(/indexed empty result/u);
    expect(FAST_GREP_PROMPT_GUIDELINES.join("\n")).toContain("rg --no-config");
    expect(FAST_GREP_PROMPT_GUIDELINES.join("\n")).toMatch(/verify once/u);
  });

  test("distinguishes an omitted flag from an explicit empty snapshot", () => {
    expect(parseInitialDirtyPathsFlag(undefined, root)).toBeUndefined();
    expect(parseInitialDirtyPathsFlag("[]", root)).toEqual([]);
  });

  test("parses, normalizes, and deduplicates a JSON string array", () => {
    expect(
      parseInitialDirtyPathsFlag(
        JSON.stringify([
          "src/dirty.ts",
          "./src/nested/../dirty.ts",
          "deleted.ts",
          ".fast-grep/internal",
        ]),
        root,
      ),
    ).toEqual(["src/dirty.ts", "deleted.ts"]);
  });

  test.each([
    [true, /JSON string array/],
    ["not-json", /valid JSON/],
    ['{"path":"src/a.ts"}', /JSON string array/],
    ['["src/a.ts", 1]', /JSON string array/],
    ['[""]', /non-empty strings/],
    ['["../outside.ts"]', /outside the repository/],
    [JSON.stringify([path.join(root, "inside-but-absolute.ts")]), /repository-relative/],
  ] as const)("rejects invalid or out-of-bounds input %#", (value, message) => {
    expect(() => parseInitialDirtyPathsFlag(value, root)).toThrow(message);
  });
});
