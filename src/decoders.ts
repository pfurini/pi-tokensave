/**
 * Strict, non-throwing decoders for every TokenSave response shape the
 * plugin consumes. TokenSave's JSON responses are not versioned against this
 * plugin, so every decoder here must tolerate:
 *
 *  - the expected JSON object shape,
 *  - the expected JSON array shape,
 *  - TokenSave's plain-text "no match" response (markdown, not JSON),
 *  - an oversized/truncated inner payload represented as text by the runner,
 *  - missing fields, and
 *  - unrecognized extra fields.
 *
 * None of these functions ever throw. A shape mismatch degrades to a
 * `{ kind: "text" }` or `{ kind: "unknown" }` result that callers can render
 * safely, instead of a JavaScript TypeError.
 */

import type { TokensaveRunOk } from "./runner.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Normalizes an unknown array into `T[]` by mapping only entries that are
 * plain objects through `mapper`, silently dropping anything else (null,
 * numbers, strings, arrays). Used everywhere a TokenSave array field is
 * expected to contain objects, so a single malformed/foreign entry can never
 * reach formatting or ranking code and throw.
 */
function normalizeRecordArray<T>(value: unknown, mapper: (record: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    if (isRecord(entry)) out.push(mapper(entry));
  }
  return out;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// tokensave_search (search tool: normal-array or literal-object response)
// ---------------------------------------------------------------------------

export interface SearchArrayItem {
  id?: string;
  name: string;
  qualified_name?: string;
  kind?: string;
  file?: string;
  line?: number;
  signature?: string;
  score?: number;
}

export interface LiteralSearchMatch {
  file?: string;
  line?: number;
  text?: string;
  enclosing?: string;
  enclosing_id?: string;
}

export type DecodedSearch =
  | { kind: "array"; items: SearchArrayItem[] }
  | { kind: "literal"; matches: LiteralSearchMatch[]; count?: number }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

/**
 * A search result without a usable non-empty string `name` cannot be ranked,
 * shown, or reused as an exact-symbol candidate, so it is dropped here rather
 * than surfaced downstream as a half-formed `{ name: undefined }` object.
 */
function normalizeSearchArrayItem(record: Record<string, unknown>): SearchArrayItem | undefined {
  const name = asString(record.name);
  if (!name) return undefined;
  return {
    id: asString(record.id),
    name,
    qualified_name: asString(record.qualified_name),
    kind: asString(record.kind),
    file: asString(record.file),
    line: asNumber(record.line),
    signature: asString(record.signature),
    score: asNumber(record.score),
  };
}

function normalizeSearchArrayItems(value: unknown): SearchArrayItem[] {
  return normalizeRecordArray(value, normalizeSearchArrayItem).filter((item): item is SearchArrayItem => item !== undefined);
}

function normalizeLiteralSearchMatch(record: Record<string, unknown>): LiteralSearchMatch {
  return {
    file: asString(record.file),
    line: asNumber(record.line),
    text: asString(record.text),
    enclosing: asString(record.enclosing),
    enclosing_id: asString(record.enclosing_id),
  };
}

export function decodeSearchResponse(result: TokensaveRunOk): DecodedSearch {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  const data = result.data;

  if (Array.isArray(data)) {
    return { kind: "array", items: normalizeSearchArrayItems(data) };
  }

  if (isRecord(data) && data.literal === true) {
    return { kind: "literal", matches: normalizeRecordArray(data.matches, normalizeLiteralSearchMatch), count: asNumber(data.count) };
  }

  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// find_exact_symbol
// ---------------------------------------------------------------------------

export interface ExactSymbolMatch {
  id?: string;
  name: string;
  qualified_name?: string;
  kind?: string;
  file?: string;
  line?: number;
  signature?: string;
}

export type DecodedExactSymbol =
  | { kind: "object"; matches: ExactSymbolMatch[]; count?: number }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

/**
 * A match without a usable non-empty string `name` cannot be ranked, shown,
 * or resolved by name, so it is dropped here rather than passed downstream
 * as a half-formed object that later code would need to guard against.
 */
function normalizeExactSymbolMatch(record: Record<string, unknown>): ExactSymbolMatch | undefined {
  const name = asString(record.name);
  if (!name) return undefined;
  return {
    id: asString(record.id),
    name,
    qualified_name: asString(record.qualified_name),
    kind: asString(record.kind),
    file: asString(record.file),
    line: asNumber(record.line),
    signature: asString(record.signature),
  };
}

function normalizeExactSymbolMatches(value: unknown): ExactSymbolMatch[] {
  return normalizeRecordArray(value, normalizeExactSymbolMatch).filter((match): match is ExactSymbolMatch => match !== undefined);
}

export function decodeExactSymbolResponse(result: TokensaveRunOk): DecodedExactSymbol {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  const data = result.data;
  if (isRecord(data)) {
    return { kind: "object", matches: normalizeExactSymbolMatches(data.matches), count: asNumber(data.count) };
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// by_qualified_name
// ---------------------------------------------------------------------------

/**
 * The real TokenSave `by_qualified_name` handler returns a *direct array* of
 * symbol records keyed by `node_id`/`start_line`, not a node object and not
 * the `{ matches }` envelope of find_exact_symbol. Decoding that array with
 * `decodeNodeResponse` (a single-object decoder) is wrong, so this dedicated
 * decoder normalizes the array (and a legacy `{ matches }` fallback) to the
 * same ExactSymbolMatch candidate type the central resolver ranks.
 */
function normalizeQualifiedNameMatch(record: Record<string, unknown>): ExactSymbolMatch | undefined {
  const name = asString(record.name);
  if (!name) return undefined;
  return {
    // `node_id` is the official ID field; `id` is a forward-compatible alias.
    id: asString(record.node_id) ?? asString(record.id),
    name,
    qualified_name: asString(record.qualified_name),
    kind: asString(record.kind),
    file: asString(record.file),
    // `start_line` is the official line field; `line` is an alias.
    line: asNumber(record.start_line) ?? asNumber(record.line),
    signature: asString(record.signature),
  };
}

function normalizeQualifiedNameMatches(value: unknown): ExactSymbolMatch[] {
  return normalizeRecordArray(value, normalizeQualifiedNameMatch).filter((match): match is ExactSymbolMatch => match !== undefined);
}

export function decodeQualifiedNameResponse(result: TokensaveRunOk): DecodedExactSymbol {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  const data = result.data;
  // Official top-level array shape.
  if (Array.isArray(data)) {
    return { kind: "object", matches: normalizeQualifiedNameMatches(data) };
  }
  // Optional legacy `{ matches: [...] }` compatibility fallback.
  if (isRecord(data) && Array.isArray(data.matches)) {
    return { kind: "object", matches: normalizeQualifiedNameMatches(data.matches), count: asNumber(data.count) };
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// node / tokensave_symbol resolution
// ---------------------------------------------------------------------------

export interface NodeDetails {
  name?: string;
  kind?: string;
  file?: string;
  /** Present on exact-symbol matches. */
  line?: number;
  /** Present on `node` lookups. */
  start_line?: number;
  signature?: string;
  qualified_name?: string;
}

export type DecodedNode = { kind: "object"; node: NodeDetails } | { kind: "text"; text: string } | { kind: "unknown" };

function normalizeNodeDetails(record: Record<string, unknown>): NodeDetails {
  return {
    name: asString(record.name),
    kind: asString(record.kind),
    file: asString(record.file),
    line: asNumber(record.line),
    start_line: asNumber(record.start_line),
    signature: asString(record.signature),
    qualified_name: asString(record.qualified_name),
  };
}

export function decodeNodeResponse(result: TokensaveRunOk): DecodedNode {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  if (isRecord(result.data)) return { kind: "object", node: normalizeNodeDetails(result.data) };
  return { kind: "unknown" };
}

export function nodeLine(node: NodeDetails): number | undefined {
  return node.start_line ?? node.line;
}

// ---------------------------------------------------------------------------
// body
// ---------------------------------------------------------------------------

export type DecodedBody =
  | { kind: "object"; body?: string }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

export function decodeBodyResponse(result: TokensaveRunOk): DecodedBody {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  const data = result.data;
  if (isRecord(data)) {
    const matches = Array.isArray(data.matches) ? (data.matches as Array<{ body?: unknown }>) : [];
    return { kind: "object", body: asString(matches[0]?.body) };
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// callers / callees
// ---------------------------------------------------------------------------

export interface RelatedSymbol {
  name?: string;
  file?: string;
  line?: number;
}

export type DecodedRelatedList =
  | { kind: "array"; items: RelatedSymbol[] }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

function normalizeRelatedSymbol(record: Record<string, unknown>): RelatedSymbol {
  return { name: asString(record.name), file: asString(record.file), line: asNumber(record.line) };
}

export function decodeRelatedListResponse(result: TokensaveRunOk): DecodedRelatedList {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  if (Array.isArray(result.data)) return { kind: "array", items: normalizeRecordArray(result.data, normalizeRelatedSymbol) };
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// implementations
// ---------------------------------------------------------------------------

export interface ImplementationMethod {
  name?: string;
  signature?: string;
  body?: string;
}

export interface ImplementationEntry {
  type?: string;
  name?: string;
  qualified_name?: string;
  kind?: string;
  file?: string;
  line?: number;
  signature?: string;
  trait?: string;
  methods?: ImplementationMethod[];
}

export type DecodedImplementations =
  | { kind: "object"; implementations: ImplementationEntry[]; matchCount?: number }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

function normalizeImplementationMethod(record: Record<string, unknown>): ImplementationMethod {
  return { name: asString(record.name), signature: asString(record.signature), body: asString(record.body) };
}

function normalizeImplementationEntry(record: Record<string, unknown>): ImplementationEntry {
  return {
    type: asString(record.type),
    name: asString(record.name),
    qualified_name: asString(record.qualified_name),
    kind: asString(record.kind),
    file: asString(record.file),
    line: asNumber(record.line),
    signature: asString(record.signature),
    trait: asString(record.trait),
    methods: Array.isArray(record.methods) ? normalizeRecordArray(record.methods, normalizeImplementationMethod) : undefined,
  };
}

export function decodeImplementationsResponse(result: TokensaveRunOk): DecodedImplementations {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  const data = result.data;

  if (isRecord(data) && Array.isArray(data.implementations)) {
    return {
      kind: "object",
      implementations: normalizeRecordArray(data.implementations, normalizeImplementationEntry),
      matchCount: asNumber(data.match_count),
    };
  }

  if (Array.isArray(data)) {
    return { kind: "object", implementations: normalizeRecordArray(data, normalizeImplementationEntry) };
  }

  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// impls (tokensave_impls: type/struct/class -> trait implementation blocks)
// ---------------------------------------------------------------------------

export interface ImplEntry {
  impl_id?: string;
  type?: string;
  qualified_name?: string;
  trait?: string;
  trait_qualified_name?: string;
  file?: string;
  start_line?: number;
  end_line?: number;
  signature?: string;
}

export type DecodedImpls =
  | { kind: "object"; impls: ImplEntry[]; count?: number; truncated?: boolean }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

function normalizeImplEntry(record: Record<string, unknown>): ImplEntry {
  return {
    impl_id: asString(record.impl_id),
    type: asString(record.type),
    qualified_name: asString(record.qualified_name),
    trait: asString(record.trait),
    trait_qualified_name: asString(record.trait_qualified_name),
    file: asString(record.file),
    start_line: asNumber(record.start_line),
    end_line: asNumber(record.end_line),
    signature: asString(record.signature),
  };
}

export function decodeImplsResponse(result: TokensaveRunOk): DecodedImpls {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  const data = result.data;
  if (isRecord(data)) {
    return {
      kind: "object",
      impls: normalizeRecordArray(data.impls, normalizeImplEntry),
      count: asNumber(data.count),
      truncated: typeof data.truncated === "boolean" ? data.truncated : undefined,
    };
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// impact
// ---------------------------------------------------------------------------

export interface ImpactNode {
  name?: string;
  file?: string;
  line?: number;
  kind?: string;
}

export type DecodedImpact =
  | { kind: "object"; nodes: ImpactNode[]; nodeCount?: number }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

function normalizeImpactNode(record: Record<string, unknown>): ImpactNode {
  return { name: asString(record.name), file: asString(record.file), line: asNumber(record.line), kind: asString(record.kind) };
}

export function decodeImpactResponse(result: TokensaveRunOk): DecodedImpact {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  const data = result.data;
  if (isRecord(data)) {
    return { kind: "object", nodes: normalizeRecordArray(data.nodes, normalizeImpactNode), nodeCount: asNumber(data.node_count) };
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// affected (affected_tests)
// ---------------------------------------------------------------------------

export type DecodedAffected =
  | { kind: "object"; changedFiles: string[]; affectedTests: string[]; count?: number }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

export function decodeAffectedResponse(result: TokensaveRunOk): DecodedAffected {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  const data = result.data;
  if (isRecord(data)) {
    return {
      kind: "object",
      changedFiles: isStringArray(data.changed_files) ? data.changed_files : [],
      affectedTests: isStringArray(data.affected_tests) ? data.affected_tests : [],
      count: asNumber(data.count),
    };
  }
  if (isStringArray(data)) {
    return { kind: "object", changedFiles: [], affectedTests: data };
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// file_dependents / diff_context (file-scoped impact tools)
// ---------------------------------------------------------------------------

export interface FileDependentEntry {
  file?: string;
  name?: string;
}

export type DecodedFileDependents =
  | { kind: "object"; dependents: FileDependentEntry[]; count?: number }
  | { kind: "array"; dependents: FileDependentEntry[] }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

/**
 * TokenSave v7.1.0's real `file_dependents` shape is `{ file, count,
 * dependents: string[] }` (bare paths). Object entries with `file`/`name`
 * are still accepted for forward compatibility, and any other entry shape
 * (null, number, ...) is dropped rather than surfaced as "?".
 */
function normalizeFileDependentEntry(entry: unknown): FileDependentEntry | undefined {
  if (typeof entry === "string") return { file: entry };
  if (isRecord(entry)) {
    const file = asString(entry.file);
    const name = asString(entry.name);
    if (file === undefined && name === undefined) return undefined;
    return { file, name };
  }
  return undefined;
}

function normalizeFileDependentList(value: unknown): FileDependentEntry[] {
  if (!Array.isArray(value)) return [];
  const out: FileDependentEntry[] = [];
  for (const entry of value) {
    const normalized = normalizeFileDependentEntry(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

export function decodeFileDependentsResponse(result: TokensaveRunOk): DecodedFileDependents {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  const data = result.data;
  if (Array.isArray(data)) return { kind: "array", dependents: normalizeFileDependentList(data) };
  if (isRecord(data)) {
    const list = Array.isArray(data.dependents)
      ? normalizeFileDependentList(data.dependents)
      : Array.isArray(data.files)
        ? normalizeFileDependentList(data.files)
        : [];
    return { kind: "object", dependents: list, count: asNumber(data.count) };
  }
  return { kind: "unknown" };
}

export type DecodedDiffContext =
  | {
      kind: "object";
      modifiedSymbols: ImpactNode[];
      impactedSymbols: ImpactNode[];
      impactedCount?: number;
    }
  | { kind: "text"; text: string }
  | { kind: "unknown" };

export function decodeDiffContextResponse(result: TokensaveRunOk): DecodedDiffContext {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  const data = result.data;
  if (isRecord(data)) {
    return {
      kind: "object",
      modifiedSymbols: normalizeRecordArray(data.modified_symbols, normalizeImpactNode),
      impactedSymbols: normalizeRecordArray(data.impacted_symbols, normalizeImpactNode),
      impactedCount: asNumber(data.impacted_symbols_count),
    };
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface StatusStats {
  node_count?: number;
  edge_count?: number;
  file_count?: number;
  db_size_bytes?: number;
}

export type DecodedStatus = { kind: "object"; stats: StatusStats } | { kind: "text"; text: string } | { kind: "unknown" };

export function decodeStatusResponse(result: TokensaveRunOk): DecodedStatus {
  if (result.isMarkdown) return { kind: "text", text: String(result.data) };
  if (isRecord(result.data)) return { kind: "object", stats: result.data as StatusStats };
  return { kind: "unknown" };
}
