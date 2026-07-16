/**
 * The six read-only tools exposed to the model. Each is a thin facade over
 * one or a few `tokensave tool <name>` calls, never a wrapper for the full
 * ~80-tool TokenSave surface and never a write/mutation tool.
 */

import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isProjectInitialized, resolveProjectRoot } from "./project.ts";
import { checkTokensaveAvailable, runTokensaveTool, type TokensaveRunResult } from "./runner.ts";
import { recordConsultation, type TokensaveSessionState } from "./state.ts";
import { truncationNote } from "./format.ts";
import {
  decodeAffectedResponse,
  decodeBodyResponse,
  decodeDiffContextResponse,
  decodeExactSymbolResponse,
  decodeFileDependentsResponse,
  decodeImpactResponse,
  decodeImplementationsResponse,
  decodeImplsResponse,
  decodeNodeResponse,
  decodeQualifiedNameResponse,
  decodeRelatedListResponse,
  decodeSearchResponse,
  decodeStatusResponse,
  nodeLine,
  type ExactSymbolMatch,
  type ImplEntry,
  type ImplementationEntry,
} from "./decoders.ts";

type GetState = () => TokensaveSessionState;

const NOT_INITIALIZED_TEXT =
  "TokenSave is not initialized for this project. Run `tokensave init` (or /tokensave-init) before using TokenSave tools.";

function binaryMissingText(): string {
  return "TokenSave binary was not found on PATH. Install it, then retry. See README for installation instructions.";
}

function errorText(result: Extract<TokensaveRunResult, { ok: false }>): string {
  switch (result.kind) {
    case "binary_not_found":
      return binaryMissingText();
    case "project_not_initialized":
      return NOT_INITIALIZED_TEXT;
    default:
      return result.message;
  }
}

/** Converts a flat camelCase object into the snake_case keys the TokenSave CLI expects. */
function toSnakeArgs(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    out[snake] = value;
  }
  return out;
}

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<TokensaveRunResult> {
  const projectRoot = resolveProjectRoot(ctx.cwd);
  return runTokensaveTool(toolName, toSnakeArgs(args), { projectRoot, signal });
}

function projectRoot(ctx: ExtensionContext): string {
  return resolveProjectRoot(ctx.cwd);
}

