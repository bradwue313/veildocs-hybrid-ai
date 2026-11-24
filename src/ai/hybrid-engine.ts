import { deleteApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
} from "firebase/ai";
import {
  rehydrateText,
  verifyZeroPiiLeak,
  type ExtraSensitiveEntity,
  type RedactionResult,
} from "../privacy/redactor";
import type {
  FirebaseWebConfig,
  InferenceRoute,
  QueuedCloudJob,
  TelemetryEntry,
} from "../storage/vault-db";

const APP_NAME = "veildocs-hybrid";

export class PrivacyLeakBlockedError extends Error {
  readonly leakedValues: readonly string[];

  constructor(leakedValues: readonly string[]) {
    super(
      `Outbound cloud payload blocked: detected ${leakedValues.length} unredacted sensitive value(s).`
    );
    this.name = "PrivacyLeakBlockedError";
    this.leakedValues = leakedValues;
  }
}

export interface HybridRuntimeDeps {
  readonly initializeApp: typeof initializeApp;
  readonly getApps: typeof getApps;
  readonly deleteApp: typeof deleteApp;
  readonly initializeAppCheck: typeof initializeAppCheck;
  readonly getAI: typeof getAI;
  readonly getGenerativeModel: typeof getGenerativeModel;
  readonly createBackend: () => GoogleAIBackend;
  readonly isOnline: () => boolean;
  readonly now: () => number;
}

const DEFAULT_DEPS: HybridRuntimeDeps = {
  initializeApp,
  getApps,
  deleteApp,
  initializeAppCheck,
  getAI,
  getGenerativeModel,
  createBackend: () => new GoogleAIBackend(),
  isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine),
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

export interface HybridRunOutput {
  readonly status: "completed" | "queued" | "unconfigured";
  readonly sanitizedMarkdown: string;
  readonly rehydratedMarkdown: string;
  readonly telemetry: TelemetryEntry;
  readonly queuedJob?: QueuedCloudJob;
}

export type StreamChunkCallback = (partial: {
  readonly sanitizedMarkdown: string;
  readonly rehydratedMarkdown: string;
  readonly sourceHint: InferenceRoute;
}) => void;

type StreamCapableModel = ReturnType<typeof getGenerativeModel>;

