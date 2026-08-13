import type { SearchRequest } from "./types.js";

/**
 * A query which is safe to use as a Zoekt candidate generator. Every file
 * matching the original request must also match `query`; ripgrep still does
 * the final, exact verification.
 */
export interface EligibleZoektQueryPlan {
  eligible: true;
  query: string;
  mandatoryLiteral: string;
  /**
   * A content-result query is exposed only for the deliberately narrow subset
   * whose Zoekt line matches can be mapped to ripgrep without semantic repair.
   */
  exactMatchQuery?: string;
}

export interface FallbackZoektQueryPlan {
  eligible: false;
  fallbackReason: string;
}

export type ZoektQueryPlan = EligibleZoektQueryPlan | FallbackZoektQueryPlan;
export type QueryPlan = ZoektQueryPlan;

export interface ZoektQueryContext {
  /**
   * The already-validated search root, relative to the indexed repository and
   * using `/` separators. Callers must only provide this after rejecting paths
   * outside the repository.
   */
  repositoryRelativeSearchRoot?: string;
}

export const QUERY_FALLBACK_REASONS = {
  multiline: "multiline searches require ripgrep",
  ignoredFiles: "noIgnore searches require ripgrep because ignored files may not be indexed",
  lineBreak: "patterns containing line breaks require ripgrep",
  tooShort: "the mandatory literal is shorter than 3 UTF-8 bytes",
  characterClass: "character classes are not eligible for indexed candidate search",
  alternation: "alternation is not eligible for indexed candidate search",
  optional: "optional regex constructs are not eligible for indexed candidate search",
  quantifier: "regex quantifiers are not eligible for indexed candidate search",
  inlineFlags: "inline regex flags are not eligible for indexed candidate search",
  unicodeClass: "Unicode character classes are not eligible for indexed candidate search",
  unicodeCaseFold: "case-insensitive non-ASCII literals require ripgrep for identical Unicode folding",
  wildcard: "regex wildcards are not eligible for indexed candidate search",
  grouping: "regex grouping is not eligible for indexed candidate search",
  conditionalAnchor: "only unconditional leading ^ and trailing $ anchors are eligible",
  unsupportedEscape: "the regex contains an escape which cannot be proven literal",
} as const;

const REGEX_META_CHARACTERS = new Set([
  "\\",
  ".",
  "^",
  "$",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
]);

interface LiteralExtractionSuccess {
  ok: true;
  literal: string;
}

interface LiteralExtractionFailure {
  ok: false;
  reason: string;
}

type LiteralExtraction = LiteralExtractionSuccess | LiteralExtractionFailure;

/** Return true when the character at `index` is preceded by an odd slash run. */
function isEscaped(pattern: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && pattern[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

/**
 * Accept only the deliberately small regex subset whose sole consuming atom
 * is a literal string. Anchors may widen away safely; every other construct is
 * rejected instead of attempting a clever (and potentially lossy) rewrite.
 */
function extractPureRegexLiteral(pattern: string): LiteralExtraction {
  if (pattern.includes("\n") || pattern.includes("\r")) {
    return { ok: false, reason: QUERY_FALLBACK_REASONS.lineBreak };
  }

  let start = pattern.startsWith("^") ? 1 : 0;
  let end = pattern.length;
  if (end > start && pattern[end - 1] === "$" && !isEscaped(pattern, end - 1)) {
    end -= 1;
  }

  let literal = "";
  for (let index = start; index < end; index += 1) {
    const character = pattern[index];
    if (character === undefined) {
      break;
    }

    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined || index + 1 >= end) {
        return { ok: false, reason: QUERY_FALLBACK_REASONS.unsupportedEscape };
      }
      if (escaped === "p" || escaped === "P") {
        return { ok: false, reason: QUERY_FALLBACK_REASONS.unicodeClass };
      }
      if (!REGEX_META_CHARACTERS.has(escaped)) {
        return { ok: false, reason: QUERY_FALLBACK_REASONS.unsupportedEscape };
      }
      literal += escaped;
      index += 1;
      continue;
    }

    switch (character) {
      case "[":
      case "]":
        return { ok: false, reason: QUERY_FALLBACK_REASONS.characterClass };
      case "|":
        return { ok: false, reason: QUERY_FALLBACK_REASONS.alternation };
      case "?":
        return { ok: false, reason: QUERY_FALLBACK_REASONS.optional };
      case "*":
      case "+":
      case "{":
      case "}":
        return { ok: false, reason: QUERY_FALLBACK_REASONS.quantifier };
      case "(":
        if (pattern[index + 1] === "?") {
          return { ok: false, reason: QUERY_FALLBACK_REASONS.inlineFlags };
        }
        return { ok: false, reason: QUERY_FALLBACK_REASONS.grouping };
      case ")":
        return { ok: false, reason: QUERY_FALLBACK_REASONS.grouping };
      case ".":
        return { ok: false, reason: QUERY_FALLBACK_REASONS.wildcard };
      case "^":
      case "$":
        return { ok: false, reason: QUERY_FALLBACK_REASONS.conditionalAnchor };
      default:
        literal += character;
    }
  }

  return { ok: true, literal };
}

/** Escape a string so RE2/Zoekt treats every character as literal. */
function escapeZoektRegexLiteral(literal: string): string {
  return literal.replace(/[\\.^$|?*+()[\]{}]/gu, "\\$&");
}

