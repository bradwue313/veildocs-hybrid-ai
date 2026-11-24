export type SensitivityCategory =
  | "SECRET"
  | "SSN_OR_TAX_ID"
  | "PAYMENT_CARD"
  | "EMAIL"
  | "PHONE"
  | "IP_ADDRESS"
  | "PERSON"
  | "ORG"
  | "CUSTOM";

export interface RedactionSpan {
  readonly id: string;
  readonly category: SensitivityCategory;
  readonly placeholder: string;
  readonly original: string;
  readonly start: number;
  readonly end: number;
  readonly source: "pattern" | "on-device-ai" | "user-rule";
}

export interface RedactionResult {
  readonly originalText: string;
  readonly sanitizedText: string;
  readonly spans: readonly RedactionSpan[];
  readonly tokenToOriginal: Readonly<Record<string, string>>;
  readonly categoryCounts: Readonly<Record<SensitivityCategory, number>>;
}

export interface ExtraSensitiveEntity {
  readonly text: string;
  readonly category: SensitivityCategory;
  readonly source: "on-device-ai" | "user-rule";
}

const REGEX_DETECTORS: ReadonlyArray<{
  readonly category: SensitivityCategory;
  readonly pattern: RegExp;
  readonly validate?: (value: string) => boolean;
}> = [
  {
    category: "SECRET",
    pattern:
      /\b(?:AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g,
  },
  {
    category: "SSN_OR_TAX_ID",
    pattern: /\b(?:\d{3}-\d{2}-\d{4}|NHI-[A-Z]{3}\d{4}|IRD\s?#?\s?\d{2,3}-\d{3}-\d{3})\b/g,
  },
  {
    category: "PAYMENT_CARD",
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: isValidLuhnCard,
  },
  {
    category: "EMAIL",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    category: "PHONE",
    pattern: /(?<![\d.-])(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}(?![\d.-])/g,
  },
  {
    category: "IP_ADDRESS",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
];

const EMPTY_COUNTS: Record<SensitivityCategory, number> = {
  SECRET: 0,
  SSN_OR_TAX_ID: 0,
  PAYMENT_CARD: 0,
  EMAIL: 0,
  PHONE: 0,
  IP_ADDRESS: 0,
  PERSON: 0,
  ORG: 0,
  CUSTOM: 0,
};

function isValidLuhnCard(raw: string): boolean {
  const digits = raw.replace(/[\s-]/g, "");
  if (digits.length < 13 || digits.length > 19 || !/^\d+$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

interface CandidateMatch {
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly category: SensitivityCategory;
  readonly source: "pattern" | "on-device-ai" | "user-rule";
  readonly priority: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministically redacts sensitive spans into typed reversible placeholders
 * (`[CATEGORY_N]`), preferring longer/higher-confidence non-overlapping matches.
 */
export function redactDocument(
  text: string,
  extraEntities: readonly ExtraSensitiveEntity[] = []
): RedactionResult {
  const candidates: CandidateMatch[] = [];

  for (const detector of REGEX_DETECTORS) {
    detector.pattern.lastIndex = 0;
    for (const match of text.matchAll(detector.pattern)) {
      const matched = match[0];
      const start = match.index;
      if (start === undefined || matched.length === 0) continue;
      if (detector.validate && !detector.validate(matched)) continue;
      candidates.push({
        start,
        end: start + matched.length,
        original: matched,
        category: detector.category,
        source: "pattern",
        priority: 3,
      });
    }
  }

  for (const entity of extraEntities) {
    const trimmed = entity.text.trim();
    if (trimmed.length < 2) continue;
    const escaped = escapeRegExp(trimmed);
    const matcher = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "g");
    for (const match of text.matchAll(matcher)) {
      const start = match.index;
      if (start === undefined) continue;
      candidates.push({
        start,
        end: start + match[0].length,
        original: match[0],
        category: entity.category,
        source: entity.source,
        priority: entity.source === "user-rule" ? 4 : 2,
      });
    }
  }

  // Sort by earlier start, then longer match, then higher priority.
  candidates.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return b.priority - a.priority;
  });

  const accepted: CandidateMatch[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    accepted.push(candidate);
    cursor = candidate.end;
  }

  const valueToPlaceholder = new Map<string, string>();
  const tokenToOriginal: Record<string, string> = {};
  const categoryCounts: Record<SensitivityCategory, number> = { ...EMPTY_COUNTS };
  const spans: RedactionSpan[] = [];
  const chunks: string[] = [];
  let textPos = 0;

  for (let idx = 0; idx < accepted.length; idx += 1) {
    const match = accepted[idx]!;
    const cacheKey = `${match.category}:${match.original}`;
    let placeholder = valueToPlaceholder.get(cacheKey);
    if (!placeholder) {
      categoryCounts[match.category] += 1;
      placeholder = `[${match.category}_${categoryCounts[match.category]}]`;
      valueToPlaceholder.set(cacheKey, placeholder);
      tokenToOriginal[placeholder] = match.original;
    }

    chunks.push(text.slice(textPos, match.start), placeholder);
    textPos = match.end;
    spans.push({
      id: `span-${idx + 1}`,
      category: match.category,
      placeholder,
      original: match.original,
      start: match.start,
      end: match.end,
      source: match.source,
    });
  }

  chunks.push(text.slice(textPos));

  return {
    originalText: text,
    sanitizedText: chunks.join(""),
    spans,
    tokenToOriginal,
    categoryCounts,
  };
}

/**
 * Rehydrates redacted placeholders in a model response using the local-only
 * token map so sensitive values stay client-side end-to-end.
 */
export function rehydrateText(
  text: string,
  tokenToOriginal: Readonly<Record<string, string>>
): string {
  const tokens = Object.keys(tokenToOriginal);
  if (tokens.length === 0) return text;
  const pattern = new RegExp(tokens.map(escapeRegExp).join("|"), "g");
  return text.replace(pattern, (matched) => tokenToOriginal[matched] ?? matched);
}

/**
 * Verifies that none of the protected original values remain inside an
 * outbound cloud payload prior to invoking a remote model.
 */
export function verifyZeroPiiLeak(
  outboundPayload: string,
  spans: readonly RedactionSpan[]
): { readonly safe: boolean; readonly leakedValues: readonly string[] } {
  const leaked = new Set<string>();
  const lowerPayload = outboundPayload.toLowerCase();
  for (const span of spans) {
    if (span.original.length >= 3 && lowerPayload.includes(span.original.toLowerCase())) {
      leaked.add(span.original);
    }
  }
  return {
    safe: leaked.size === 0,
    leakedValues: [...leaked],
  };
}
