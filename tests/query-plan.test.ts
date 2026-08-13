import { describe, expect, it } from "vitest";

import {
  QUERY_FALLBACK_REASONS,
  buildZoektLiteralQuery,
  planZoektQuery,
} from "../src/query-plan.js";

describe("planZoektQuery", () => {
  it("plans explicit literals and always emits an explicit case directive", () => {
    expect(planZoektQuery({ pattern: "Hello.world", literal: true })).toEqual({
      eligible: true,
      mandatoryLiteral: "Hello.world",
      query: String.raw`type:file case:yes content:"Hello\\.world"`,
    });
    expect(planZoektQuery({ pattern: "hello", literal: true, ignoreCase: true })).toEqual({
      eligible: true,
      mandatoryLiteral: "hello",
      query: String.raw`type:file case:no content:"hello"`,
    });
  });

  it("proves a plain regex literal while widening away only edge anchors", () => {
    expect(planZoektQuery({ pattern: String.raw`^foo\.bar\$baz$` })).toEqual({
      eligible: true,
      mandatoryLiteral: "foo.bar$baz",
      query: String.raw`type:file case:yes content:"foo\\.bar\\$baz"`,
    });
  });

  it("accepts escaped regex metacharacters, including a literal backslash", () => {
    expect(planZoektQuery({ pattern: String.raw`a\+b\\c` })).toMatchObject({
      eligible: true,
      mandatoryLiteral: String.raw`a+b\c`,
    });
  });

  it("adds independently scoped, case-widened path and glob filename filters", () => {
    expect(
      planZoektQuery(
        {
          pattern: "Needle",
          literal: true,
          ignoreCase: false,
          path: "src/client",
          glob: "*.ts",
        },
        { repositoryRelativeSearchRoot: "src/client" },
      ),
    ).toEqual({
      eligible: true,
      mandatoryLiteral: "Needle",
      query:
        String.raw`type:file (case:yes content:"Needle") `
        + String.raw`(case:no file:"^src/client($|/)") (case:no file:"\\.ts")`,
    });
  });

  it("uses the validated repository-relative root, including for an absolute request path", () => {
    const plan = planZoektQuery(
      {
        pattern: "needle",
        literal: true,
        path: "/checkout/src/client",
      },
      { repositoryRelativeSearchRoot: "src/client" },
    );
    expect(plan).toMatchObject({
      eligible: true,
      query:
        String.raw`type:file (case:yes content:"needle") `
        + String.raw`(case:no file:"^src/client($|/)")`,
    });
  });

  it("derives only a mandatory literal from supported positive globs", () => {
    expect(planZoektQuery({ pattern: "needle", literal: true, glob: "include/**/*.h" })).toMatchObject({
      eligible: true,
      query:
        String.raw`type:file (case:yes content:"needle") `
        + String.raw`(case:no file:"include") (case:no file:"\\.h")`,
    });
    expect(planZoektQuery({ pattern: "needle", literal: true, glob: "README*" })).toMatchObject({
      eligible: true,
      query:
        String.raw`type:file (case:yes content:"needle") `
        + String.raw`(case:no file:"README")`,
    });
  });

  it.each([
    ["negative", "!*.ts"],
    ["brace alternatives", "*.{ts,tsx}"],
    ["character class", "[ab]*.ts"],
    ["escaped syntax", String.raw`\!important.ts`],
    ["trailing gitignore whitespace", "name.ts "],
    ["literal-free", "**/*"],
  ])("omits an unproven %s glob instead of risking recall", (_name, glob) => {
    expect(planZoektQuery({ pattern: "needle", literal: true, glob })).toEqual(
      planZoektQuery({ pattern: "needle", literal: true }),
    );
  });

  it("omits an unvalidated path filter while retaining a proven glob filter", () => {
    expect(
      planZoektQuery(
        { pattern: "needle", literal: true, glob: "*.go" },
        { repositoryRelativeSearchRoot: "../outside" },
      ),
    ).toMatchObject({
      eligible: true,
      query:
        String.raw`type:file (case:yes content:"needle") `
        + String.raw`(case:no file:"\\.go")`,
    });
  });

  it("escapes filename regex and query-language layers independently", () => {
    expect(
      planZoektQuery(
        { pattern: "needle", literal: true, glob: '*.d"ts' },
        { repositoryRelativeSearchRoot: 'src/a"b.c' },
      ),
    ).toMatchObject({
      eligible: true,
      query:
        String.raw`type:file (case:yes content:"needle") `
        + String.raw`(case:no file:"^src/a\"b\\.c($|/)") `
        + String.raw`(case:no file:"\\.d\"ts")`,
    });
  });

  it("uses UTF-8 byte length for the trigram eligibility gate", () => {
    expect(planZoektQuery({ pattern: "é", literal: true })).toEqual({
      eligible: false,
      fallbackReason: QUERY_FALLBACK_REASONS.tooShort,
    });
    expect(planZoektQuery({ pattern: "€", literal: true })).toMatchObject({
      eligible: true,
      mandatoryLiteral: "€",
    });
  });

  it("falls back for non-ASCII case folding whose semantics can differ", () => {
    expect(planZoektQuery({ pattern: "Straße", literal: true, ignoreCase: true })).toEqual({
      eligible: false,
      fallbackReason: QUERY_FALLBACK_REASONS.unicodeCaseFold,
    });
    expect(planZoektQuery({ pattern: "ASCII", literal: true, ignoreCase: true })).toMatchObject({
      eligible: true,
    });
  });

  it.each([
    ["character class", "foo[0-9]", QUERY_FALLBACK_REASONS.characterClass],
    ["alternation", "foo|bar", QUERY_FALLBACK_REASONS.alternation],
    ["optional", "colou?r", QUERY_FALLBACK_REASONS.optional],
    ["star quantifier", "foo.*bar", QUERY_FALLBACK_REASONS.wildcard],
    ["plus quantifier", "fo+bar", QUERY_FALLBACK_REASONS.quantifier],
    ["bounded quantifier", "foo{2}", QUERY_FALLBACK_REASONS.quantifier],
    ["inline flag", "(?i)foobar", QUERY_FALLBACK_REASONS.inlineFlags],
    ["Unicode class", String.raw`foo\p{L}`, QUERY_FALLBACK_REASONS.unicodeClass],
    ["group", "(foobar)", QUERY_FALLBACK_REASONS.grouping],
    ["inner anchor", "foo^bar", QUERY_FALLBACK_REASONS.conditionalAnchor],
    ["unsupported escape", String.raw`foo\bbar`, QUERY_FALLBACK_REASONS.unsupportedEscape],
  ])("falls back for %s", (_name, pattern, fallbackReason) => {
    expect(planZoektQuery({ pattern })).toEqual({ eligible: false, fallbackReason });
  });

  it("falls back for multiline, line-breaking, and no-ignore requests", () => {
    expect(planZoektQuery({ pattern: "foobar", multiline: true })).toMatchObject({
      eligible: false,
      fallbackReason: QUERY_FALLBACK_REASONS.multiline,
    });
    expect(planZoektQuery({ pattern: "foo\nbar", literal: true })).toMatchObject({
      eligible: false,
      fallbackReason: QUERY_FALLBACK_REASONS.lineBreak,
    });
    expect(planZoektQuery({ pattern: "foobar", literal: true, noIgnore: true })).toMatchObject({
      eligible: false,
      fallbackReason: QUERY_FALLBACK_REASONS.ignoredFiles,
    });
  });
});

describe("buildZoektLiteralQuery", () => {
  it("escapes regex and query-language layers independently", () => {
    expect(buildZoektLiteralQuery(String.raw`a"b\c.d$`, false)).toBe(
      String.raw`type:file case:yes content:"a\"b\\\\c\\.d\\$"`,
    );
  });
});