async function runPromptWithOptionalStream(
  model: StreamCapableModel,
  prompt: string,
  requestedMode: InferenceMode,
  tokenToOriginal: Readonly<Record<string, string>>,
  onChunk?: StreamChunkCallback
): Promise<{ readonly text: string; readonly inferenceSource: InferenceSource | undefined }> {
  const maybeStream = (model as Partial<StreamCapableModel>).generateContentStream;
  if (onChunk && typeof maybeStream === "function") {
    const streamResult = await maybeStream.call(model, prompt);
    let accumulated = "";
    const fallbackHint =
      requestedMode === InferenceMode.ONLY_ON_DEVICE || requestedMode === InferenceMode.PREFER_ON_DEVICE
        ? "ON_DEVICE"
        : "IN_CLOUD";

    for await (const chunk of streamResult.stream) {
      const piece = chunk.text();
      if (!piece) continue;
      accumulated += piece;
      const chunkSource =
        chunk.inferenceSource === InferenceSource.IN_CLOUD
          ? "IN_CLOUD"
          : chunk.inferenceSource === InferenceSource.ON_DEVICE
            ? "ON_DEVICE"
            : fallbackHint;
      onChunk({
        sanitizedMarkdown: accumulated,
        rehydratedMarkdown: rehydrateText(accumulated, tokenToOriginal),
        sourceHint: chunkSource,
      });
    }

    const finalResponse = await streamResult.response;
    const finalText = finalResponse.text() || accumulated;
    return {
      text: finalText,
      inferenceSource: finalResponse.inferenceSource,
    };
  }

  const result = await model.generateContent(prompt);
  return {
    text: result.response.text(),
    inferenceSource: result.response.inferenceSource,
  };
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function mapInferenceSource(source: InferenceSource | undefined, requestedMode: InferenceMode): InferenceRoute {
  if (source === InferenceSource.ON_DEVICE) return "ON_DEVICE";
  if (source === InferenceSource.IN_CLOUD) return "IN_CLOUD";
  return requestedMode === InferenceMode.ONLY_ON_DEVICE || requestedMode === InferenceMode.PREFER_ON_DEVICE
    ? "ON_DEVICE"
    : "IN_CLOUD";
}

function estimateCloudCostUsd(promptText: string, outputText: string, route: InferenceRoute): number {
  if (route !== "IN_CLOUD") return 0;
  // Approximate blended rate for lightweight Gemini Flash-Lite cloud inference ($0.10 / 1M input, $0.40 / 1M output)
  const estInputTokens = Math.ceil(promptText.length / 4);
  const estOutputTokens = Math.ceil(outputText.length / 4);
  return Number(((estInputTokens * 0.0000001) + (estOutputTokens * 0.0000004)).toFixed(6));
}

function buildSimulatedLocalPreview(stage: "local-triage" | "local-qa", sanitizedText: string, question?: string): string {
  const lines = sanitizedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tokenMatches = sanitizedText.match(/\[[A-Z_]+_\d+\]/g) ?? [];
  const uniqueTokens = [...new Set(tokenMatches)];

  if (stage === "local-qa") {
    return [
      "### Offline Local Q&A Preview (Zero Cloud Bytes Sent)",
      "",
      `- **Question:** ${question || "Summarize key risk items locally."}`,
      `- **Protected Tokens in Context:** ${uniqueTokens.length} redacted placeholders (\`${uniqueTokens.slice(0, 6).join("`, `") || "none"}\`)`,
      `- **Observed Highlights:** ${lines.slice(0, 3).join(" | ") || "No document lines provided."}`,
      "",
      "> _Configure a Firebase Web App (Settings -> Firebase Config) in Chrome with Gemini Nano / Built-in AI enabled to execute live on-device `InferenceMode.ONLY_ON_DEVICE` inference._",
    ].join("\n");
  }

  return [
    "### Local Hybrid Triage Summary (Privacy-Preserved Preview)",
    "",
    `- **Document Lines Analyzed:** ${lines.length}`,
    `- **PII/Secrets Masked Before Leaving Boundary:** ${tokenMatches.length} occurrences (${uniqueTokens.length} unique tokens)`,
    `- **Opening Context:** ${lines[0] ?? "Empty document"}`,
    `- **Key Signals:** ${lines.slice(1, 4).join(" / ") || "Review full payload for details."}`,
    "",
    "> _Connect Firebase AI Logic in Settings to run live `InferenceMode.PREFER_ON_DEVICE` (Chrome Gemini Nano -> Gemini Cloud fallback) inference._",
  ].join("\n");
}

function buildSimulatedCloudPreview(sanitizedText: string, taskPrompt: string): string {
  const sections = sanitizedText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const placeholderCount = (sanitizedText.match(/\[[A-Z_]+_\d+\]/g) ?? []).length;

  return [
    "### Sanitized Deep Audit (Unconfigured Local Simulation)",
    "",
    `**Audit Directive:** ${taskPrompt}`,
    "",
    "1. **Zero-Leak Outbound Verification:** Passed — all " +
      `${placeholderCount} sensitive entities remained tokenized (\`[PERSON_*]\`, \`[SECRET_*]\`, etc.) in the outbound payload.`,
    `2. **Primary Structural Review (${sections.length} lines):**`,
    `   - High-priority item observed around \`${sections[0]?.slice(0, 96) ?? "document header"}\`.`,
    `   - Recommend confirming ownership, SLA deadlines, and credential rotation referenced near placeholders.`,
    "3. **Local Re-Hydration Ready:** Any placeholder references returned from Gemini Cloud (e.g. " +
      `${(sanitizedText.match(/\[[A-Z_]+_\d+\]/) ?? ["[NONE]"])[0]}) are restored strictly in your browser memory.`,
    "",
    "> _Simulated preview shown because Firebase credentials are not configured yet. Add your Firebase Web config in Settings to execute real `InferenceMode.ONLY_IN_CLOUD` Gemini inference._",
  ].join("\n");
}

export function extractJsonEntityArray(rawText: string): ExtraSensitiveEntity[] {
  const match = rawText.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    const results: ExtraSensitiveEntity[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const text = "text" in item && typeof item.text === "string" ? item.text.trim() : "";
      const rawCat = "category" in item && typeof item.category === "string" ? item.category.toUpperCase() : "";
      if (text.length < 3) continue;
      const category = rawCat === "ORG" ? "ORG" : rawCat === "PERSON" ? "PERSON" : null;
      if (!category) continue;
      results.push({ text, category, source: "on-device-ai" });
    }
    return results;
  } catch {
    return [];
  }
}