function guardCheckNotInitialized(ctx: ExtensionContext) {
  if (!isProjectInitialized(projectRoot(ctx))) {
    return { content: [{ type: "text" as const, text: NOT_INITIALIZED_TEXT }], details: { initialized: false } };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// tokensave_status
// ---------------------------------------------------------------------------

const statusParams = Type.Object({});

async function executeStatus(_toolCallId: string, _params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
  const root = projectRoot(ctx);
  if (!isProjectInitialized(root)) {
    return { content: [{ type: "text" as const, text: NOT_INITIALIZED_TEXT }], details: { initialized: false } };
  }

  const available = await checkTokensaveAvailable();
  if (!available) {
    return { content: [{ type: "text" as const, text: binaryMissingText() }], details: { binaryAvailable: false } };
  }

  const result = await runTokensaveTool("status", {}, { projectRoot: root, signal });
  if (!result.ok) {
    return { content: [{ type: "text" as const, text: errorText(result) }], details: { ok: false, kind: result.kind } };
  }

  const decoded = decodeStatusResponse(result);
  if (decoded.kind === "text") {
    return { content: [{ type: "text" as const, text: decoded.text }], details: { ok: true } };
  }
  if (decoded.kind === "unknown") {
    return { content: [{ type: "text" as const, text: "TokenSave status returned an unrecognized response shape." }], details: { ok: true } };
  }

  const stats = decoded.stats;
  const lines = [
    "TokenSave status",
    "",
    `- nodes: ${stats.node_count ?? "?"}`,
    `- edges: ${stats.edge_count ?? "?"}`,
    `- files: ${stats.file_count ?? "?"}`,
    `- db size (bytes): ${stats.db_size_bytes ?? "?"}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { ok: true, stats } };
}

// ---------------------------------------------------------------------------
// tokensave_context
// ---------------------------------------------------------------------------

const contextParams = Type.Object({
  task: Type.String({ description: "Natural language description of the task or question" }),
  mode: Type.Optional(StringEnum(["explore", "plan"] as const, { description: "explore (default) or plan" })),
  includeCode: Type.Optional(Type.Boolean({ description: "Include small source snippets for key symbols" })),
  maxNodes: Type.Optional(Type.Number({ description: "Maximum number of symbols to include" })),
  keywords: Type.Optional(Type.Array(Type.String(), { description: "Extra synonym keywords" })),
  pathInclude: Type.Optional(Type.Array(Type.String(), { description: "Only include files whose path contains one of these substrings" })),
  pathExclude: Type.Optional(Type.Array(Type.String(), { description: "Exclude files whose path contains one of these substrings" })),
});

async function executeContext(
  _toolCallId: string,
  params: Static<typeof contextParams>,
  signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
  getState: GetState,
) {
  const blocked = guardCheckNotInitialized(ctx);
  if (blocked) return blocked;

  const result = await callTool(
    "context",
    {
      task: params.task,
      mode: params.mode,
      includeCode: params.includeCode,
      maxNodes: params.maxNodes,
      keywords: params.keywords,
      pathInclude: params.pathInclude,
      pathExclude: params.pathExclude,
    },
    ctx,
    signal,
  );

  recordConsultation(getState(), params.task, result.ok);
  if (!result.ok) {
    return { content: [{ type: "text" as const, text: errorText(result) }], details: { ok: false, kind: result.kind } };
  }

  const text = result.isMarkdown ? (result.data as string) : JSON.stringify(result.data, null, 2);
  const note = result.truncationNote ? `\n\n${result.truncationNote}` : "";
  return {
    content: [{ type: "text" as const, text: `${text}${note}` }],
    details: { ok: true, truncated: result.truncated },
  };
}

// ---------------------------------------------------------------------------
// tokensave_find_symbol
// ---------------------------------------------------------------------------

const findSymbolParams = Type.Object({
  name: Type.String({ description: "Bare or qualified symbol name to locate" }),
  kind: Type.Optional(Type.String({ description: "Filter by kind (class, function, method, interface, ...)" })),
  pathInclude: Type.Optional(Type.Array(Type.String())),
  pathExclude: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Number({ description: "Maximum results to return (default 20)" })),
});

export type SymbolMatchRank =
  | "exact-case-sensitive"
  | "exact-case-insensitive"
  | "qualified-exact"
  | "prefix"
  | "partial"
  | "path-only";

export interface RankedSymbolMatch {
  name: string;
  kind?: string;
  qualified_name?: string;
  file?: string;
  line?: number;
  signature?: string;
  id?: string;
  rank: SymbolMatchRank;
}

const RANK_ORDER: SymbolMatchRank[] = [
  "exact-case-sensitive",
  "exact-case-insensitive",
  "qualified-exact",
  "prefix",
  "partial",
  "path-only",
];

function classifyMatch(name: string, query: string, qualifiedName?: string): SymbolMatchRank {
  if (name === query) return "exact-case-sensitive";
  if (name.toLowerCase() === query.toLowerCase()) return "exact-case-insensitive";
  if (qualifiedName && (qualifiedName === query || qualifiedName.endsWith(`::${query}`) || qualifiedName.endsWith(`.${query}`))) {
    return "qualified-exact";
  }
  if (name.toLowerCase().startsWith(query.toLowerCase())) return "prefix";
  if (name.toLowerCase().includes(query.toLowerCase())) return "partial";
  return "path-only";
}

/**
 * Symbol-kind priority used to break ties within the same textual rank:
 * definitions outrank incidental references to the same name (e.g. a
 * `class WellModel` definition over a `field WellModel` on another class).
 * Kind strings are TokenSave's own vocabulary; unrecognized/missing kinds
 * sort last.
 */
const KIND_PRIORITY_GROUPS: string[][] = [
  [
    "class",
    "inner_class",
    "struct",
    "interface",
    "interface_type",
    "trait",
    "record",
    "pascal_record",
    "case_class",
    "data_class",
    "sealed_class",
    "enum",
    "union",
    "typedef",
    "type_alias",
  ],
  ["function", "method", "struct_method", "abstract_method", "arrow_function", "constructor", "procedure"],
  ["module", "namespace", "package", "go_package", "scala_package", "kotlin_package"],
  ["const", "static", "macro", "preprocessor_def"],
  ["field", "property", "csharp_property", "val", "var", "enum_variant"],
  ["use", "include", "export"],
];

function kindPriority(kind: string | undefined): number {
  if (!kind) return KIND_PRIORITY_GROUPS.length;
  const normalized = kind.toLowerCase();
  const index = KIND_PRIORITY_GROUPS.findIndex((group) => group.includes(normalized));
  return index === -1 ? KIND_PRIORITY_GROUPS.length : index;
}

/**
 * Internal candidate-pool size used before local ranking. TokenSave
 * truncates exact-symbol results *before* computing the response `count`, so
 * a small user-facing `limit` (or a same-named field arriving first) can hide
 * the real definition. We always retrieve a larger bounded pool and only
 * apply the user `limit` after decoding, path filtering, kind filtering, and
 * textual + symbol-kind ranking.
 */
function candidatePoolLimit(limit: number): number {
  return Math.min(200, Math.max(limit * 5, 100));
}

export function rankSymbolMatches(
  query: string,
  matches: Array<{ name: string; kind?: string; qualified_name?: string; file?: string; line?: number; signature?: string; id?: string }>,
): RankedSymbolMatch[] {
  return matches
    .map((match) => ({ ...match, rank: classifyMatch(match.name, query, match.qualified_name) }))
    .sort((a, b) => {
      const rankDiff = RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
      if (rankDiff !== 0) return rankDiff;
      return kindPriority(a.kind) - kindPriority(b.kind);
    });
}

/**
 * TokenSave's own path-filter semantics: normalize `\` to `/`, `pathExclude`
 * takes precedence over `pathInclude`, an empty `pathInclude` matches
 * everything, and substring comparisons are case-sensitive.
 */
export function matchesPathFilters(file: string | undefined, pathInclude: string[] | undefined, pathExclude: string[] | undefined): boolean {
  if (!file) return !pathInclude || pathInclude.length === 0;
  const normalized = file.replace(/\\/g, "/");
  if (pathExclude?.some((fragment) => normalized.includes(fragment))) return false;
  if (pathInclude && pathInclude.length > 0) {
    return pathInclude.some((fragment) => normalized.includes(fragment));
  }
  return true;
}

function formatSymbolMatch(match: RankedSymbolMatch): string[] {
  const lines = [
    `${match.name}${match.rank === "exact-case-sensitive" ? "" : ` (${match.rank})`}`,
    `- kind: ${match.kind ?? "unknown"}`,
  ];
  if (match.qualified_name) lines.push(`- qualified name: ${match.qualified_name}`);
  if (match.file) lines.push(`- file: ${match.file}${match.line !== undefined ? `:${match.line}` : ""}`);
  if (match.signature) lines.push(`- signature: ${match.signature}`);
  if (match.id) lines.push(`- node id: ${match.id}`);
  return lines;
}

function dedupeSymbolIdentity(matches: RankedSymbolMatch[]): RankedSymbolMatch[] {
  const seen = new Set<string>();
  const out: RankedSymbolMatch[] = [];
  for (const match of matches) {
    const key = match.id ?? `${match.file ?? ""}:${match.line ?? ""}:${match.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
}

export interface SymbolNameResolution {
  match?: RankedSymbolMatch;
  ambiguous?: RankedSymbolMatch[];
}

/**
 * Resolves a bare/qualified symbol name to a single best match, reusing the
 * same textual+kind ranking as tokensave_find_symbol instead of blindly
 * taking find_exact_symbol's first result (which can be an arbitrary
 * same-named field, method, or historical duplicate). When multiple
 * distinct symbols are equally plausible after ranking, returns them as an
 * ambiguity rather than silently analyzing one of them.
 */
function looksQualified(name: string): boolean {
  return name.includes(".") || name.includes("::");
}

/**
 * Centralized exact-symbol candidate acquisition shared by every name-based
 * tool so they resolve names identically. Order:
 *  1. bounded `find_exact_symbol`;
 *  2. `by_qualified_name` when the input looks qualified and (1) found nothing;
 *  3. bounded `search` otherwise.
 * All results are normalized to ExactSymbolMatch and left unranked here.
 */
async function fetchSymbolCandidates(
  name: string,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<ExactSymbolMatch[]> {
  const limit = candidatePoolLimit(20);
  const exact = await callTool("find_exact_symbol", { name, limit }, ctx, signal);
  if (exact.ok) {
    const decoded = decodeExactSymbolResponse(exact);
    if (decoded.kind === "object" && decoded.matches.length > 0) return decoded.matches;
  }

  if (looksQualified(name)) {
    const qualified = await callTool("by_qualified_name", { qualifiedName: name }, ctx, signal);
    if (qualified.ok) {
      // by_qualified_name returns a direct array, not a node object.
      const decoded = decodeQualifiedNameResponse(qualified);
      if (decoded.kind === "object" && decoded.matches.length > 0) return decoded.matches;
    }
  }

  const search = await callTool("search", { query: name, limit }, ctx, signal);
  if (search.ok) {
    const decoded = decodeSearchResponse(search);
    if (decoded.kind === "array") return decoded.items;
  }
  return [];
}

async function resolveSymbolByName(name: string, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<SymbolNameResolution> {
  const candidates = await fetchSymbolCandidates(name, ctx, signal);
  if (candidates.length === 0) return {};

  const ranked = rankSymbolMatches(name, candidates);
  const best = ranked[0];
  const tied = dedupeSymbolIdentity(ranked.filter((match) => match.rank === best.rank && kindPriority(match.kind) === kindPriority(best.kind)));

  if (tied.length > 1) return { ambiguous: tied };
  return { match: best };
}

function formatAmbiguity(name: string, candidates: RankedSymbolMatch[]): string {
  return [
    `Multiple equally plausible definitions match '${name}'. Use nodeId to disambiguate:`,
    "",
    ...candidates.map(
      (c) => `- ${c.name} (${c.kind ?? "unknown"}) — ${c.file ?? "?"}${c.line !== undefined ? `:${c.line}` : ""}${c.id ? ` [nodeId: ${c.id}]` : ""}`,
    ),
  ].join("\n");
}

async function executeFindSymbol(
  _toolCallId: string,
  params: Static<typeof findSymbolParams>,
  signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
  getState: GetState,
) {
  const blocked = guardCheckNotInitialized(ctx);
  if (blocked) return blocked;

  const limit = params.limit ?? 20;
  // The desired definition (e.g. a class) can be outnumbered by same-name
  // fields/methods/migrations, and TokenSave truncates before it computes
  // `count`, so a small `limit` can hide the real symbol entirely. Always
  // retrieve a larger bounded candidate pool up front; the user `limit` is
  // applied only after ranking below.
  const candidateLimit = candidatePoolLimit(limit);
  const exact = await callTool("find_exact_symbol", { name: params.name, limit: candidateLimit }, ctx, signal);

  let matches: ExactSymbolMatch[] = [];
  let total: number | undefined;
  let usedFallbackSearch = false;
  let fallbackHasMore = false;

  if (exact.ok) {
    const decoded = decodeExactSymbolResponse(exact);
    if (decoded.kind === "object") {
      // find_exact_symbol has no server-side path filtering, so pathInclude/
      // pathExclude are applied locally here using the same semantics as the
      // fallback search call below.
      matches = decoded.matches.filter((match) => matchesPathFilters(match.file, params.pathInclude, params.pathExclude));
      total = decoded.count;
    }
  }

  if (matches.length === 0 && looksQualified(params.name)) {
    const qualified = await callTool("by_qualified_name", { qualifiedName: params.name }, ctx, signal);
    if (qualified.ok) {
      // by_qualified_name returns a direct array, not a node object.
      const decoded = decodeQualifiedNameResponse(qualified);
      if (decoded.kind === "object" && decoded.matches.length > 0) {
        matches = decoded.matches.filter((match) => matchesPathFilters(match.file, params.pathInclude, params.pathExclude));
      }
    }
  }

  if (matches.length === 0) {
    usedFallbackSearch = true;
    const searchLimit = candidateLimit;
    const search = await callTool(
      "search",
      { query: params.name, limit: searchLimit + 1, pathInclude: params.pathInclude, pathExclude: params.pathExclude },
      ctx,
      signal,
    );
    const searchDecoded = search.ok ? decodeSearchResponse(search) : undefined;
    const searchItems: ExactSymbolMatch[] = searchDecoded?.kind === "array" ? searchDecoded.items : [];
    recordConsultation(getState(), params.name, searchItems.length > 0);
    if (!search.ok) {
      return { content: [{ type: "text" as const, text: errorText(search) }], details: { ok: false, kind: search.kind } };
    }
    fallbackHasMore = searchItems.length > searchLimit;
    matches = searchItems.slice(0, searchLimit);
  } else {
    recordConsultation(getState(), params.name, true);
  }

  const returnedCount = matches.length;

  if (params.kind) {
    matches = matches.filter((match) => match.kind === params.kind);
  }

  if (matches.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No symbol named '${params.name}' was found. Fallback to raw search or grep is allowed now.` }],
      details: { ok: true, count: 0 },
    };
  }

  const ranked = rankSymbolMatches(params.name, matches);
  const shown = ranked.slice(0, limit);
  const exactHit = shown.find((match) => match.rank === "exact-case-sensitive" || match.rank === "exact-case-insensitive");

  const sections = [
    exactHit ? "Exact symbol found" : "Symbol matches (no exact hit)",
    "",
    ...shown.flatMap((match, index) => [...formatSymbolMatch(match), ...(index < shown.length - 1 ? [""] : [])]),
  ];

  const totalUnknown = usedFallbackSearch || total === undefined;
  const notes: string[] = [];
  if (!usedFallbackSearch) {
    const note = truncationNote(shown.length, total);
    if (note) notes.push(note);
  } else if (fallbackHasMore) {
    notes.push(truncationNote(shown.length, undefined, true) as string);
  }
  if (returnedCount >= candidateLimit) {
    notes.push(
      `Candidate pool was capped at ${candidateLimit}; TokenSave truncates before reporting a total, so the upstream total is unknown and additional matches may exist.`,
    );
  }
  if (notes.length > 0) sections.push("", notes.join(" "));
  if (exactHit?.file) sections.push("", `Next step: read ${exactHit.file} before making implementation claims.`);

  return {
    content: [{ type: "text" as const, text: sections.join("\n") }],
    details: { ok: true, returnedCount, shownCount: shown.length, totalUnknown, exact: Boolean(exactHit) },
  };
}

// ---------------------------------------------------------------------------
// tokensave_search
// ---------------------------------------------------------------------------

const searchParams = Type.Object({
  query: Type.String({ description: "Conceptual, keyword, or identifier search query" }),
  literal: Type.Optional(Type.Boolean({ description: "Exact-substring search over source text (runtime error strings)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default 10)" })),
  pathInclude: Type.Optional(Type.Array(Type.String())),
  pathExclude: Type.Optional(Type.Array(Type.String())),
});

async function executeSearch(
  _toolCallId: string,
  params: Static<typeof searchParams>,
  signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
  getState: GetState,
) {
  const blocked = guardCheckNotInitialized(ctx);
  if (blocked) return blocked;

  const limit = params.limit ?? 10;
  const result = await callTool("search", { query: params.query, literal: params.literal, limit: limit + 1, pathInclude: params.pathInclude, pathExclude: params.pathExclude }, ctx, signal);

  if (!result.ok) {
    recordConsultation(getState(), params.query, false);
    return { content: [{ type: "text" as const, text: errorText(result) }], details: { ok: false, kind: result.kind } };
  }

  const decoded = decodeSearchResponse(result);

  if (decoded.kind === "text") {
    recordConsultation(getState(), params.query, false);
    return { content: [{ type: "text" as const, text: decoded.text }], details: { ok: true, count: 0 } };
  }

  if (decoded.kind === "unknown") {
    recordConsultation(getState(), params.query, false);
    return {
      content: [{ type: "text" as const, text: `TokenSave search returned an unrecognized response shape for '${params.query}'.` }],
      details: { ok: true, count: 0 },
    };
  }

  if (decoded.kind === "literal") {
    const shown = decoded.matches.slice(0, limit);
    recordConsultation(getState(), params.query, shown.length > 0);

    if (shown.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No literal matches for '${params.query}'. Raw grep fallback is allowed now.` }],
        details: { ok: true, count: 0 },
      };
    }

    const lines = shown.map(
      (match) => `- ${match.file ?? "?"}${match.line !== undefined ? `:${match.line}` : ""} — ${match.text ?? ""}${match.enclosing ? ` (in ${match.enclosing})` : ""}`,
    );
    const hasMore = decoded.count !== undefined && decoded.count > shown.length;
    const note = truncationNote(shown.length, decoded.count, hasMore && decoded.count === undefined);
    const text = [`Literal search results for '${params.query}'`, "", ...lines, ...(note ? ["", note] : [])].join("\n");
    return { content: [{ type: "text" as const, text }], details: { ok: true, count: shown.length, truncated: hasMore } };
  }

  const items = decoded.items;
  const hasMore = items.length > limit;
  const shown = items.slice(0, limit);
  recordConsultation(getState(), params.query, shown.length > 0);

  if (shown.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No results for '${params.query}'. Raw grep fallback is allowed now.` }],
      details: { ok: true, count: 0 },
    };
  }

  const lines = shown.map((entry) => `- ${entry.name ?? "?"} (${entry.kind ?? "?"}) — ${entry.file ?? "?"}${entry.line !== undefined ? `:${entry.line}` : ""}`);

  const note = truncationNote(shown.length, undefined, hasMore);
  const text = [`Search results for '${params.query}'`, "", ...lines, ...(note ? ["", note] : [])].join("\n");

  return { content: [{ type: "text" as const, text }], details: { ok: true, count: shown.length, truncated: hasMore } };
}

// ---------------------------------------------------------------------------
// tokensave_symbol
// ---------------------------------------------------------------------------

const symbolParams = Type.Object({
  name: Type.Optional(Type.String()),
  nodeId: Type.Optional(Type.String()),
  includeBody: Type.Optional(Type.Boolean()),
  includeCallers: Type.Optional(Type.Boolean()),
  includeCallees: Type.Optional(Type.Boolean()),
  includeImplementations: Type.Optional(Type.Boolean()),
  maxDepth: Type.Optional(Type.Number({ description: "Traversal depth for callers/callees (default 1)" })),
  limit: Type.Optional(Type.Number({ description: "Max related items per relationship (default 10)" })),
});

interface ResolvedSymbol {
  id: string | undefined;
  base: NodeDetailsLike | undefined;
  name: string | undefined;
  notFoundText?: string;
  ambiguousText?: string;
  error?: Extract<TokensaveRunResult, { ok: false }>;
}

type NodeDetailsLike = { name?: string; kind?: string; file?: string; line?: number; start_line?: number; signature?: string; qualified_name?: string };

type ImplementationLookupKind = "trait" | "function" | "type" | "unsupported";

const TRAIT_LOOKUP_KINDS = new Set(["trait", "interface", "interface_type"]);
const METHOD_LOOKUP_KINDS = new Set([
  "function",
  "method",
  "struct_method",
  "abstract_method",
  "arrow_function",
  "constructor",
  "procedure",
]);
const CONCRETE_LOOKUP_KINDS = new Set([
  "class",
  "inner_class",
  "struct",
  "record",
  "pascal_record",
  "case_class",
  "data_class",
  "sealed_class",
  "enum",
  "union",
  "typedef",
  "type_alias",
]);

/**
 * Maps a resolved symbol's kind to the correct TokenSave implementation
 * lookup: traits/interfaces and functions/methods use `implementations`
 * (with `trait`/`method` respectively); concrete types use `impls`. Unknown
 * kinds return `unsupported` rather than defaulting to a concrete-type
 * lookup that would be meaningless for e.g. a field or module.
 */
function classifyImplementationLookupKind(kind: string | undefined): ImplementationLookupKind {
  const normalized = (kind ?? "").toLowerCase();
  if (TRAIT_LOOKUP_KINDS.has(normalized)) return "trait";
  if (METHOD_LOOKUP_KINDS.has(normalized)) return "function";
  if (CONCRETE_LOOKUP_KINDS.has(normalized)) return "type";
  return "unsupported";
}

/**
 * Renders one trait/interface implementation entry. Real entries frequently
 * have no top-level `signature` (the concrete type and its methods carry the
 * detail), so we never emit a bare "- ? — file": we fall back to the type,
 * name, qualified name, or the location itself for the header line.
 */
/**
 * Renders one concrete-type `impls` entry. Real entries frequently lack a
 * top-level `signature`, so instead of emitting a bare "- ? — file" we fall
 * back through: signature, "type implements trait", qualified name, type,
 * then the file location itself.
 */
function formatImplEntry(entry: ImplEntry): string {
  const location = entry.file ? `${entry.file}${entry.start_line !== undefined ? `:${entry.start_line}` : ""}` : undefined;
  const typeAndTrait = entry.type && entry.trait ? `${entry.type} implements ${entry.trait}` : undefined;
  const label = entry.signature ?? typeAndTrait ?? entry.qualified_name ?? entry.type;
  if (label) return `- ${label}${location ? ` — ${location}` : ""}`;
  return location ? `- ${location}` : "- (implementation)";
}

function formatImplementationEntry(entry: ImplementationEntry): string[] {
  const location = entry.file ? `${entry.file}${entry.line !== undefined ? `:${entry.line}` : ""}` : undefined;
  const label = entry.signature ?? entry.type ?? entry.name ?? entry.qualified_name;
  const header = label ? `- ${label}${location ? ` — ${location}` : ""}` : location ? `- ${location}` : "- (implementation)";
  const lines = [header];
  if (entry.trait) lines.push(`  implements ${entry.trait}`);
  const methodNames = (entry.methods ?? []).map((method) => method.name).filter((name): name is string => Boolean(name));
  if (methodNames.length > 0) lines.push(`  methods: ${methodNames.join(", ")}`);
  return lines;
}

async function resolveNode(params: Static<typeof symbolParams>, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<ResolvedSymbol> {
  if (params.nodeId) {
    const node = await callTool("node", { nodeId: params.nodeId }, ctx, signal);
    if (!node.ok) return { id: params.nodeId, base: undefined, name: undefined, error: node };

    const decoded = decodeNodeResponse(node);
    if (decoded.kind === "object") {
      return { id: params.nodeId, base: decoded.node, name: decoded.node.name ?? decoded.node.qualified_name };
    }
    if (decoded.kind === "text") {
      return { id: params.nodeId, base: undefined, name: undefined, notFoundText: decoded.text };
    }
    return { id: params.nodeId, base: undefined, name: undefined };
  }

  if (params.name) {
    const resolution = await resolveSymbolByName(params.name, ctx, signal);
    if (resolution.ambiguous) {
      return { id: undefined, base: undefined, name: undefined, ambiguousText: formatAmbiguity(params.name, resolution.ambiguous) };
    }
    if (resolution.match) {
      return { id: resolution.match.id, base: resolution.match, name: resolution.match.name };
    }
  }

  return { id: undefined, base: undefined, name: undefined };
}

async function executeSymbol(
  _toolCallId: string,
  params: Static<typeof symbolParams>,
  signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
  getState: GetState,
) {
  const blocked = guardCheckNotInitialized(ctx);
  if (blocked) return blocked;
  if (!params.name && !params.nodeId) {
    return { content: [{ type: "text" as const, text: "Provide either 'name' or 'nodeId'." }], details: { ok: false } };
  }

  const resolved = await resolveNode(params, ctx, signal);
  recordConsultation(getState(), params.name ?? params.nodeId ?? "", Boolean(resolved.id));

  if (resolved.ambiguousText) {
    return { content: [{ type: "text" as const, text: resolved.ambiguousText }], details: { ok: true, resolved: false, ambiguous: true } };
  }

  if (!resolved.id) {
    return {
      content: [{ type: "text" as const, text: `Could not resolve symbol '${params.name ?? params.nodeId}'. Try tokensave_search as a fallback.` }],
      details: { ok: true, resolved: false },
    };
  }

  if (resolved.notFoundText) {
    return { content: [{ type: "text" as const, text: resolved.notFoundText }], details: { ok: true, resolved: false } };
  }

  if (resolved.error) {
    return { content: [{ type: "text" as const, text: errorText(resolved.error) }], details: { ok: false, kind: resolved.error.kind } };
  }

  const depth = params.maxDepth ?? 1;
  const limit = params.limit ?? 10;
  const sections: string[] = [];
  const base = resolved.base;
  const resolvedName = resolved.name ?? params.name;

  if (base) {
    sections.push(`${resolvedName ?? resolved.id} (${base.kind ?? "symbol"})`);
    const line = nodeLine(base);
    if (base.file) sections.push(`- file: ${base.file}${line !== undefined ? `:${line}` : ""}`);
    if (base.signature) sections.push(`- signature: ${base.signature}`);
  } else {
    sections.push(`${resolvedName ?? resolved.id} (symbol)`);
  }

  // The body tool accepts qualified names and resolves them unambiguously,
  // so the qualified name is preferred for body lookup; a bare name can
  // reopen an unrelated same-named symbol elsewhere in the project. The
  // implementations/impls handlers, in contrast, use exact bare-name lookup,
  // so they must receive the bare symbol name.
  const bodyLookupName = base?.qualified_name ?? params.name ?? resolvedName;
  const implementationLookupName = base?.name ?? params.name ?? resolvedName;
  if (params.includeBody !== false && bodyLookupName) {
    const body = await callTool("body", { symbol: bodyLookupName, limit: 1 }, ctx, signal);
    if (body.ok) {
      const decoded = decodeBodyResponse(body);
      if (decoded.kind === "object" && decoded.body) sections.push("", "Body:", "```", decoded.body, "```");
      else if (decoded.kind === "text") sections.push("", decoded.text);
    } else {
      sections.push("", `Body lookup failed: ${errorText(body)}`);
    }
  }

  if (params.includeCallers) {
    const callers = await callTool("callers", { nodeId: resolved.id, maxDepth: depth }, ctx, signal);
    if (callers.ok) {
      const decoded = decodeRelatedListResponse(callers);
      if (decoded.kind === "array") {
        const list = decoded.items.slice(0, limit);
        sections.push("", `Callers (${list.length}):`, ...list.map((c) => `- ${c.name ?? "?"} — ${c.file ?? "?"}:${c.line ?? "?"}`));
      } else if (decoded.kind === "text") {
        sections.push("", decoded.text);
      }
    } else {
      sections.push("", `Callers lookup failed: ${errorText(callers)}`);
    }
  }

  if (params.includeCallees) {
    const callees = await callTool("callees", { nodeId: resolved.id, maxDepth: depth }, ctx, signal);
    if (callees.ok) {
      const decoded = decodeRelatedListResponse(callees);
      if (decoded.kind === "array") {
        const list = decoded.items.slice(0, limit);
        sections.push("", `Callees (${list.length}):`, ...list.map((c) => `- ${c.name ?? "?"} — ${c.file ?? "?"}:${c.line ?? "?"}`));
      } else if (decoded.kind === "text") {
        sections.push("", decoded.text);
      }
    } else {
      sections.push("", `Callees lookup failed: ${errorText(callees)}`);
    }
  }

  if (params.includeImplementations && implementationLookupName) {
    const lookupKind = classifyImplementationLookupKind(base?.kind);

    if (lookupKind === "unsupported") {
      sections.push("", `Implementation lookup is not supported for kind '${base?.kind ?? "unknown"}'.`);
    } else if (lookupKind === "type") {
      const impls = await callTool("impls", { type: implementationLookupName, limit }, ctx, signal);
      if (impls.ok) {
        const decoded = decodeImplsResponse(impls);
        if (decoded.kind === "object") {
          const list = decoded.impls.slice(0, limit);
          sections.push("", `Implementations (${decoded.count ?? list.length}):`, ...list.map(formatImplEntry));
          const note = truncationNote(list.length, decoded.count);
          if (note) sections.push("", note);
        } else if (decoded.kind === "text") {
          sections.push("", decoded.text);
        }
      } else {
        sections.push("", `Implementations lookup failed: ${errorText(impls)}`);
      }
    } else {
      const argKey = lookupKind === "trait" ? "trait" : "method";
      const impls = await callTool("implementations", { [argKey]: implementationLookupName, limit }, ctx, signal);
      if (impls.ok) {
        const decoded = decodeImplementationsResponse(impls);
        if (decoded.kind === "object") {
          const list = decoded.implementations.slice(0, limit);
          sections.push("", `Implementations (${decoded.matchCount ?? list.length}):`, ...list.flatMap(formatImplementationEntry));
          const note = truncationNote(list.length, decoded.matchCount);
          if (note) sections.push("", note);
        } else if (decoded.kind === "text") {
          sections.push("", decoded.text);
        }
      } else {
        sections.push("", `Implementations lookup failed: ${errorText(impls)}`);
      }
    }
  }

  sections.push("", "TokenSave context does not replace reading the actual source file.");

  return { content: [{ type: "text" as const, text: sections.join("\n") }], details: { ok: true, nodeId: resolved.id } };
}

// ---------------------------------------------------------------------------
// tokensave_impact
// ---------------------------------------------------------------------------

const impactParams = Type.Object({
  name: Type.Optional(Type.String()),
  nodeId: Type.Optional(Type.String()),
  file: Type.Optional(Type.String()),
  maxDepth: Type.Optional(Type.Number({ description: "Impact traversal depth (default 2)" })),
  limit: Type.Optional(Type.Number({ description: "Max impacted symbols/tests to list (default 20)" })),
  includeTests: Type.Optional(Type.Boolean({ description: "Also include affected test files" })),
});

async function executeImpact(
  _toolCallId: string,
  params: Static<typeof impactParams>,
  signal: AbortSignal | undefined,
  _onUpdate: unknown,
  ctx: ExtensionContext,
  getState: GetState,
) {
  const blocked = guardCheckNotInitialized(ctx);
  if (blocked) return blocked;
  if (!params.name && !params.nodeId && !params.file) {
    return { content: [{ type: "text" as const, text: "Provide 'name', 'nodeId', or 'file'." }], details: { ok: false } };
  }

  const depth = params.maxDepth ?? 2;
  const limit = params.limit ?? 20;
  const sections: string[] = [];
  let consultedOk = false;
  let resolvedFile = params.file;

  if (params.name || params.nodeId) {
    let nodeId = params.nodeId;
    let ambiguousText: string | undefined;
    if (!nodeId && params.name) {
      const resolution = await resolveSymbolByName(params.name, ctx, signal);
      if (resolution.ambiguous) {
        ambiguousText = formatAmbiguity(params.name, resolution.ambiguous);
      } else if (resolution.match) {
        nodeId = resolution.match.id;
        resolvedFile = resolvedFile ?? resolution.match.file;
      }
    }

    if (nodeId) {
      const impact = await callTool("impact", { nodeId, maxDepth: depth }, ctx, signal);
      consultedOk = impact.ok;
      if (impact.ok) {
        const decoded = decodeImpactResponse(impact);
        if (decoded.kind === "object") {
          const list = decoded.nodes.slice(0, limit);
          sections.push(`Impact radius: ${decoded.nodeCount ?? list.length} symbol(s)`, "", ...list.map((n) => `- ${n.name ?? "?"} — ${n.file ?? "?"}:${n.line ?? "?"}`));
          const note = truncationNote(list.length, decoded.nodeCount);
          if (note) sections.push("", note);
        } else if (decoded.kind === "text") {
          sections.push(decoded.text);
        } else {
          sections.push("TokenSave impact returned an unrecognized response shape.");
        }
      } else {
        sections.push(errorText(impact));
      }

      if (params.includeTests && !resolvedFile) {
        const node = await callTool("node", { nodeId }, ctx, signal);
        if (node.ok) {
          const decoded = decodeNodeResponse(node);
          if (decoded.kind === "object") resolvedFile = decoded.node.file;
        }
      }
    } else if (ambiguousText) {
      sections.push(ambiguousText);
    } else {
      sections.push(`Could not resolve symbol '${params.name ?? params.nodeId}' to compute impact.`);
    }
  } else if (params.file) {
    const dependents = await callTool("file_dependents", { file: params.file, depth }, ctx, signal);
    consultedOk = dependents.ok;
    if (dependents.ok) {
      const decoded = decodeFileDependentsResponse(dependents);
      if (decoded.kind === "object" || decoded.kind === "array") {
        const list = decoded.dependents.slice(0, limit);
        const total = decoded.kind === "object" ? decoded.count : undefined;
        sections.push(`File dependents (${total ?? list.length}):`, "", ...list.map((d) => `- ${d.name ?? d.file ?? "?"}${d.name && d.file ? ` — ${d.file}` : ""}`));
        const note = truncationNote(list.length, total);
        if (note) sections.push("", note);
      } else if (decoded.kind === "text") {
        sections.push(decoded.text);
      } else {
        sections.push("TokenSave file dependents returned an unrecognized response shape.");
      }
    } else {
      sections.push(errorText(dependents));
    }

    const diff = await callTool("diff_context", { files: [params.file], depth }, ctx, signal);
    consultedOk = consultedOk || diff.ok;
    if (diff.ok) {
      const decoded = decodeDiffContextResponse(diff);
      if (decoded.kind === "object") {
        const impacted = decoded.impactedSymbols.slice(0, limit);
        sections.push(
          "",
          `Directly modified symbols (${decoded.modifiedSymbols.length}):`,
          ...decoded.modifiedSymbols.slice(0, limit).map((n) => `- ${n.name ?? "?"} (${n.kind ?? "?"})`),
        );
        if (impacted.length > 0) {
          sections.push("", `Downstream impacted symbols (${decoded.impactedCount ?? impacted.length}):`, ...impacted.map((n) => `- ${n.name ?? "?"} — ${n.file ?? "?"}:${n.line ?? "?"}`));
          const note = truncationNote(impacted.length, decoded.impactedCount);
          if (note) sections.push("", note);
        }
      } else if (decoded.kind === "text") {
        sections.push("", decoded.text);
      }
    } else {
      sections.push("", errorText(diff));
    }
  }

  if (params.includeTests) {
    const testFile = resolvedFile ?? params.file;
    if (testFile) {
      const affected = await callTool("affected", { files: [testFile], depth }, ctx, signal);
      if (affected.ok) {
        const decoded = decodeAffectedResponse(affected);
        if (decoded.kind === "object") {
          const list = decoded.affectedTests.slice(0, limit);
          sections.push("", `Affected tests (${decoded.count ?? list.length}):`, ...list.map((t) => `- ${t}`));
          const note = truncationNote(list.length, decoded.count);
          if (note) sections.push("", note);
        } else if (decoded.kind === "text") {
          sections.push("", decoded.text);
        }
      } else {
        sections.push("", `Affected-tests lookup failed: ${errorText(affected)}`);
      }
    } else {
      sections.push("", "Affected tests were requested but no file could be resolved for this symbol.");
    }
  }

  recordConsultation(getState(), params.name ?? params.file ?? params.nodeId ?? "", consultedOk || sections.length > 0);

  sections.push("", "Verify actual callers, affected files, and tests before editing.");
  return { content: [{ type: "text" as const, text: sections.join("\n") }], details: { ok: true } };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTokensaveTools(pi: ExtensionAPI, getState: GetState): void {
  pi.registerTool({
    name: "tokensave_status",
    label: "TokenSave Status",
    description: "Check whether TokenSave is installed, initialized for this project, and report basic graph statistics.",
    promptGuidelines: [
      "Call tokensave_status when TokenSave tools fail, when the graph may be unavailable, or before falling back to broad manual exploration.",
    ],
    parameters: statusParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeStatus(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    name: "tokensave_context",
    label: "TokenSave Context",
    description: "Build AI-ready context for a task: relevant symbols, relationships, and optionally code snippets.",
    promptGuidelines: [
      "STEP 1 — ORIENT. Call tokensave_context before exploring an unfamiliar subsystem, planning a change, or opening several files. Do not begin broad grep, find, glob, or speculative file reads first. After tokensave_context identifies relevant files and symbols, read the actual source files before making claims or modifying code.",
    ],
    parameters: contextParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeContext(toolCallId, params, signal, onUpdate, ctx, getState);
    },
  });

  pi.registerTool({
    name: "tokensave_find_symbol",
    label: "TokenSave Find Symbol",
    description: "Locate a named class, function, method, model, interface, type, or constant. Prioritizes exact matches.",
    promptGuidelines: [
      "STEP 1 — LOCATE. Use tokensave_find_symbol for any named class, function, method, model, interface, constant, type, or symbol. Do not guess a path. Do not grep for the symbol first. After locating it, read the returned source file before answering implementation questions or editing code.",
    ],
    parameters: findSymbolParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeFindSymbol(toolCallId, params, signal, onUpdate, ctx, getState);
    },
  });

  pi.registerTool({
    name: "tokensave_search",
    label: "TokenSave Search",
    description: "Conceptual, keyword, or literal code search when no exact symbol name is known.",
    promptGuidelines: [
      "Use tokensave_search before raw grep for conceptual code search, identifiers, runtime strings, and likely implementation locations. Raw grep remains valid for complex regular expressions, logs, generated files, configuration files, non-indexed content, or after tokensave_search returned no useful result.",
    ],
    parameters: searchParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeSearch(toolCallId, params, signal, onUpdate, ctx, getState);
    },
  });

  pi.registerTool({
    name: "tokensave_symbol",
    label: "TokenSave Symbol Detail",
    description: "Compact view of a symbol: signature, body, callers, callees, and implementations, resolved by name or node id.",
    promptGuidelines: [
      "Use tokensave_symbol after locating a symbol when its implementation and direct relationships are needed. TokenSave context does not replace reading the actual source file.",
    ],
    parameters: symbolParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeSymbol(toolCallId, params, signal, onUpdate, ctx, getState);
    },
  });

  pi.registerTool({
    name: "tokensave_impact",
    label: "TokenSave Impact",
    description: "Analyze the blast radius of changing a symbol or file: dependents, callers, and affected tests.",
    promptGuidelines: [
      "STEP 2 — ASSESS. Call tokensave_impact before changing shared logic, public APIs, models, services, or high-dependency files. After receiving the result, verify the actual callers, affected source files, and tests before editing.",
    ],
    parameters: impactParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeImpact(toolCallId, params, signal, onUpdate, ctx, getState);
    },
  });
}