/** Quote a Zoekt query-language atom (a separate layer from JSON encoding). */
function quoteZoektAtom(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

export function buildZoektLiteralQuery(literal: string, ignoreCase = false): string {
  const regexLiteral = escapeZoektRegexLiteral(literal);
  // `type:file` asks Zoekt for filename-only results. Besides avoiding transfer
  // of snippets which ripgrep will verify anyway, this makes the server's match
  // limits count candidate documents instead of high-frequency line matches.
  return `type:file case:${ignoreCase ? "no" : "yes"} content:${quoteZoektAtom(regexLiteral)}`;
}

function buildZoektExactMatchQuery(literal: string): string {
  return `case:yes content:${quoteZoektAtom(escapeZoektRegexLiteral(literal))}`;
}

/**
 * Return a filename regexp that every file below `relativeSearchRoot` must
 * match. The case-insensitive query scope deliberately over-approximates
 * case-sensitive filesystems while remaining safe on case-insensitive ones.
 */
function pathFileFilter(relativeSearchRoot: string | undefined): string | undefined {
  if (relativeSearchRoot === undefined || relativeSearchRoot === "" || relativeSearchRoot === ".") {
    return undefined;
  }
  if (
    relativeSearchRoot.includes("\0")
    || relativeSearchRoot.includes("\n")
    || relativeSearchRoot.includes("\r")
    || relativeSearchRoot.startsWith("/")
  ) {
    return undefined;
  }
  const segments = relativeSearchRoot.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return `^${escapeZoektRegexLiteral(relativeSearchRoot)}($|/)`;
}

/**
 * Extract only a literal which is mandatory for every match of a deliberately
 * small positive-glob subset. This is intentionally weaker than translating
 * the whole glob: ripgrep still applies the exact glob, while an unsupported or
 * ambiguous glob simply contributes no Zoekt filename filter.
 */
function globFileFilters(glob: string | undefined): string[] {
  if (
    glob === undefined
    || glob.startsWith("!")
    || /\s$/u.test(glob)
    || /[\0\r\n\\[\]{}]/u.test(glob)
  ) {
    return [];
  }

  // `/`, `*`, and `?` delimit literal runs. Every complete run is mandatory
  // for both basename and path globs, so ANDing their case-widened filename
  // clauses remains a proven over-approximation.
  const literals = glob
    .split(/[/*?]+/u)
    .filter((literal) => literal.length > 0)
    .filter((literal) => Buffer.byteLength(literal, "utf8") >= 2);
  return [...new Set(literals)].map(escapeZoektRegexLiteral);
}

function scopedClause(kind: "content" | "file", regex: string, ignoreCase: boolean): string {
  return `(case:${ignoreCase ? "no" : "yes"} ${kind}:${quoteZoektAtom(regex)})`;
}

/**
 * Plan an index candidate query. Filename filters are optional, recall-safe
 * over-approximations; ripgrep always applies path/glob exactly afterward.
 */
export function planZoektQuery(
  request: SearchRequest,
  context: ZoektQueryContext = {},
): ZoektQueryPlan {
  if (request.multiline === true) {
    return { eligible: false, fallbackReason: QUERY_FALLBACK_REASONS.multiline };
  }
  if (request.noIgnore === true) {
    return { eligible: false, fallbackReason: QUERY_FALLBACK_REASONS.ignoredFiles };
  }
  if (request.pattern.includes("\n") || request.pattern.includes("\r")) {
    return { eligible: false, fallbackReason: QUERY_FALLBACK_REASONS.lineBreak };
  }

  const extraction: LiteralExtraction = request.literal === true
    ? { ok: true, literal: request.pattern }
    : extractPureRegexLiteral(request.pattern);

  if (!extraction.ok) {
    return { eligible: false, fallbackReason: extraction.reason };
  }
  if (Buffer.byteLength(extraction.literal, "utf8") < 3) {
    return { eligible: false, fallbackReason: QUERY_FALLBACK_REASONS.tooShort };
  }
  if (request.ignoreCase === true && /[^\x00-\x7F]/u.test(extraction.literal)) {
    return { eligible: false, fallbackReason: QUERY_FALLBACK_REASONS.unicodeCaseFold };
  }

  const pathFilter = pathFileFilter(context.repositoryRelativeSearchRoot);
  const fileFilters = [
    ...(pathFilter === undefined ? [] : [pathFilter]),
    ...globFileFilters(request.glob),
  ];
  const query = fileFilters.length === 0
    ? buildZoektLiteralQuery(extraction.literal, request.ignoreCase === true)
    : [
        "type:file",
        scopedClause(
          "content",
          escapeZoektRegexLiteral(extraction.literal),
          request.ignoreCase === true,
        ),
        ...fileFilters.map((filter) => scopedClause("file", filter, true)),
      ].join(" ");
  const matchContext = request.context ?? 2;
  const beforeContext = request.beforeContext ?? matchContext;
  const afterContext = request.afterContext ?? matchContext;
  const regexHasAnchor = request.literal !== true
    && (request.pattern.startsWith("^")
      || (request.pattern.endsWith("$") && !isEscaped(request.pattern, request.pattern.length - 1)));
  const exactMatchQuery = (
    request.ignoreCase !== true
    && request.path === undefined
    && request.glob === undefined
    && matchContext === 0
    && beforeContext === 0
    && afterContext === 0
    && !regexHasAnchor
    && /^[\x00-\x7F]+$/u.test(extraction.literal)
  )
    ? buildZoektExactMatchQuery(extraction.literal)
    : undefined;

  return {
    eligible: true,
    mandatoryLiteral: extraction.literal,
    query,
    ...(exactMatchQuery === undefined ? {} : { exactMatchQuery }),
  };
}

/** Short alias for callers which do not need the backend name in the symbol. */
export const planQuery = planZoektQuery;