export class HybridInferenceEngine {
  private readonly deps: HybridRuntimeDeps;
  private cachedSignature = "";
  private cachedApp: FirebaseApp | null = null;

  constructor(deps: Partial<HybridRuntimeDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  private async ensureApp(config: FirebaseWebConfig): Promise<FirebaseApp> {
    const signature = [
      config.apiKey,
      config.projectId,
      config.appId,
      config.appCheckSiteKey ?? "",
      config.appCheckDebugToken ?? "",
    ].join("|");
    if (this.cachedApp && this.cachedSignature === signature) {
      return this.cachedApp;
    }

    const existing = this.deps.getApps().find((app) => app.name === APP_NAME);
    if (existing) {
      await this.deps.deleteApp(existing);
    }

    if (config.appCheckDebugToken?.trim()) {
      const token = config.appCheckDebugToken.trim();
      (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
        token.toLowerCase() === "true" ? true : token;
    }

    const app = this.deps.initializeApp(
      {
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        storageBucket: config.storageBucket,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId,
      },
      APP_NAME
    );

    if (config.appCheckSiteKey?.trim()) {
      this.deps.initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(config.appCheckSiteKey.trim()),
        isTokenAutoRefreshEnabled: true,
      });
    }

    this.cachedApp = app;
    this.cachedSignature = signature;
    return app;
  }

