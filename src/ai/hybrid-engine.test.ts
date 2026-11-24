import { InferenceMode, InferenceSource } from "firebase/ai";
import { describe, expect, it, vi } from "vitest";
import { redactDocument, type RedactionResult } from "../privacy/redactor";
import type { FirebaseWebConfig } from "../storage/vault-db";
import {
  extractJsonEntityArray,
  HybridInferenceEngine,
  PrivacyLeakBlockedError,
} from "./hybrid-engine";

const TEST_CONFIG: FirebaseWebConfig = {
  apiKey: "test-api-key",
  authDomain: "test.firebaseapp.com",
  projectId: "test-project",
  appId: "1:123:web:abc",
  cloudModel: "gemini-3.5-flash-lite",
};

describe("HybridInferenceEngine", () => {
  it("executes ONLY_IN_CLOUD with sanitized text and rehydrates response locally", async () => {
    const capturedPrompts: string[] = [];
    const generateContent = vi.fn(async (prompt: string) => {
      capturedPrompts.push(prompt);
      return {
        response: {
          text: () => "## Executive Risk Rating\n\nRotate [SECRET_1] and inform [EMAIL_1].",
          inferenceSource: InferenceSource.IN_CLOUD,
        },
      };
    });

    const getGenerativeModel = vi.fn(() => ({
      generateContent,
      initializeDeviceModel: vi.fn(),
    }));

    const engine = new HybridInferenceEngine({
      initializeApp: vi.fn(() => ({ name: "veildocs-hybrid" }) as never),
      getApps: vi.fn(() => []),
      deleteApp: vi.fn(),
      getAI: vi.fn(() => ({}) as never),
      getGenerativeModel: getGenerativeModel as never,
      createBackend: vi.fn(() => ({}) as never),
      isOnline: () => true,
      now: () => 100,
    });

    const redaction = redactDocument(
      "Secret sk-live-1234567890abcdef belongs to lead@company.example."
    );

    const output = await engine.runCloudDeepAnalysis({
      docTitle: "Test Incident",
      redaction,
      taskPrompt: "Check credential exposure",
      config: TEST_CONFIG,
      simulatedOffline: false,
    });

    expect(getGenerativeModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: InferenceMode.ONLY_IN_CLOUD })
    );
    expect(capturedPrompts[0]).not.toContain("sk-live-1234567890abcdef");
    expect(capturedPrompts[0]).not.toContain("lead@company.example");
    expect(capturedPrompts[0]).toContain("[SECRET_1]");
    expect(output.sanitizedMarkdown).toContain("[SECRET_1]");
    expect(output.rehydratedMarkdown).toContain("sk-live-1234567890abcdef");
    expect(output.rehydratedMarkdown).toContain("lead@company.example");
    expect(output.telemetry.actualSource).toBe("IN_CLOUD");
    expect(output.telemetry.bytesSentToCloud).toBeGreaterThan(0);
  });

  it("queues cloud analysis cleanly offline and flushes when connectivity returns", async () => {
    let online = false;
    const generateContent = vi.fn(async () => ({
      response: {
        text: () => "Processed [EMAIL_1]",
        inferenceSource: InferenceSource.IN_CLOUD,
      },
    }));

    const engine = new HybridInferenceEngine({
      initializeApp: vi.fn(() => ({ name: "veildocs-hybrid" }) as never),
      getApps: vi.fn(() => []),
      deleteApp: vi.fn(),
      getAI: vi.fn(() => ({}) as never),
      getGenerativeModel: vi.fn(() => ({ generateContent })) as never,
      createBackend: vi.fn(() => ({}) as never),
      isOnline: () => online,
      now: () => 50,
    });

    const redaction = redactDocument("Notify ops@company.example immediately.");
    const queuedOutput = await engine.runCloudDeepAnalysis({
      docTitle: "Queued Audit",
      redaction,
      taskPrompt: "Verify SLA",
      config: TEST_CONFIG,
      simulatedOffline: false,
    });

    expect(queuedOutput.status).toBe("queued");
    expect(queuedOutput.queuedJob).toBeDefined();
    expect(queuedOutput.telemetry.bytesSentToCloud).toBe(0);
    expect(generateContent).not.toHaveBeenCalled();

    online = true;
    const flushed = await engine.flushQueuedCloudJobs(
      queuedOutput.queuedJob ? [queuedOutput.queuedJob] : [],
      TEST_CONFIG,
      false
    );
    expect(flushed.updatedJobs[0]?.status).toBe("completed");
    expect(flushed.updatedJobs[0]?.resultMarkdown).toBe("Processed ops@company.example");
    expect(flushed.telemetryEntries).toHaveLength(1);
  });

  it("blocks outbound transmission if a corrupted RedactionResult contains raw PII", async () => {
    const generateContent = vi.fn();
    const engine = new HybridInferenceEngine({
      getGenerativeModel: vi.fn(() => ({ generateContent })) as never,
      isOnline: () => true,
    });

    const valid = redactDocument("Contact security@example.com");
    const tampered: RedactionResult = {
      ...valid,
      sanitizedText: "Leaked security@example.com directly!",
    };

    await expect(
      engine.runCloudDeepAnalysis({
        docTitle: "Tampered",
        redaction: tampered,
        taskPrompt: "Audit",
        config: TEST_CONFIG,
        simulatedOffline: false,
      })
    ).rejects.toBeInstanceOf(PrivacyLeakBlockedError);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("streams incremental chunks and rehydrates placeholders mid-stream", async () => {
    async function* fakeStream() {
      yield { text: () => "## Triage\n- Token: ", inferenceSource: InferenceSource.ON_DEVICE };
      yield { text: () => "[SECRET_1] exposed", inferenceSource: InferenceSource.ON_DEVICE };
    }

    const generateContentStream = vi.fn(async () => ({
      stream: fakeStream(),
      response: Promise.resolve({
        text: () => "## Triage\n- Token: [SECRET_1] exposed",
        inferenceSource: InferenceSource.ON_DEVICE,
      }),
    }));

    const engine = new HybridInferenceEngine({
      initializeApp: vi.fn(() => ({ name: "veildocs-hybrid" }) as never),
      getApps: vi.fn(() => []),
      deleteApp: vi.fn(),
      getAI: vi.fn(() => ({}) as never),
      getGenerativeModel: vi.fn(() => ({ generateContentStream, generateContent: vi.fn() })) as never,
      createBackend: vi.fn(() => ({}) as never),
      isOnline: () => true,
      now: () => 25,
    });

    const redaction = redactDocument("Leaked sk-live-1234567890abcdef in logs.");
    const partials: string[] = [];

    const output = await engine.runLocalTriageOrQa({
      redaction,
      stage: "local-triage",
      strictLocalOnly: false,
      config: TEST_CONFIG,
      simulatedOffline: false,
      onChunk: ({ rehydratedMarkdown }) => {
        partials.push(rehydratedMarkdown);
      },
    });

    expect(partials).toHaveLength(2);
    expect(partials[1]).toContain("sk-live-1234567890abcdef");
    expect(output.rehydratedMarkdown).toContain("sk-live-1234567890abcdef");
    expect(output.telemetry.actualSource).toBe("ON_DEVICE");
    expect(output.telemetry.bytesSentToCloud).toBe(0);
  });

  it("safely parses valid PERSON/ORG entities from on-device JSON response", () => {
    const parsed = extractJsonEntityArray(
      'Here you go: [{"text":"Dr. Wiremu Patel","category":"PERSON"},{"text":"Aotearoa Health Ltd","category":"ORG"},{"text":"x","category":"PERSON"}]'
    );
    expect(parsed).toEqual([
      { text: "Dr. Wiremu Patel", category: "PERSON", source: "on-device-ai" },
      { text: "Aotearoa Health Ltd", category: "ORG", source: "on-device-ai" },
    ]);
  });
});
