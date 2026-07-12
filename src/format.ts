/**
 * Small text-formatting helpers shared by tool result rendering.
 * Kept dependency-free so it is trivial to unit test.
 */

export function section(title: string, lines: string[]): string {
  const body = lines.filter((line) => line.length > 0).join("\n");
  return body ? `${title}\n\n${body}` : title;
}

export function bulletList(entries: string[]): string[] {
  return entries.map((entry) => (entry.startsWith("- ") ? entry : `- ${entry}`));
}

export function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars).trimEnd()}\n…`, truncated: true };
}

/**
 * Describes a "returned N of M" truncation note. Pass `total` when the
 * upstream tool reports an exact count; otherwise pass `hasMore` from a
 * limit+1 probe so we never claim a false-precise total.
 */
export function truncationNote(returned: number, total?: number, hasMore?: boolean): string | undefined {
  if (total !== undefined && total > returned) {
    const omitted = total - returned;
    return `Returned ${returned} of ${total} results. ${omitted} result(s) omitted. Refine the query, kind, or path filters.`;
  }
  if (hasMore) {
    return `Returned ${returned} result(s). More results were available. Refine the query, kind, or path filters.`;
  }
  return undefined;
}

export function nextStepReadFile(file: string): string {
  return `Next step: read ${file} before making implementation claims.`;
}