  async warmUpOnDeviceModel(
    config: FirebaseWebConfig,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    const app = await this.ensureApp(config);
    const ai = this.deps.getAI(app, { backend: this.deps.createBackend() });
    const model = this.deps.getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      inCloudParams: { model: config.cloudModel },
    });
    await model.initializeDeviceModel(onProgress);
  }

  async discoverExtraEntitiesOnDevice(
    rawText: string,
    config: FirebaseWebConfig | null,
    simulatedOffline: boolean
  ): Promise<{ readonly entities: ExtraSensitiveEntity[]; readonly telemetry: TelemetryEntry }> {
    const start = this.deps.now();
    const requestedMode = InferenceMode.ONLY_ON_DEVICE;

    if (!config || simulatedOffline) {
      return {
        entities: [],
        telemetry: {
          id: makeId("tel"),
          timestamp: new Date().toISOString(),
          stage: "local-entity-scan",
          requestedMode,
          actualSource: "SIMULATED_OFFLINE",
          latencyMs: Math.round(this.deps.now() - start),
          bytesSentToCloud: 0,
          redactedEntitiesCount: 0,
          estimatedCostUsd: 0,
          zeroLeakVerified: true,
          outboundPreview: "(Local-only step: 0 bytes left the browser)",
          note: config
            ? "Simulated offline mode active: deterministic regex + custom rules applied locally."
            : "Firebase unconfigured: deterministic regex + custom rules applied locally.",
        },
      };
    }

    try {
      const app = await this.ensureApp(config);
      const ai = this.deps.getAI(app, { backend: this.deps.createBackend() });
      const model = this.deps.getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
      });

      const prompt = [
        "Extract personal full names (PERSON) and private company/vendor names (ORG) from the text below.",
        "Return ONLY a JSON array of objects like [{\"text\":\"...\",\"category\":\"PERSON\"|\"ORG\"}]. No markdown.",
        "",
        rawText.slice(0, 4000),
      ].join("\n");

      const result = await model.generateContent(prompt);
      const entities = extractJsonEntityArray(result.response.text());

      return {
        entities,
        telemetry: {
          id: makeId("tel"),
          timestamp: new Date().toISOString(),
          stage: "local-entity-scan",
          requestedMode,
          actualSource: mapInferenceSource(result.response.inferenceSource, requestedMode),
          latencyMs: Math.round(this.deps.now() - start),
          bytesSentToCloud: 0,
          redactedEntitiesCount: entities.length,
          estimatedCostUsd: 0,
          zeroLeakVerified: true,
          outboundPreview: "(Local-only ONLY_ON_DEVICE NER scan: 0 bytes sent to cloud)",
          note: `On-device AI identified ${entities.length} contextual PERSON/ORG span(s).`,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        entities: [],
        telemetry: {
          id: makeId("tel"),
          timestamp: new Date().toISOString(),
          stage: "local-entity-scan",
          requestedMode,
          actualSource: "ON_DEVICE",
          latencyMs: Math.round(this.deps.now() - start),
          bytesSentToCloud: 0,
          redactedEntitiesCount: 0,
          estimatedCostUsd: 0,
          zeroLeakVerified: true,
          outboundPreview: "(Local-only scan: regex/rules still active)",
          note: `On-device entity model unavailable (${msg}); deterministic redactor guarantees zero PII leaks.`,
        },
      };
    }
  }

  async runLocalTriageOrQa(params: {
    readonly redaction: RedactionResult;
    readonly stage: "local-triage" | "local-qa";
    readonly question?: string;
    readonly strictLocalOnly: boolean;
    readonly config: FirebaseWebConfig | null;
    readonly simulatedOffline: boolean;
    readonly onChunk?: StreamChunkCallback;
  }): Promise<HybridRunOutput> {
    const start = this.deps.now();
    const { redaction, stage, question, strictLocalOnly, config, simulatedOffline, onChunk } = params;
    const requestedMode = strictLocalOnly ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.PREFER_ON_DEVICE;

    // Even for PREFER_ON_DEVICE, pass sanitizedText so if Firebase falls back to IN_CLOUD, zero PII leaks.
    const check = verifyZeroPiiLeak(redaction.sanitizedText, redaction.spans);
    if (!check.safe) {
      throw new PrivacyLeakBlockedError(check.leakedValues);
    }

    if (!config || simulatedOffline) {
      const sanitizedMarkdown = buildSimulatedLocalPreview(stage, redaction.sanitizedText, question);
      return {
        status: config ? "completed" : "unconfigured",
        sanitizedMarkdown,
        rehydratedMarkdown: rehydrateText(sanitizedMarkdown, redaction.tokenToOriginal),
        telemetry: {
          id: makeId("tel"),
          timestamp: new Date().toISOString(),
          stage,
          requestedMode,
          actualSource: "SIMULATED_OFFLINE",
          latencyMs: Math.round(this.deps.now() - start),
          bytesSentToCloud: 0,
          redactedEntitiesCount: redaction.spans.length,
          estimatedCostUsd: 0,
          zeroLeakVerified: true,
          outboundPreview: redaction.sanitizedText.slice(0, 320),
          note: simulatedOffline
            ? "Simulated offline toggle enabled: executed zero-network local preview."
            : "Firebase Web Config missing: executed zero-network local preview.",
        },
      };
    }

    const prompt =
      stage === "local-qa"
        ? [
            "Answer the user question concisely using ONLY facts in the redacted document.",
            "Preserve any bracketed placeholders (like [PERSON_1], [SECRET_1]) verbatim in your answer.",
            `Question: ${question || "What are the highest priority actions?"}`,
            "",
            "Redacted Document:",
            redaction.sanitizedText,
          ].join("\n")
        : [
            "Produce a crisp 4-bullet markdown triage summary (Severity/Urgency, Core Actors, Immediate Risks, Recommended Next Step).",
            "Preserve any bracketed placeholders (like [PERSON_1], [ORG_1], [SECRET_1]) verbatim.",
            "",
            "Redacted Document:",
            redaction.sanitizedText,
          ].join("\n");

    const app = await this.ensureApp(config);
    const ai = this.deps.getAI(app, { backend: this.deps.createBackend() });
    const model = this.deps.getGenerativeModel(
      ai,
      strictLocalOnly
        ? { mode: InferenceMode.ONLY_ON_DEVICE }
        : {
            mode: InferenceMode.PREFER_ON_DEVICE,
            inCloudParams: { model: config.cloudModel },
          }
    );

    const generated = await runPromptWithOptionalStream(
      model,
      prompt,
      requestedMode,
      redaction.tokenToOriginal,
      onChunk
    );
    const sanitizedMarkdown = generated.text;
    const actualSource = mapInferenceSource(generated.inferenceSource, requestedMode);
    const bytesSentToCloud = actualSource === "IN_CLOUD" ? utf8ByteLength(prompt) : 0;

    return {
      status: "completed",
      sanitizedMarkdown,
      rehydratedMarkdown: rehydrateText(sanitizedMarkdown, redaction.tokenToOriginal),
      telemetry: {
        id: makeId("tel"),
        timestamp: new Date().toISOString(),
        stage,
        requestedMode,
        actualSource,
        latencyMs: Math.round(this.deps.now() - start),
        bytesSentToCloud,
        redactedEntitiesCount: redaction.spans.length,
        estimatedCostUsd: estimateCloudCostUsd(prompt, sanitizedMarkdown, actualSource),
        zeroLeakVerified: true,
        outboundPreview: prompt.slice(0, 320),
        note:
          actualSource === "ON_DEVICE"
            ? "Executed locally via Chrome built-in Gemini Nano at $0 cloud cost."
            : "On-device model unavailable; Firebase seamlessly routed sanitized payload to Gemini Cloud fallback.",
      },
    };
  }

  async runCloudDeepAnalysis(params: {
    readonly docTitle: string;
    readonly redaction: RedactionResult;
    readonly taskPrompt: string;
    readonly config: FirebaseWebConfig | null;
    readonly simulatedOffline: boolean;
    readonly onChunk?: StreamChunkCallback;
  }): Promise<HybridRunOutput> {
    const start = this.deps.now();
    const { docTitle, redaction, taskPrompt, config, simulatedOffline, onChunk } = params;
    const requestedMode = InferenceMode.ONLY_IN_CLOUD;

    const leakCheck = verifyZeroPiiLeak(redaction.sanitizedText, redaction.spans);
    if (!leakCheck.safe) {
      throw new PrivacyLeakBlockedError(leakCheck.leakedValues);
    }

    const offline = simulatedOffline || !this.deps.isOnline();
    if (offline) {
      const queuedJob: QueuedCloudJob = {
        id: makeId("job"),
        createdAt: new Date().toISOString(),
        docTitle,
        sanitizedText: redaction.sanitizedText,
        taskPrompt,
        tokenToOriginal: redaction.tokenToOriginal,
        status: "queued",
      };
      const sanitizedMarkdown = [
        "### Cloud Audit Queued Offline",
        "",
        `Stored sanitized payload (**${utf8ByteLength(redaction.sanitizedText)} bytes**, 0 PII) in local queue (\`${queuedJob.id}\`).`,
        "Reconnect or turn off **Simulate Offline**, then click **Flush Queued Cloud Jobs** to execute Gemini Cloud analysis.",
      ].join("\n");
      return {
        status: "queued",
        sanitizedMarkdown,
        rehydratedMarkdown: sanitizedMarkdown,
        queuedJob,
        telemetry: {
          id: makeId("tel"),
          timestamp: new Date().toISOString(),
          stage: "cloud-deep-analysis",
          requestedMode,
          actualSource: "SIMULATED_OFFLINE",
          latencyMs: Math.round(this.deps.now() - start),
          bytesSentToCloud: 0,
          redactedEntitiesCount: redaction.spans.length,
          estimatedCostUsd: 0,
          zeroLeakVerified: true,
          outboundPreview: redaction.sanitizedText.slice(0, 320),
          note: `Offline resilience active: queued sanitized job ${queuedJob.id} locally.`,
        },
      };
    }

    if (!config) {
      const sanitizedMarkdown = buildSimulatedCloudPreview(redaction.sanitizedText, taskPrompt);
      return {
        status: "unconfigured",
        sanitizedMarkdown,
        rehydratedMarkdown: rehydrateText(sanitizedMarkdown, redaction.tokenToOriginal),
        telemetry: {
          id: makeId("tel"),
          timestamp: new Date().toISOString(),
          stage: "cloud-deep-analysis",
          requestedMode,
          actualSource: "SIMULATED_OFFLINE",
          latencyMs: Math.round(this.deps.now() - start),
          bytesSentToCloud: 0,
          redactedEntitiesCount: redaction.spans.length,
          estimatedCostUsd: 0,
          zeroLeakVerified: true,
          outboundPreview: redaction.sanitizedText.slice(0, 320),
          note: "Firebase unconfigured: rendered local dry-run audit without calling network.",
        },
      };
    }

    const prompt = [
      "You are VeilDocs, an expert compliance, clinical, security, and contract analyst.",
      "Analyze the sanitized document below. Every bracketed token like [PERSON_1], [ORG_1], [EMAIL_1], [SECRET_1] represents a redacted entity.",
      "CRITICAL: Keep placeholders verbatim using their exact brackets (so the client browser can re-hydrate original values locally).",
      "Provide structured markdown sections: ## Executive Risk Rating, ## Detailed Findings, ## Remediation Checklist.",
      "",
      `Task Focus: ${taskPrompt}`,
      "",
      "Sanitized Document:",
      redaction.sanitizedText,
    ].join("\n");

    const app = await this.ensureApp(config);
    const ai = this.deps.getAI(app, { backend: this.deps.createBackend() });
    const model = this.deps.getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: { model: config.cloudModel },
    });

    const generated = await runPromptWithOptionalStream(
      model,
      prompt,
      requestedMode,
      redaction.tokenToOriginal,
      onChunk
    );
    const sanitizedMarkdown = generated.text;
    const actualSource = mapInferenceSource(generated.inferenceSource, requestedMode);
    const bytesSentToCloud = utf8ByteLength(prompt);

    return {
      status: "completed",
      sanitizedMarkdown,
      rehydratedMarkdown: rehydrateText(sanitizedMarkdown, redaction.tokenToOriginal),
      telemetry: {
        id: makeId("tel"),
        timestamp: new Date().toISOString(),
        stage: "cloud-deep-analysis",
        requestedMode,
        actualSource,
        latencyMs: Math.round(this.deps.now() - start),
        bytesSentToCloud,
        redactedEntitiesCount: redaction.spans.length,
        estimatedCostUsd: estimateCloudCostUsd(prompt, sanitizedMarkdown, actualSource),
        zeroLeakVerified: true,
        outboundPreview: prompt.slice(0, 320),
        note: `Sent ${bytesSentToCloud} sanitized bytes to ${config.cloudModel} (${redaction.spans.length} PII/secret spans stayed client-side) and re-hydrated locally.`,
      },
    };
  }

  async flushQueuedCloudJobs(
    jobs: readonly QueuedCloudJob[],
    config: FirebaseWebConfig | null,
    simulatedOffline: boolean
  ): Promise<{ readonly updatedJobs: QueuedCloudJob[]; readonly telemetryEntries: TelemetryEntry[] }> {
    const updatedJobs: QueuedCloudJob[] = [];
    const telemetryEntries: TelemetryEntry[] = [];

    for (const job of jobs) {
      if (job.status !== "queued") {
        updatedJobs.push(job);
        continue;
      }

      if (simulatedOffline || !this.deps.isOnline() || !config) {
        updatedJobs.push(job);
        continue;
      }

      try {
        const app = await this.ensureApp(config);
        const ai = this.deps.getAI(app, { backend: this.deps.createBackend() });
        const model = this.deps.getGenerativeModel(ai, {
          mode: InferenceMode.ONLY_IN_CLOUD,
          inCloudParams: { model: config.cloudModel },
        });
        const prompt = `Task: ${job.taskPrompt}\nPreserve bracketed tokens verbatim.\n\n${job.sanitizedText}`;
        const start = this.deps.now();
        const result = await model.generateContent(prompt);
        const raw = result.response.text();
        const rehydrated = rehydrateText(raw, job.tokenToOriginal);
        updatedJobs.push({
          ...job,
          status: "completed",
          resultMarkdown: rehydrated,
        });
        telemetryEntries.push({
          id: makeId("tel"),
          timestamp: new Date().toISOString(),
          stage: "cloud-deep-analysis",
          requestedMode: InferenceMode.ONLY_IN_CLOUD,
          actualSource: mapInferenceSource(result.response.inferenceSource, InferenceMode.ONLY_IN_CLOUD),
          latencyMs: Math.round(this.deps.now() - start),
          bytesSentToCloud: utf8ByteLength(prompt),
          redactedEntitiesCount: Object.keys(job.tokenToOriginal).length,
          estimatedCostUsd: estimateCloudCostUsd(prompt, raw, "IN_CLOUD"),
          zeroLeakVerified: true,
          outboundPreview: prompt.slice(0, 320),
          note: `Flushed queued job ${job.id} (${job.docTitle}) when connectivity resumed.`,
        });
      } catch (err) {
        updatedJobs.push({
          ...job,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { updatedJobs, telemetryEntries };
  }
}
