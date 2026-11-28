import {
  type ApprovalTextPart,
  approvalTextParts,
} from "@t3tools/client-runtime/state/thread-requests";
import { isUnifiedDiffText } from "@t3tools/shared/approvalPrompt";
import { T, useGT } from "gt-react";
import { Fragment, useState } from "react";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

/**
 * What an approval asks to run, as it will run: characters a screen would not draw are shown by
 * name, and a note says when the text runs past its box. Text too long to show in full is shown
 * as its beginning and its end, with a note between them of how much is left out.
 */
interface ApprovalTextProps {
  text: string;
  label?: string;
  className?: string;
}

interface ApprovalTextLine {
  readonly lineText: string;
  readonly header?: true;
  readonly parts: ReadonlyArray<ApprovalTextPart>;
}

function splitApprovalPartsByLine(
  parts: ReadonlyArray<ApprovalTextPart>,
): ReadonlyArray<ApprovalTextLine> {
  const lines: ApprovalTextLine[] = [];
  let currentParts: ApprovalTextPart[] = [];
  let currentText = "";
  let seenHunk = false;
  const pushLine = () => {
    const isPatchStart = currentText.startsWith("diff --git ");
    if (isPatchStart) seenHunk = false;
    const isFileHeader =
      isPatchStart ||
      (!seenHunk && (currentText.startsWith("--- ") || currentText.startsWith("+++ ")));
    if (currentText.startsWith("@@ ")) seenHunk = true;
    lines.push({
      lineText: currentText,
      ...(isFileHeader ? { header: true as const } : {}),
      parts: currentParts,
    });
    currentParts = [];
    currentText = "";
  };
  for (const part of parts) {
    const segments = part.text.split("\n");
    for (let index = 0; index < segments.length; index += 1) {
      const hasNewline = index < segments.length - 1;
      const chunk = hasNewline ? `${segments[index]}\n` : segments[index]!;
      if (chunk !== "") {
        currentParts.push(part.named ? { text: chunk, named: true } : { text: chunk });
        currentText += chunk;
      }
      if (hasNewline) pushLine();
    }
  }
  if (currentParts.length > 0) pushLine();
  return lines;
}

function diffLineClassName(line: ApprovalTextLine): string | undefined {
  if (line.header) return "font-medium text-muted-foreground";
  if (line.lineText.startsWith("@@ ")) return "text-muted-foreground";
  if (line.lineText.startsWith("+")) {
    return "rounded-xs bg-diff-addition/12 text-diff-addition-foreground";
  }
  if (line.lineText.startsWith("-")) {
    return "rounded-xs bg-diff-deletion/12 text-diff-deletion-foreground";
  }
  return undefined;
}

function renderApprovalParts(parts: ReadonlyArray<ApprovalTextPart>) {
  return parts.map((part, index) =>
    part.named ? (
      // oxlint-disable-next-line react/no-array-index-key -- parts never reorder and two may read alike
      <span key={index} className="rounded-xs bg-warning-surface text-warning-foreground">
        {part.text}
      </span>
    ) : (
      part.text
    ),
  );
}

export function ApprovalText({
  summary,
  ...props
}: ApprovalTextProps & { summary?: string | undefined }) {
  const [open, setOpen] = useState(false);
  return summary ? (
    <>
      <span className="block text-foreground wrap-anywhere">{summary}</span>
      <details className="text-xs" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-muted-foreground">
          <T>Details</T>
        </summary>
        {open ? <ApprovalTextBody {...props} /> : null}
      </details>
    </>
  ) : (
    <ApprovalTextBody {...props} />
  );
}

function ApprovalTextBody({ text, label, className }: ApprovalTextProps) {
  const gt = useGT();
  const [clipped, setClipped] = useState(false);
  const [endClipped, setEndClipped] = useState(false);
  const { parts, tail, hiddenLength } = approvalTextParts(text);
  const isDiff = isUnifiedDiffText(text);
  const cut = hiddenLength > 0;
  return (
    <>
      <ApprovalTextBox
        parts={parts}
        label={label}
        className={className}
        detail={cut ? "cut" : "complete"}
        isDiff={isDiff}
        onClipped={setClipped}
      />
      {cut ? (
        <>
          <span className="block font-sans text-xs text-warning-foreground">
            {gt(
              "{count, plural, one {… {hidden} character in the middle is not shown.} other {… {hidden} characters in the middle are not shown.}} The text ends with:",
              { count: hiddenLength, hidden: hiddenLength.toLocaleString() },
            )}
          </span>
          <ApprovalTextBox
            parts={tail}
            className={className}
            detail="end"
            isDiff={isDiff}
            fromEnd
            onClipped={setEndClipped}
          />
          {clipped || endClipped ? (
            <span className="block font-sans text-xs text-warning-foreground">
              <T>Scroll each part to read all of it.</T>
            </span>
          ) : null}
        </>
      ) : clipped ? (
        <span className="block font-sans text-xs text-warning-foreground">
          <T>Scroll to read all of it.</T>
        </span>
      ) : null}
    </>
  );
}

function ApprovalTextBox({
  parts,
  label,
  className,
  detail,
  isDiff = false,
  fromEnd = false,
  onClipped,
}: {
  parts: ReadonlyArray<ApprovalTextPart>;
  label?: string | undefined;
  className?: string | undefined;
  detail: "complete" | "cut" | "end";
  isDiff?: boolean;
  /** Opens scrolled to its last line: the end of the text is what this box is for. */
  fromEnd?: boolean;
  onClipped: (clipped: boolean) => void;
}) {
  const watch = (box: HTMLElement | null) => {
    if (!box) return;
    if (fromEnd) box.scrollTop = box.scrollHeight;
    const measure = () => onClipped(box.scrollHeight > box.clientHeight + 1);
    measure();
    return observeResize(box, measure);
  };
  return (
    <code
      ref={watch}
      aria-label={label}
      className={cn(
        "block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        className,
      )}
      data-approval-detail={detail}
      tabIndex={0}
    >
      {isDiff
        ? splitApprovalPartsByLine(parts).map((line, index) => {
            const lineClass = diffLineClassName(line);
            return lineClass ? (
              // oxlint-disable-next-line react/no-array-index-key -- lines never reorder
              <span key={index} className={lineClass}>
                {renderApprovalParts(line.parts)}
              </span>
            ) : (
              // oxlint-disable-next-line react/no-array-index-key -- lines never reorder
              <Fragment key={index}>{renderApprovalParts(line.parts)}</Fragment>
            );
          })
        : renderApprovalParts(parts)}
    </code>
  );
}
