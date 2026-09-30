import {
  flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel,
  useReactTable, type ColumnDef, type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { EmptyState } from "./misc";

export function DataTable<T>({ data, columns, onRowClick, pageSize = 15, searchPlaceholder = "Filter…", empty = "Nothing to show", toolbar }: {
  data: T[]; columns: ColumnDef<T, unknown>[]; onRowClick?: (row: T) => void; pageSize?: number;
  searchPlaceholder?: string; empty?: string; toolbar?: React.ReactNode;
}) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [filter, setFilter] = React.useState("");
  const table = useReactTable({
    data, columns, state: { sorting, globalFilter: filter },
    onSortingChange: setSorting, onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(), getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });
  const rows = table.getRowModel().rows;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={searchPlaceholder} className="max-w-xs" />
        {toolbar}
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">{table.getFilteredRowModel().rows.length} rows</span>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const dir = h.column.getIsSorted();
                  return (
                    <th key={h.id} scope="col" aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"} className="px-3 py-2 font-medium">
                      {h.column.getCanSort() ? (
                        <button type="button" className="inline-flex items-center gap-1 uppercase" onClick={h.column.getToggleSortingHandler()}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {dir === "asc" ? <ArrowUp className="size-3" /> : dir === "desc" ? <ArrowDown className="size-3" /> : null}
                        </button>
                      ) : flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={onRowClick ? "cursor-pointer border-t hover:bg-muted/40" : "border-t"}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={() => onRowClick?.(r.original)}
                onKeyDown={(e) => { if (onRowClick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onRowClick(r.original); } }}>
                {r.getVisibleCells().map((c) => <td key={c.id} className="px-3 py-2 align-top">{flexRender(c.column.columnDef.cell, c.getContext())}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <EmptyState title={empty} /> : null}
      </div>
      {table.getPageCount() > 1 ? (
        <div className="flex items-center justify-end gap-2">
          <Button size="icon" variant="outline" aria-label="Previous page" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}><ChevronLeft className="size-4" /></Button>
          <span className="text-xs text-muted-foreground">Page {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}</span>
          <Button size="icon" variant="outline" aria-label="Next page" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}><ChevronRight className="size-4" /></Button>
        </div>
      ) : null}
    </div>
  );
}
