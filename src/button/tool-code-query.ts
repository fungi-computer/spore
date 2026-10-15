import { queryOptions } from "@tanstack/react-query";
import { formatToolCode } from "./presentation.js";

/** Formatting varies with source and viewport; unmounted code retains no cache. */
export function toolCodeQuery(content: string, width: number) {
  return queryOptions({
    queryKey: ["tui-tool-code", content, width],
    queryFn: () => formatToolCode(content, width),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
}
