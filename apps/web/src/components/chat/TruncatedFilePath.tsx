import { toolGroupAction } from "@t3tools/client-runtime/work-log/presentation";

/**
 * Splits a single-line file path (including optional action prefix or count suffix) at its final
 * path separator so CSS can truncate the directory prefix while keeping the filename readable.
 */
function splitFilePathForTruncation(
  text: string,
): { readonly prefix: string; readonly suffix: string } | null {
  if (text.includes("\n") || text.includes("\r") || /^https?:\/\//i.test(text.trimStart())) {
    return null;
  }
  let end = text.length;
  const countSuffix = text.match(/ \+\d+ more$/);
  if (countSuffix !== null) {
    end -= countSuffix[0].length;
  }
  while (end > 0 && (text[end - 1] === "/" || text[end - 1] === "\\")) {
    end -= 1;
  }
  const sepIndex = Math.max(text.lastIndexOf("/", end - 1), text.lastIndexOf("\\", end - 1));
  if (sepIndex <= 0 || sepIndex >= text.length - 1) return null;
  return {
    prefix: text.slice(0, sepIndex),
    suffix: text.slice(sepIndex),
  };
}

export function usesFilePathTruncation(
  entry: Parameters<typeof toolGroupAction>[0] & { readonly itemType?: string },
): boolean {
  const action = toolGroupAction(entry);
  return entry.itemType === "file_change" || action === "read" || action === "edit";
}

export function TruncatedFilePath({ text }: { text: string }) {
  const split = splitFilePathForTruncation(text);
  if (!split) return <>{text}</>;
  return (
    <span className="inline-flex max-w-full min-w-0 items-baseline align-bottom">
      <span className="min-w-0 truncate">{split.prefix}</span>
      <span className="max-w-full shrink-0 truncate">{split.suffix}</span>
    </span>
  );
}
