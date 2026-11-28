// Same bound as stored file-change diffs: the prompt is persisted and sent on every snapshot.
const MAX_FILE_CHANGE_APPROVAL_PROMPT_LENGTH = 32_768;

// A code-unit slice can split a surrogate pair, so drop a trailing lone high surrogate.
export function withoutTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

export function boundFileChangeApprovalPrompt(
  text: string,
  limit = MAX_FILE_CHANGE_APPROVAL_PROMPT_LENGTH,
): string {
  if (text.length <= limit) return text;
  const footer = (omitted: number) =>
    `\n… ${omitted.toLocaleString("en-US")} more characters are not shown`;
  let sliceLength = Math.max(0, limit - footer(text.length - limit).length);
  let kept = withoutTrailingHighSurrogate(text.slice(0, sliceLength));
  let notice = footer(text.length - kept.length);
  if (kept.length + notice.length > limit) {
    sliceLength = Math.max(0, limit - notice.length);
    kept = withoutTrailingHighSurrogate(text.slice(0, sliceLength));
    notice = footer(text.length - kept.length);
  }
  return `${kept}${notice}`;
}

export function formatWriteApprovalText(filePath: string, content: string): string {
  return `Write replaces ${filePath} with:\n${content}`;
}

export function formatWriteApprovalPreview(filePath: string, content: string): string {
  return boundFileChangeApprovalPrompt(formatWriteApprovalText(filePath, content));
}

export function isUnifiedDiffText(text: string): boolean {
  let sawHeader = false;
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    if (line.startsWith("diff --git ")) return true;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      sawHeader = true;
    } else if (sawHeader && line.startsWith("@@ ")) {
      return true;
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return false;
}
