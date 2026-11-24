import type { InferenceMode } from "firebase/ai";

export type InferenceRoute = "ON_DEVICE" | "IN_CLOUD" | "SIMULATED_OFFLINE";

export interface TelemetryEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly stage: "local-entity-scan" | "local-triage" | "cloud-deep-analysis" | "local-qa";
  readonly requestedMode: InferenceMode;
  readonly actualSource: InferenceRoute;
  readonly latencyMs: number;
  readonly bytesSentToCloud: number;
  readonly redactedEntitiesCount: number;
  readonly estimatedCostUsd: number;
  readonly zeroLeakVerified: boolean;
  readonly outboundPreview: string;
  readonly note: string;
}

export interface QueuedCloudJob {
  readonly id: string;
  readonly createdAt: string;
  readonly docTitle: string;
  readonly sanitizedText: string;
  readonly taskPrompt: string;
  readonly tokenToOriginal: Readonly<Record<string, string>>;
  readonly status: "queued" | "completed" | "failed";
  readonly resultMarkdown?: string;
  readonly error?: string;
}

export interface FirebaseWebConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly storageBucket?: string;
  readonly messagingSenderId?: string;
  readonly appId: string;
  readonly cloudModel: string;
  readonly appCheckSiteKey?: string;
  readonly appCheckDebugToken?: string;
}

const TELEMETRY_KEY = "veildocs:telemetry:v1";
const QUEUE_KEY = "veildocs:cloud-queue:v1";
const CONFIG_KEY = "veildocs:firebase-config:v1";
const THEME_KEY = "color-scheme";

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadTelemetry(): TelemetryEntry[] {
  if (typeof localStorage === "undefined") return [];
  return safeParse<TelemetryEntry[]>(localStorage.getItem(TELEMETRY_KEY), []);
}

export function saveTelemetry(entries: readonly TelemetryEntry[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(TELEMETRY_KEY, JSON.stringify(entries.slice(0, 40)));
}

export function loadCloudQueue(): QueuedCloudJob[] {
  if (typeof localStorage === "undefined") return [];
  return safeParse<QueuedCloudJob[]>(localStorage.getItem(QUEUE_KEY), []);
}

export function saveCloudQueue(jobs: readonly QueuedCloudJob[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(QUEUE_KEY, JSON.stringify(jobs.slice(0, 25)));
}

export function loadFirebaseConfig(): FirebaseWebConfig | null {
  const envApiKey = import.meta.env?.VITE_FIREBASE_API_KEY?.trim() ?? "";
  const envProjectId = import.meta.env?.VITE_FIREBASE_PROJECT_ID?.trim() ?? "";
  const envAppId = import.meta.env?.VITE_FIREBASE_APP_ID?.trim() ?? "";

  if (envApiKey && envProjectId && envAppId) {
    return {
      apiKey: envApiKey,
      authDomain: import.meta.env?.VITE_FIREBASE_AUTH_DOMAIN?.trim() || `${envProjectId}.firebaseapp.com`,
      projectId: envProjectId,
      storageBucket: import.meta.env?.VITE_FIREBASE_STORAGE_BUCKET?.trim() || undefined,
      messagingSenderId: import.meta.env?.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || undefined,
      appId: envAppId,
      cloudModel: import.meta.env?.VITE_FIREBASE_CLOUD_MODEL?.trim() || "gemini-3.5-flash-lite",
      appCheckSiteKey: import.meta.env?.VITE_FIREBASE_APP_CHECK_SITE_KEY?.trim() || undefined,
      appCheckDebugToken: import.meta.env?.VITE_FIREBASE_APP_CHECK_DEBUG_TOKEN?.trim() || undefined,
    };
  }

  if (typeof localStorage === "undefined") return null;
  const saved = safeParse<Partial<FirebaseWebConfig> | null>(
    localStorage.getItem(CONFIG_KEY),
    null
  );
  if (!saved?.apiKey || !saved?.projectId || !saved?.appId) return null;
  return {
    apiKey: saved.apiKey,
    authDomain: saved.authDomain || `${saved.projectId}.firebaseapp.com`,
    projectId: saved.projectId,
    storageBucket: saved.storageBucket,
    messagingSenderId: saved.messagingSenderId,
    appId: saved.appId,
    cloudModel: saved.cloudModel || "gemini-3.5-flash-lite",
    appCheckSiteKey: saved.appCheckSiteKey,
    appCheckDebugToken: saved.appCheckDebugToken,
  };
}

export function saveFirebaseConfig(config: FirebaseWebConfig | null): void {
  if (typeof localStorage === "undefined") return;
  if (!config) {
    localStorage.removeItem(CONFIG_KEY);
    return;
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export type ThemePreference = "system" | "light" | "dark";

export function loadThemePreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const value = localStorage.getItem(THEME_KEY);
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

export function saveThemePreference(theme: ThemePreference): void {
  if (typeof localStorage === "undefined") return;
  if (theme === "system") {
    localStorage.removeItem(THEME_KEY);
    return;
  }
  localStorage.setItem(THEME_KEY, theme);
}
