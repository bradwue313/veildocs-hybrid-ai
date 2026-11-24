import { describe, expect, it } from "vitest";
import { redactDocument } from "../privacy/redactor";
import { renderRedactedPreview, renderStructuredReport } from "./safe-dom";

describe("safe-dom rendering", () => {
  it("renders redacted placeholders as <mark> elements and never executes injected HTML", () => {
    const container = document.createElement("div");
    const payload = '<script>window.__xss=1</script> Contact alice@example.com <img src=x onerror="alert(1)">';
    const redaction = redactDocument(payload);

    renderRedactedPreview(container, redaction.originalText, redaction.spans, false);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[EMAIL_1]");
    expect(container.querySelectorAll("mark.pii-chip")).toHaveLength(1);
  });

  it("renders structured markdown safely without innerHTML XSS", () => {
    const container = document.createElement("div");
    const maliciousMarkdown = [
      "## Audit Summary",
      "- **Risk:** <img src=x onerror=alert(1)> exposed `[SECRET_1]`",
      "### Next Step",
      "<script>alert(2)</script> Notify [EMAIL_1].",
    ].join("\n");

    renderStructuredReport(container, maliciousMarkdown);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("h3")?.textContent).toBe("Audit Summary");
    expect(container.querySelector("h4")?.textContent).toBe("Next Step");
    expect(container.querySelector("strong")?.textContent).toBe("Risk:");
    expect(container.querySelector("code")?.textContent).toBe("[SECRET_1]");
    expect(container.querySelector("mark.pii-inline")?.textContent).toBe("[EMAIL_1]");
  });
});
