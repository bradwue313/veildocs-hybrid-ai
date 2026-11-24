import { describe, expect, it } from "vitest";
import { redactDocument, rehydrateText, verifyZeroPiiLeak } from "./redactor";

describe("redactDocument & rehydrateText", () => {
  it("redacts secrets, SSN/NHI/IRD, Luhn-validated cards, emails, and custom terms without altering non-PII text", () => {
    const sample = [
      "Engineer: alice.smith@acme-nz.example contacted +64 21 555 0199 from 10.42.8.15.",
      "Leaked token sk-proj-9876543210abcdef123456 and patient NHI-ABC1234 (IRD #123-456-789).",
      "Test Luhn card 4111 1111 1111 1111 vs invalid number 4111-1111-1111-1112.",
      "Confidential codename: Project Kauri must stay secret.",
    ].join("\n");

    const result = redactDocument(sample, [
      { text: "Project Kauri", category: "CUSTOM", source: "user-rule" },
    ]);

    expect(result.sanitizedText).not.toContain("alice.smith@acme-nz.example");
    expect(result.sanitizedText).not.toContain("sk-proj-9876543210abcdef123456");
    expect(result.sanitizedText).not.toContain("NHI-ABC1234");
    expect(result.sanitizedText).not.toContain("123-456-789");
    expect(result.sanitizedText).not.toContain("4111 1111 1111 1111");
    expect(result.sanitizedText).not.toContain("Project Kauri");
    expect(result.sanitizedText).not.toContain("10.42.8.15");
    // Non-Luhn 16-digit sequence should not be flagged as PAYMENT_CARD
    expect(result.sanitizedText).toContain("4111-1111-1111-1112");

    const leakCheck = verifyZeroPiiLeak(result.sanitizedText, result.spans);
    expect(leakCheck.safe).toBe(true);
    expect(leakCheck.leakedValues).toHaveLength(0);

    const cloudOutput = `Assign rotation of ${result.spans.find((s) => s.category === "SECRET")?.placeholder} and notify ${result.spans.find((s) => s.category === "EMAIL")?.placeholder}.`;
    const rehydrated = rehydrateText(cloudOutput, result.tokenToOriginal);
    expect(rehydrated).toContain("sk-proj-9876543210abcdef123456");
    expect(rehydrated).toContain("alice.smith@acme-nz.example");
  });

  it("reuses the same placeholder for repeated identical entities", () => {
    const text = "Email bob@example.com twice: bob@example.com.";
    const result = redactDocument(text);
    expect(result.categoryCounts.EMAIL).toBe(1);
    expect(result.spans).toHaveLength(2);
    expect(result.sanitizedText).toBe("Email [EMAIL_1] twice: [EMAIL_1].");
  });

  it("verifyZeroPiiLeak catches unmasked spans if outbound text retains raw PII", () => {
    const text = "Contact eve@example.com";
    const result = redactDocument(text);
    const badCheck = verifyZeroPiiLeak("Oops still sending eve@example.com", result.spans);
    expect(badCheck.safe).toBe(false);
    expect(badCheck.leakedValues).toContain("eve@example.com");
  });
});
