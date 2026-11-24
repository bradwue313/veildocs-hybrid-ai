import type { RedactionSpan } from "../privacy/redactor";

/**
 * Renders text safely with visual `<mark>` chips for redacted spans without
 * ever assigning untrusted strings to `innerHTML`.
 */
export function renderRedactedPreview(
  container: HTMLElement,
  originalText: string,
  spans: readonly RedactionSpan[],
  revealOriginal: boolean
): void {
  const fragment = document.createDocumentFragment();
  let cursor = 0;

  for (const span of spans) {
    if (span.start > cursor) {
      fragment.appendChild(document.createTextNode(originalText.slice(cursor, span.start)));
    }
    const mark = document.createElement("mark");
    mark.className = `pii-chip pii-${span.category.toLowerCase()}`;
    mark.dataset.category = span.category;
    mark.textContent = revealOriginal ? span.original : span.placeholder;
    mark.title = revealOriginal
      ? `${span.category} (${span.source}) → masked as ${span.placeholder}`
      : `${span.category} (${span.source}) — local-only vault entry`;
    fragment.appendChild(mark);
    cursor = span.end;
  }

  if (cursor < originalText.length) {
    fragment.appendChild(document.createTextNode(originalText.slice(cursor)));
  }

  container.replaceChildren(fragment);
}

/**
 * Safely renders structured plain-markdown output (headings, bullet lists,
 * inline code, bold) using explicit DOM nodes instead of unsafe HTML parsing.
 */
export function renderStructuredReport(container: HTMLElement, markdownText: string): void {
  const fragment = document.createDocumentFragment();
  const lines = markdownText.split(/\r?\n/);
  let currentList: HTMLUListElement | null = null;

  const flushList = () => {
    if (currentList) {
      fragment.appendChild(currentList);
      currentList = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }

    if (line.startsWith("### ")) {
      flushList();
      const h4 = document.createElement("h4");
      appendInlineSegments(h4, line.slice(4));
      fragment.appendChild(h4);
      continue;
    }

    if (line.startsWith("## ") || line.startsWith("# ")) {
      flushList();
      const h3 = document.createElement("h3");
      appendInlineSegments(h3, line.replace(/^#{1,2}\s+/, ""));
      fragment.appendChild(h3);
      continue;
    }

    if (/^[-*]\s+/.test(line.trimStart())) {
      currentList ??= document.createElement("ul");
      const li = document.createElement("li");
      appendInlineSegments(li, line.trimStart().replace(/^[-*]\s+/, ""));
      currentList.appendChild(li);
      continue;
    }

    flushList();
    const p = document.createElement("p");
    appendInlineSegments(p, line);
    fragment.appendChild(p);
  }

  flushList();
  container.replaceChildren(fragment);
}

function appendInlineSegments(parent: HTMLElement, text: string): void {
  const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[A-Z0-9_]+_\d+\])/g;
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      parent.appendChild(document.createTextNode(text.slice(cursor, start)));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else {
      const mark = document.createElement("mark");
      mark.className = "pii-chip pii-inline";
      mark.textContent = token;
      parent.appendChild(mark);
    }
    cursor = start + token.length;
  }

  if (cursor < text.length) {
    parent.appendChild(document.createTextNode(text.slice(cursor)));
  }
}
