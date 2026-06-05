export interface CompactDialogPanelInput {
  title: string;
  meta: string | null;
  stateLabel?: string | null;
  rows: string[];
  preview: string[];
  previewLabel?: string | null;
  footer: string;
  footerHint?: string | null;
  accentColor?: "cyan" | "green" | "yellow" | "red" | "magenta" | "blue" | null;
}

export function renderCompactDialogPanel(input: CompactDialogPanelInput): string {
  const content = [
    ...(input.stateLabel ? [`  ${input.stateLabel}`] : []),
    ...(input.meta ? [`  ${input.meta}`] : []),
    ...input.rows,
    ...(input.preview.length > 0 ? [renderCompactDialogDivider(input.previewLabel ?? null), ...input.preview] : []),
  ];

  const divider = "  ───────────────────────────────────────────────";
  const lines = [
    `${input.title}`,
    ...content,
    divider,
    ...(input.footerHint ? [`${input.footerHint}`] : []),
    `${input.footer}`,
  ];
  return lines.join("\n");
}

export function renderCompactDialogDivider(label: string | null): string {
  return label
    ? `  ${label} ────────────────────────────────`
    : "  ────────────────────────────────────────────";
}

export function padDialogText(value: string, width: number): string {
  const truncated = truncateText(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleTextLength(truncated)))}`;
}

export function truncateText(value: string, maxLength: number): string {
  if (!value) {
    return "";
  }
  if (visibleTextLength(value) <= maxLength) {
    return value;
  }
  if (maxLength <= 1) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function visibleTextLength(value: string): number {
  // Strip ANSI escape sequences to get visible length
  return `${value}`.replace(/\x1b\[[0-9;]*m/g, "").length;
}
