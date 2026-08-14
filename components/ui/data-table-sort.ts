// Pure sort-toggle state machine, kept out of data-table-column-header.tsx (a "use client"
// module that pulls in lucide-react + @tanstack/react-table) so it stays trivially
// importable from bun test with no client/runtime deps.
export function nextSortDir(cur: false | "asc" | "desc"): false | "asc" | "desc" {
  return cur === false ? "asc" : cur === "asc" ? "desc" : false;
}
