import { HybridInferenceEngine, PrivacyLeakBlockedError, type HybridRunOutput } from "./ai/hybrid-engine";
import { loadLocalDocumentFile } from "./files/document-loader";
import {
  redactDocument,
  verifyZeroPiiLeak,
  type ExtraSensitiveEntity,
  type RedactionResult,
  type SensitivityCategory,
} from "./privacy/redactor";
import { SAMPLE_DOCUMENTS } from "./samples/documents";
import {
  loadCloudQueue,
  loadFirebaseConfig,
  loadTelemetry,
  loadThemePreference,
  saveCloudQueue,
  saveFirebaseConfig,
  saveTelemetry,
  saveThemePreference,
  type FirebaseWebConfig,
  type QueuedCloudJob,
  type TelemetryEntry,
  type ThemePreference,
} from "./storage/vault-db";
import { renderRedactedPreview, renderStructuredReport } from "./ui/safe-dom";

type WorkspaceView = "studio" | "audit" | "queue";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing required DOM element: #${id}`);
  }
  return node as T;
}

const CATEGORY_LABELS: Record<SensitivityCategory, string> = {
  SECRET: "Secrets & Keys",
  SSN_OR_TAX_ID: "Tax / Gov IDs",
  PAYMENT_CARD: "Payment Cards",
  EMAIL: "Emails",
  PHONE: "Phones",
  IP_ADDRESS: "IPs",
  PERSON: "People",
  ORG: "Organizations",
  CUSTOM: "Custom Terms",
};

const STAGE_LABELS: Record<TelemetryEntry["stage"], string> = {
  "local-entity-scan": "Local NER Scan",
  "local-triage": "Fast Local Triage",
  "cloud-deep-analysis": "Sanitized Deep Audit",
  "local-qa": "Private Q&A",
};

const engine = new HybridInferenceEngine();

let activeScenarioId = SAMPLE_DOCUMENTS[0]?.id ?? "clinical-intake";
let activeDocTitle = SAMPLE_DOCUMENTS[0]?.title ?? "Clinical Intake & Referral Note";
let activeDomainLabel = SAMPLE_DOCUMENTS[0]?.domain ?? "Healthcare";
let activeFileLabel: string | null = null;
let activeView: WorkspaceView = "studio";

let aiExtraEntities: ExtraSensitiveEntity[] = [];
let revealOriginal = false;
let simulatedOffline = false;
let isBusy = false;
let lastOutput: HybridRunOutput | null = null;
let telemetryLog: TelemetryEntry[] = loadTelemetry();
let cloudQueue: QueuedCloudJob[] = loadCloudQueue();
let firebaseConfig: FirebaseWebConfig | null = loadFirebaseConfig();
let themePreference: ThemePreference = loadThemePreference();
let currentRedaction: RedactionResult = redactDocument("");
let lastDialogTrigger: HTMLElement | null = null;

// DOM references
const livePolite = el<HTMLDivElement>("live-polite");
const liveAssertive = el<HTMLDivElement>("live-assertive");

const navStudioBtn = el<HTMLButtonElement>("nav-studio-btn");
const navAuditBtn = el<HTMLButtonElement>("nav-audit-btn");
const navQueueBtn = el<HTMLButtonElement>("nav-queue-btn");
const navAuditCount = el<HTMLSpanElement>("nav-audit-count");
const queueCountBadge = el<HTMLSpanElement>("queue-count");

const viewStudio = el<HTMLElement>("view-studio");
const viewAudit = el<HTMLElement>("view-audit");
const viewQueue = el<HTMLElement>("view-queue");

const scenarioListEl = el<HTMLDivElement>("scenario-list");
const fileUploadInput = el<HTMLInputElement>("file-upload-input");

const quickThemeLight = el<HTMLButtonElement>("quick-theme-light");
const quickThemeDark = el<HTMLButtonElement>("quick-theme-dark");
const quickThemeSystem = el<HTMLButtonElement>("quick-theme-system");

const firebaseStatusBtn = el<HTMLButtonElement>("firebase-status-btn");
const firebaseStatusText = el<HTMLSpanElement>("firebase-status-text");
const openConfigBtn = el<HTMLButtonElement>("open-config-btn");

const mainHeading = el<HTMLHeadingElement>("main-content");
const activeDomainTag = el<HTMLSpanElement>("active-domain-tag");
const zeroLeakBadge = el<HTMLSpanElement>("zero-leak-badge");
const activeFilePill = el<HTMLSpanElement>("active-file-pill");

const kpiLocalCount = el<HTMLElement>("kpi-local-count");
const kpiCloudCount = el<HTMLElement>("kpi-cloud-count");
const kpiShieldedCount = el<HTMLElement>("kpi-shielded-count");
const kpiCostUsd = el<HTMLElement>("kpi-cost-usd");

const connectivityPill = el<HTMLSpanElement>("connectivity-pill");
const connectivityText = el<HTMLSpanElement>("connectivity-text");
const simulateOfflineToggle = el<HTMLInputElement>("simulate-offline-toggle");

const stepShield = el<HTMLLIElement>("step-shield");
const stepShieldDetail = el<HTMLSpanElement>("step-shield-detail");
const stepRoute = el<HTMLLIElement>("step-route");
const stepRouteDetail = el<HTMLSpanElement>("step-route-detail");
const stepRestore = el<HTMLLIElement>("step-restore");
const stepRestoreDetail = el<HTMLSpanElement>("step-restore-detail");

const docMetrics = el<HTMLSpanElement>("doc-metrics");
const viewRedactedBtn = el<HTMLButtonElement>("view-redacted-btn");
const viewOriginalBtn = el<HTMLButtonElement>("view-original-btn");
const copyRedactedBtn = el<HTMLButtonElement>("copy-redacted-btn");
const copyRedactedLabel = el<HTMLSpanElement>("copy-redacted-label");
const redactionStatsBox = el<HTMLDivElement>("redaction-stats");
const redactedPreviewBox = el<HTMLDivElement>("redacted-preview-box");

const sourceDropzone = el<HTMLDivElement>("source-dropzone");
const aiEntityScanBtn = el<HTMLButtonElement>("ai-entity-scan-btn");
const warmupLocalBtn = el<HTMLButtonElement>("warmup-local-btn");
const rawInput = el<HTMLTextAreaElement>("raw-document-input");
const customTermsInput = el<HTMLInputElement>("custom-terms-input");
const nanoWarmupWrap = el<HTMLDivElement>("nano-warmup-wrap");
const nanoWarmupPct = el<HTMLSpanElement>("nano-warmup-pct");
const nanoWarmupProgress = el<HTMLProgressElement>("nano-warmup-progress");

const activeRouteBadge = el<HTMLSpanElement>("active-route-badge");
const showSanitizedOutputToggle = el<HTMLInputElement>("show-sanitized-output-toggle");
const copyReportBtn = el<HTMLButtonElement>("copy-report-btn");
const copyReportLabel = el<HTMLSpanElement>("copy-report-label");

const demoGuidanceBanner = el<HTMLDivElement>("demo-guidance-banner");
const bannerConnectBtn = el<HTMLButtonElement>("banner-connect-btn");
const runTriageBtn = el<HTMLButtonElement>("run-triage-btn");
const runCloudAuditBtn = el<HTMLButtonElement>("run-cloud-audit-btn");
const cloudDirectiveInput = el<HTMLInputElement>("cloud-directive-input");
const analysisOutputBox = el<HTMLElement>("analysis-output-box");

const localQaForm = el<HTMLFormElement>("local-qa-form");
const qaQuestionInput = el<HTMLInputElement>("qa-question-input");
const strictLocalCheckbox = el<HTMLInputElement>("strict-local-checkbox");
const runQaBtn = el<HTMLButtonElement>("run-qa-btn");

const clearTelemetryBtn = el<HTMLButtonElement>("clear-telemetry-btn");
const telemetryTableBody = el<HTMLTableSectionElement>("telemetry-table-body");
const flushQueueBtn = el<HTMLButtonElement>("flush-queue-btn");
const cloudQueueList = el<HTMLUListElement>("cloud-queue-list");

const configDialog = el<HTMLDialogElement>("firebase-config-dialog");
const closeConfigDialogBtn = el<HTMLButtonElement>("close-config-dialog-btn");
const firebaseConfigForm = el<HTMLFormElement>("firebase-config-form");
const themeSystemRadio = el<HTMLInputElement>("theme-system");
const themeSystemLabel = el<HTMLSpanElement>("theme-system-label");
const themeLightRadio = el<HTMLInputElement>("theme-light");
const themeDarkRadio = el<HTMLInputElement>("theme-dark");
const cfgApiKey = el<HTMLInputElement>("cfg-api-key");
const cfgProjectId = el<HTMLInputElement>("cfg-project-id");
const cfgAppId = el<HTMLInputElement>("cfg-app-id");
const cfgAuthDomain = el<HTMLInputElement>("cfg-auth-domain");
const cfgCloudModel = el<HTMLInputElement>("cfg-cloud-model");
const cfgValidationError = el<HTMLParagraphElement>("cfg-validation-error");
const clearFirebaseConfigBtn = el<HTMLButtonElement>("clear-firebase-config-btn");

const systemDarkMedia =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function announce(message: string, priority: "polite" | "assertive" = "polite"): void {
  const region = priority === "assertive" ? liveAssertive : livePolite;
  region.textContent = "";
  queueMicrotask(() => {
    region.textContent = message;
  });
}

function getEffectiveScheme(pref: ThemePreference): "light" | "dark" {
  if (pref === "light" || pref === "dark") return pref;
  return systemDarkMedia?.matches ? "dark" : "light";
}

function applyThemePreference(pref: ThemePreference, persist = true): void {
  themePreference = pref;
  if (persist) {
    saveThemePreference(pref);
  }

  const metaScheme = document.querySelector('meta[name="color-scheme"]');
  const metaValue = pref === "system" ? "light dark" : pref;
  if (metaScheme) {
    metaScheme.setAttribute("content", metaValue);
  }
  document.documentElement.style.colorScheme = metaValue;

  const effective = getEffectiveScheme(pref);
  themeSystemLabel.textContent = `Auto (System: ${effective === "dark" ? "Dark" : "Light"})`;

  themeSystemRadio.checked = pref === "system";
  themeLightRadio.checked = pref === "light";
  themeDarkRadio.checked = pref === "dark";

  const quickButtons: Array<{ btn: HTMLButtonElement; mode: ThemePreference }> = [
    { btn: quickThemeLight, mode: "light" },
    { btn: quickThemeDark, mode: "dark" },
    { btn: quickThemeSystem, mode: "system" },
  ];
  for (const { btn, mode } of quickButtons) {
    const active = pref === mode;
    btn.classList.toggle("theme-chip--active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

function switchView(nextView: WorkspaceView): void {
  activeView = nextView;

  viewStudio.hidden = nextView !== "studio";
  viewAudit.hidden = nextView !== "audit";
  viewQueue.hidden = nextView !== "queue";

  const navItems: Array<{ btn: HTMLButtonElement; view: WorkspaceView }> = [
    { btn: navStudioBtn, view: "studio" },
    { btn: navAuditBtn, view: "audit" },
    { btn: navQueueBtn, view: "queue" },
  ];

  for (const { btn, view } of navItems) {
    const isCurrent = view === nextView;
    btn.classList.toggle("nav-item--active", isCurrent);
    if (isCurrent) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  }
}

function parseCustomTerms(): ExtraSensitiveEntity[] {
  return customTermsInput.value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2)
    .map((text) => ({ text, category: "CUSTOM" as const, source: "user-rule" as const }));
}

function setStepState(
  item: HTMLLIElement,
  detailEl: HTMLSpanElement,
  state: "idle" | "active" | "done" | "warn",
  detailText: string
): void {
  item.classList.remove("pipeline-step--active", "pipeline-step--done", "pipeline-step--warn");
  if (state !== "idle") {
    item.classList.add(`pipeline-step--${state}`);
  }
  detailEl.textContent = detailText;
}

function renderDocumentHeaderMeta(): void {
  mainHeading.textContent = activeDocTitle;
  activeDomainTag.textContent = activeDomainLabel;
  if (activeFileLabel) {
    activeFilePill.textContent = activeFileLabel;
    activeFilePill.hidden = false;
  } else {
    activeFilePill.textContent = "";
    activeFilePill.hidden = true;
  }
}

function renderDocSidebarList(): void {
  const frag = document.createDocumentFragment();

  for (const doc of SAMPLE_DOCUMENTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isSelected = doc.id === activeScenarioId;
    btn.className = `doc-item${isSelected ? " doc-item--active" : ""}`;
    btn.setAttribute("aria-pressed", String(isSelected));
    btn.dataset.scenarioId = doc.id;

    const titleSpan = document.createElement("span");
    titleSpan.className = "doc-item-title";
    titleSpan.textContent = doc.title;

    const domainSpan = document.createElement("span");
    domainSpan.className = "doc-item-domain";
    domainSpan.textContent = doc.domain;

    btn.append(titleSpan, domainSpan);
    btn.addEventListener("click", () => selectScenario(doc.id));
    frag.appendChild(btn);
  }

  scenarioListEl.replaceChildren(frag);
}

function renderRedactionState(): void {
  const combinedExtra = [...parseCustomTerms(), ...aiExtraEntities];
  currentRedaction = redactDocument(rawInput.value, combinedExtra);

  const chars = rawInput.value.length;
  const spanCount = currentRedaction.spans.length;
  docMetrics.textContent = `${chars.toLocaleString()} chars \u00B7 ${spanCount} token${spanCount === 1 ? "" : "s"}`;

  renderRedactedPreview(
    redactedPreviewBox,
    rawInput.value,
    currentRedaction.spans,
    revealOriginal
  );

  const leakCheck = verifyZeroPiiLeak(currentRedaction.sanitizedText, currentRedaction.spans);
  if (leakCheck.safe) {
    zeroLeakBadge.className = "badge badge--safe";
    zeroLeakBadge.textContent = `0 PII Leaks Verified (${spanCount} shielded)`;
    setStepState(stepShield, stepShieldDetail, "done", `${spanCount} tokens shielded`);
  } else {
    zeroLeakBadge.className = "badge badge--danger";
    zeroLeakBadge.textContent = `Leak Check Alert (${leakCheck.leakedValues.length})`;
    setStepState(stepShield, stepShieldDetail, "warn", "Leak check flagged");
  }

  // Render category stat chips
  const statsFrag = document.createDocumentFragment();
  const entries = (Object.entries(currentRedaction.categoryCounts) as Array<[SensitivityCategory, number]>)
    .filter(([, count]) => count > 0);

  if (entries.length === 0) {
    const chip = document.createElement("span");
    chip.className = "stat-chip";
    chip.textContent = "No sensitive tokens detected yet";
    statsFrag.appendChild(chip);
  } else {
    for (const [category, count] of entries) {
      const chip = document.createElement("span");
      chip.className = "stat-chip";

      const label = document.createElement("span");
      label.textContent = CATEGORY_LABELS[category];

      const num = document.createElement("span");
      num.className = "stat-chip-count";
      num.textContent = String(count);

      chip.append(label, num);
      statsFrag.appendChild(chip);
    }
  }

  redactionStatsBox.replaceChildren(statsFrag);
}

function renderEmptyCopilotState(): void {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state-block";

  const title = document.createElement("p");
  title.className = "empty-title";
  title.textContent = "Ask or analyze with zero exposure";

  const copy = document.createElement("p");
  copy.className = "empty-copy";
  copy.textContent =
    "Every sensitive token shown on the left is withheld from the cloud and restored inside your browser after Gemini responds.";

  const suggestions = document.createElement("div");
  suggestions.className = "prompt-suggestions";
  suggestions.setAttribute("role", "group");
  suggestions.setAttribute("aria-label", "Suggested private questions");

  const prompts: Array<{ label: string; prompt: string }> = [
    {
      label: "Who owns the urgent action?",
      prompt: "Who owns the highest priority remediation or follow-up action?",
    },
    {
      label: "List risks & SLAs",
      prompt: "List every risk and SLA timeline referenced in this document.",
    },
    {
      label: "Privacy summary",
      prompt: "Summarize what stayed protected vs what external context is safe to share.",
    },
  ];

  for (const item of prompts) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "prompt-chip";
    chip.dataset.prompt = item.prompt;
    chip.textContent = item.label;
    suggestions.appendChild(chip);
  }

  wrapper.append(title, copy, suggestions);
  analysisOutputBox.replaceChildren(wrapper);
}

function renderLastOutput(): void {
  if (!lastOutput) {
    copyReportBtn.disabled = true;
    activeRouteBadge.className = "badge badge--neutral";
    activeRouteBadge.textContent = "Ready";
    setStepState(stepRoute, stepRouteDetail, "idle", "Ready");
    setStepState(stepRestore, stepRestoreDetail, "idle", "Vault keys held locally");
    renderEmptyCopilotState();
    return;
  }

  copyReportBtn.disabled = false;
  const textToShow = showSanitizedOutputToggle.checked
    ? lastOutput.sanitizedMarkdown
    : lastOutput.rehydratedMarkdown;

  renderStructuredReport(analysisOutputBox, textToShow);

  const src = lastOutput.telemetry.actualSource;

  if (lastOutput.status === "queued") {
    activeRouteBadge.className = "badge badge--warn";
    activeRouteBadge.textContent = "Queued Offline";
    setStepState(stepRoute, stepRouteDetail, "warn", "Saved to offline queue");
    setStepState(stepRestore, stepRestoreDetail, "idle", "Awaiting reconnect");
  } else if (src === "SIMULATED_OFFLINE") {
    activeRouteBadge.className = "badge badge--safe";
    activeRouteBadge.textContent = "Demo Preview \u00B7 Zero-Network";
    setStepState(stepRoute, stepRouteDetail, "done", "Demo preview ($0 cloud)");
    setStepState(stepRestore, stepRestoreDetail, "done", "Zero bytes left device");
  } else if (src === "ON_DEVICE") {
    activeRouteBadge.className = "badge badge--safe";
    activeRouteBadge.textContent = "On-Device Nano ($0)";
    setStepState(stepRoute, stepRouteDetail, "done", "On-device ($0 cloud)");
    setStepState(stepRestore, stepRestoreDetail, "done", "Zero bytes left device");
  } else {
    activeRouteBadge.className = "badge badge--cloud";
    activeRouteBadge.textContent = `Cloud (${lastOutput.telemetry.bytesSentToCloud} B)`;
    setStepState(
      stepRoute,
      stepRouteDetail,
      "done",
      `${lastOutput.telemetry.bytesSentToCloud} sanitized B`
    );
    setStepState(
      stepRestore,
      stepRestoreDetail,
      "done",
      showSanitizedOutputToggle.checked ? "Viewing tokenized wire view" : "PII restored locally"
    );
  }
}

function updateConnectivityUi(): void {
  const isBrowserOnline = typeof navigator === "undefined" ? true : navigator.onLine;
  if (simulatedOffline) {
    connectivityPill.className = "status-pill status-pill--offline";
    connectivityText.textContent = "Simulated Offline";
  } else if (!isBrowserOnline) {
    connectivityPill.className = "status-pill status-pill--offline";
    connectivityText.textContent = "Browser Offline";
  } else {
    connectivityPill.className = "status-pill status-pill--ok";
    connectivityText.textContent = "Online";
  }
}

function updateFirebaseStatusUi(): void {
  if (firebaseConfig) {
    firebaseStatusBtn.className = "connection-card connection-card--live";
    firebaseStatusText.textContent = `${firebaseConfig.projectId} \u00B7 ${firebaseConfig.cloudModel}`;
    demoGuidanceBanner.hidden = true;
  } else {
    firebaseStatusBtn.className = "connection-card connection-card--demo";
    firebaseStatusText.textContent = "Demo Mode \u00B7 Connect Firebase";
    demoGuidanceBanner.hidden = false;
  }
}

function renderTelemetryAndKpis(): void {
  let localCount = 0;
  let cloudCount = 0;
  let shieldedCount = 0;
  let totalCost = 0;

  for (const entry of telemetryLog) {
    if (entry.actualSource === "ON_DEVICE") localCount += 1;
    if (entry.actualSource === "IN_CLOUD") cloudCount += 1;
    shieldedCount += entry.redactedEntitiesCount;
    totalCost += entry.estimatedCostUsd;
  }

  kpiLocalCount.textContent = String(localCount);
  kpiCloudCount.textContent = String(cloudCount);
  kpiShieldedCount.textContent = String(shieldedCount);
  kpiCostUsd.textContent = `$${totalCost.toFixed(4)}`;
  navAuditCount.textContent = String(telemetryLog.length);

  if (telemetryLog.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "audit-empty-cell";
    td.textContent = "No AI runs recorded yet. Use Fast Local Triage, Deep Audit, or Ask AI in Document Studio.";
    tr.appendChild(td);
    telemetryTableBody.replaceChildren(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const entry of telemetryLog) {
    const tr = document.createElement("tr");

    const stageCell = document.createElement("td");
    const stageStrong = document.createElement("strong");
    stageStrong.textContent = STAGE_LABELS[entry.stage];
    const timeDiv = document.createElement("div");
    timeDiv.className = "queue-card-meta";
    timeDiv.textContent = new Date(entry.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    stageCell.append(stageStrong, timeDiv);

    const routeCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className =
      entry.actualSource === "ON_DEVICE"
        ? "badge badge--safe"
        : entry.actualSource === "IN_CLOUD"
          ? "badge badge--cloud"
          : "badge badge--warn";
    badge.textContent = entry.actualSource;
    routeCell.appendChild(badge);

    const latencyCell = document.createElement("td");
    latencyCell.textContent = `${entry.latencyMs} ms`;

    const bytesCell = document.createElement("td");
    bytesCell.textContent = `${entry.bytesSentToCloud} B`;

    const summaryCell = document.createElement("td");
    const noteText = document.createElement("div");
    noteText.textContent = entry.note;
    const wireCode = document.createElement("code");
    wireCode.className = "audit-wire-code";
    wireCode.textContent = entry.outboundPreview;
    summaryCell.append(noteText, wireCode);

    tr.append(stageCell, routeCell, latencyCell, bytesCell, summaryCell);
    frag.appendChild(tr);
  }

  telemetryTableBody.replaceChildren(frag);
}

function renderQueueList(): void {
  const pendingCount = cloudQueue.filter((j) => j.status === "queued").length;
  queueCountBadge.textContent = String(pendingCount);
  flushQueueBtn.disabled = pendingCount === 0 || isBusy;

  if (cloudQueue.length === 0) {
    const empty = document.createElement("li");
    empty.className = "queue-empty";
    empty.textContent =
      "No offline jobs queued. Enable Offline sim in the header and trigger Sanitized Deep Audit to test offline queueing.";
    cloudQueueList.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const job of cloudQueue) {
    const li = document.createElement("li");
    li.className = "queue-card";

    const top = document.createElement("div");
    top.className = "queue-card-top";

    const title = document.createElement("span");
    title.className = "queue-card-title";
    title.textContent = job.docTitle;

    const statusBadge = document.createElement("span");
    statusBadge.className =
      job.status === "completed"
        ? "badge badge--safe"
        : job.status === "failed"
          ? "badge badge--danger"
          : "badge badge--warn";
    statusBadge.textContent = job.status.toUpperCase();

    top.append(title, statusBadge);

    const meta = document.createElement("div");
    meta.className = "queue-card-meta";
    meta.textContent = `${job.sanitizedText.length} sanitized chars \u00B7 Prompt: "${job.taskPrompt}"`;

    li.append(top, meta);

    if (job.status === "completed" && job.resultMarkdown) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "btn btn--small btn--secondary";
      openBtn.textContent = "Open Restored Report in Studio";
      openBtn.addEventListener("click", () => {
        switchView("studio");
        renderStructuredReport(analysisOutputBox, job.resultMarkdown ?? "");
        activeRouteBadge.className = "badge badge--cloud";
        activeRouteBadge.textContent = "Restored from Offline Queue";
        copyReportBtn.disabled = false;
      });
      li.appendChild(openBtn);
    } else if (job.error) {
      const errDiv = document.createElement("div");
      errDiv.className = "field-error";
      errDiv.textContent = job.error;
      li.appendChild(errDiv);
    }

    frag.appendChild(li);
  }

  cloudQueueList.replaceChildren(frag);
}

function setBusy(busy: boolean): void {
  isBusy = busy;
  runTriageBtn.disabled = busy;
  runCloudAuditBtn.disabled = busy;
  runQaBtn.disabled = busy;
  aiEntityScanBtn.disabled = busy;
  warmupLocalBtn.disabled = busy;
  flushQueueBtn.disabled = busy || cloudQueue.filter((j) => j.status === "queued").length === 0;
}

function selectScenario(scenarioId: string): void {
  const found = SAMPLE_DOCUMENTS.find((doc) => doc.id === scenarioId);
  if (!found) return;

  activeScenarioId = found.id;
  activeDocTitle = found.title;
  activeDomainLabel = found.domain;
  activeFileLabel = null;
  aiExtraEntities = [];
  rawInput.value = found.text;
  customTermsInput.value = found.defaultCustomTerms.join(", ");
  lastOutput = null;

  renderDocSidebarList();
  renderDocumentHeaderMeta();
  renderRedactionState();
  renderLastOutput();
  switchView("studio");
  announce(`Loaded ${found.title}`);
}

async function importUploadedFile(file: File): Promise<void> {
  try {
    setBusy(true);
    const loaded = await loadLocalDocumentFile(file);
    activeScenarioId = "__custom__";
    activeDocTitle = loaded.fileName.replace(/\.[^/.]+$/, "") || loaded.fileName;
    activeDomainLabel = loaded.pageCount ? `Local PDF (${loaded.pageCount} pages)` : "Local File Upload";
    activeFileLabel = `${loaded.fileName} \u00B7 ${(loaded.byteSize / 1024).toFixed(1)} KB`;
    aiExtraEntities = [];
    rawInput.value = loaded.text;
    lastOutput = null;

    renderDocSidebarList();
    renderDocumentHeaderMeta();
    renderRedactionState();
    renderLastOutput();
    switchView("studio");
    announce(`Loaded ${loaded.fileName} strictly inside your browser.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    announce(message, "assertive");
    renderStructuredReport(
      analysisOutputBox,
      `## File Import Error\n\n${message}`
    );
  } finally {
    setBusy(false);
  }
}

function recordTelemetry(entry: TelemetryEntry): void {
  telemetryLog = [entry, ...telemetryLog].slice(0, 40);
  saveTelemetry(telemetryLog);
  renderTelemetryAndKpis();
}

async function handleLocalTriage(): Promise<void> {
  if (isBusy) return;
  setBusy(true);
  setStepState(stepRoute, stepRouteDetail, "active", "Running on-device triage...");

  try {
    const output = await engine.runLocalTriageOrQa({
      redaction: currentRedaction,
      stage: "local-triage",
      strictLocalOnly: strictLocalCheckbox.checked,
      config: firebaseConfig,
      simulatedOffline,
      onChunk: (partial) => {
        const text = showSanitizedOutputToggle.checked
          ? partial.sanitizedMarkdown
          : partial.rehydratedMarkdown;
        renderStructuredReport(analysisOutputBox, text);
      },
    });
    lastOutput = output;
    recordTelemetry(output.telemetry);
    renderLastOutput();
    announce("Fast Local Triage complete.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStepState(stepRoute, stepRouteDetail, "warn", "Failed");
    renderStructuredReport(analysisOutputBox, `## Inference Error\n\n${message}`);
    announce(message, "assertive");
  } finally {
    setBusy(false);
  }
}

async function handleCloudDeepAudit(): Promise<void> {
  if (isBusy) return;
  setBusy(true);
  setStepState(stepRoute, stepRouteDetail, "active", "Sending sanitized tokens...");

  try {
    const output = await engine.runCloudDeepAnalysis({
      docTitle: activeDocTitle,
      redaction: currentRedaction,
      taskPrompt: cloudDirectiveInput.value.trim() || "Summarize key risks and action items.",
      config: firebaseConfig,
      simulatedOffline,
      onChunk: (partial) => {
        const text = showSanitizedOutputToggle.checked
          ? partial.sanitizedMarkdown
          : partial.rehydratedMarkdown;
        renderStructuredReport(analysisOutputBox, text);
      },
    });
    lastOutput = output;
    recordTelemetry(output.telemetry);
    if (output.queuedJob) {
      cloudQueue = [output.queuedJob, ...cloudQueue].slice(0, 25);
      saveCloudQueue(cloudQueue);
      renderQueueList();
    }
    renderLastOutput();
    announce(
      output.status === "queued"
        ? "Offline simulated: sanitized cloud payload saved to Offline Queue."
        : "Sanitized Deep Audit complete and restored locally."
    );
  } catch (err) {
    const message =
      err instanceof PrivacyLeakBlockedError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    setStepState(stepRoute, stepRouteDetail, "warn", "Blocked or failed");
    renderStructuredReport(analysisOutputBox, `## Cloud Audit Blocked / Error\n\n${message}`);
    announce(message, "assertive");
  } finally {
    setBusy(false);
  }
}

async function handleQaSubmit(overrideQuestion?: string): Promise<void> {
  const question = (overrideQuestion ?? qaQuestionInput.value).trim();
  if (!question || isBusy) return;

  if (overrideQuestion) {
    qaQuestionInput.value = overrideQuestion;
  }

  setBusy(true);
  setStepState(
    stepRoute,
    stepRouteDetail,
    "active",
    strictLocalCheckbox.checked ? "Strict on-device Q&A..." : "Hybrid Q&A..."
  );

  try {
    const output = await engine.runLocalTriageOrQa({
      redaction: currentRedaction,
      stage: "local-qa",
      question,
      strictLocalOnly: strictLocalCheckbox.checked,
      config: firebaseConfig,
      simulatedOffline,
      onChunk: (partial) => {
        const text = showSanitizedOutputToggle.checked
          ? partial.sanitizedMarkdown
          : partial.rehydratedMarkdown;
        renderStructuredReport(analysisOutputBox, text);
      },
    });
    lastOutput = output;
    recordTelemetry(output.telemetry);
    renderLastOutput();
    announce("Private Q&A answered.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStepState(stepRoute, stepRouteDetail, "warn", "Q&A error");
    renderStructuredReport(analysisOutputBox, `## Q&A Error\n\n${message}`);
    announce(message, "assertive");
  } finally {
    setBusy(false);
  }
}

function openConfigDialog(trigger: HTMLElement): void {
  lastDialogTrigger = trigger;
  cfgValidationError.hidden = true;
  cfgValidationError.textContent = "";

  cfgApiKey.value = firebaseConfig?.apiKey ?? "";
  cfgProjectId.value = firebaseConfig?.projectId ?? "";
  cfgAppId.value = firebaseConfig?.appId ?? "";
  cfgAuthDomain.value = firebaseConfig?.authDomain ?? "";
  cfgCloudModel.value = firebaseConfig?.cloudModel ?? "gemini-3.5-flash-lite";
  applyThemePreference(themePreference, false);

  if (typeof configDialog.showModal === "function") {
    configDialog.showModal();
  } else {
    configDialog.setAttribute("open", "");
  }
}

function closeConfigDialog(): void {
  if (typeof configDialog.close === "function") {
    configDialog.close();
  } else {
    configDialog.removeAttribute("open");
    configDialog.dispatchEvent(new Event("close"));
  }
}

function flashCopyLabel(labelEl: HTMLSpanElement, originalText: string): void {
  labelEl.textContent = "Copied";
  setTimeout(() => {
    labelEl.textContent = originalText;
  }, 1400);
}

// Navigation listeners
navStudioBtn.addEventListener("click", () => switchView("studio"));
navAuditBtn.addEventListener("click", () => switchView("audit"));
navQueueBtn.addEventListener("click", () => switchView("queue"));

// Quick theme listeners
quickThemeLight.addEventListener("click", () => applyThemePreference("light"));
quickThemeDark.addEventListener("click", () => applyThemePreference("dark"));
quickThemeSystem.addEventListener("click", () => applyThemePreference("system"));

// Theme dialog radio sync
themeSystemRadio.addEventListener("change", () => {
  if (themeSystemRadio.checked) applyThemePreference("system");
});
themeLightRadio.addEventListener("change", () => {
  if (themeLightRadio.checked) applyThemePreference("light");
});
themeDarkRadio.addEventListener("change", () => {
  if (themeDarkRadio.checked) applyThemePreference("dark");
});
systemDarkMedia?.addEventListener("change", () => {
  if (themePreference === "system") {
    applyThemePreference("system", false);
  }
});

// Inspector view switch
viewRedactedBtn.addEventListener("click", () => {
  revealOriginal = false;
  viewRedactedBtn.classList.add("seg-btn--active");
  viewRedactedBtn.setAttribute("aria-pressed", "true");
  viewOriginalBtn.classList.remove("seg-btn--active");
  viewOriginalBtn.setAttribute("aria-pressed", "false");
  renderRedactionState();
});

viewOriginalBtn.addEventListener("click", () => {
  revealOriginal = true;
  viewOriginalBtn.classList.add("seg-btn--active");
  viewOriginalBtn.setAttribute("aria-pressed", "true");
  viewRedactedBtn.classList.remove("seg-btn--active");
  viewRedactedBtn.setAttribute("aria-pressed", "false");
  renderRedactionState();
});

// Copy buttons
copyRedactedBtn.addEventListener("click", async () => {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(currentRedaction.sanitizedText);
    flashCopyLabel(copyRedactedLabel, "Copy masked");
    announce("Copied masked payload to clipboard.");
  }
});

copyReportBtn.addEventListener("click", async () => {
  if (!lastOutput) return;
  const content = showSanitizedOutputToggle.checked
    ? lastOutput.sanitizedMarkdown
    : lastOutput.rehydratedMarkdown;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    flashCopyLabel(copyReportLabel, "Copy");
    announce("Copied report to clipboard.");
  }
});

// Source document edits & uploads
rawInput.addEventListener("input", () => {
  aiExtraEntities = [];
  lastOutput = null;
  renderRedactionState();
  renderLastOutput();
});

customTermsInput.addEventListener("input", () => {
  renderRedactionState();
});

fileUploadInput.addEventListener("change", async () => {
  const file = fileUploadInput.files?.[0];
  if (file) {
    await importUploadedFile(file);
    fileUploadInput.value = "";
  }
});

sourceDropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  sourceDropzone.classList.add("source-editor-section--dragover");
});

sourceDropzone.addEventListener("dragleave", () => {
  sourceDropzone.classList.remove("source-editor-section--dragover");
});

sourceDropzone.addEventListener("drop", async (event) => {
  event.preventDefault();
  sourceDropzone.classList.remove("source-editor-section--dragover");
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    await importUploadedFile(file);
  }
});

// Entity scan & Nano warmup
aiEntityScanBtn.addEventListener("click", async () => {
  if (isBusy) return;
  setBusy(true);
  try {
    const result = await engine.discoverExtraEntitiesOnDevice(
      rawInput.value,
      firebaseConfig,
      simulatedOffline
    );
    aiExtraEntities = [...result.entities];
    recordTelemetry(result.telemetry);
    renderRedactionState();
    announce(`Found ${result.entities.length} additional local entities.`);
  } finally {
    setBusy(false);
  }
});

warmupLocalBtn.addEventListener("click", async () => {
  if (isBusy) return;
  if (!firebaseConfig) {
    announce("Connect Firebase credentials in Workspace Settings to initialize Gemini Nano.");
    openConfigDialog(warmupLocalBtn);
    return;
  }
  setBusy(true);
  nanoWarmupWrap.hidden = false;
  nanoWarmupProgress.value = 0;
  nanoWarmupPct.textContent = "0%";
  try {
    await engine.warmUpOnDeviceModel(firebaseConfig, (progress) => {
      const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
      nanoWarmupProgress.value = pct;
      nanoWarmupPct.textContent = `${pct}%`;
    });
    nanoWarmupProgress.value = 100;
    nanoWarmupPct.textContent = "100%";
    announce("Chrome Gemini Nano model warm-up complete.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    announce(msg, "assertive");
  } finally {
    setBusy(false);
  }
});

// Offline & output wire toggle
simulateOfflineToggle.addEventListener("change", () => {
  simulatedOffline = simulateOfflineToggle.checked;
  updateConnectivityUi();
  announce(simulatedOffline ? "Simulated offline enabled." : "Simulated offline disabled.");
});

showSanitizedOutputToggle.addEventListener("change", () => {
  renderLastOutput();
});

// Copilot actions & prompt starter chips
runTriageBtn.addEventListener("click", () => {
  void handleLocalTriage();
});

runCloudAuditBtn.addEventListener("click", () => {
  void handleCloudDeepAudit();
});

localQaForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void handleQaSubmit();
});

analysisOutputBox.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button.prompt-chip");
  const prompt = target?.dataset.prompt;
  if (prompt) {
    void handleQaSubmit(prompt);
  }
});

// Audit & Queue view actions
clearTelemetryBtn.addEventListener("click", () => {
  telemetryLog = [];
  saveTelemetry(telemetryLog);
  renderTelemetryAndKpis();
  announce("Cleared wire and audit log.");
});

flushQueueBtn.addEventListener("click", async () => {
  if (isBusy) return;
  setBusy(true);
  try {
    const res = await engine.flushQueuedCloudJobs(cloudQueue, firebaseConfig, simulatedOffline);
    cloudQueue = res.updatedJobs;
    saveCloudQueue(cloudQueue);
    for (const entry of res.telemetryEntries) {
      recordTelemetry(entry);
    }
    renderQueueList();
    if (!firebaseConfig) {
      announce("Connect Firebase credentials in Workspace Settings to flush queued cloud jobs.");
    } else {
      announce(`Processed offline queue (${res.telemetryEntries.length} completed).`);
    }
  } finally {
    setBusy(false);
  }
});

// Config Dialog & Light Dismiss
openConfigBtn.addEventListener("click", () => openConfigDialog(openConfigBtn));
firebaseStatusBtn.addEventListener("click", () => openConfigDialog(firebaseStatusBtn));
bannerConnectBtn.addEventListener("click", () => openConfigDialog(bannerConnectBtn));
closeConfigDialogBtn.addEventListener("click", closeConfigDialog);

clearFirebaseConfigBtn.addEventListener("click", () => {
  saveFirebaseConfig(null);
  firebaseConfig = loadFirebaseConfig();
  updateFirebaseStatusUi();
  closeConfigDialog();
  announce("Cleared saved browser credentials; Preview Mode active.");
});

firebaseConfigForm.addEventListener("submit", (event) => {
  const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value === "cancel") {
    return;
  }

  const apiKey = cfgApiKey.value.trim();
  const projectId = cfgProjectId.value.trim();
  const appId = cfgAppId.value.trim();
  const authDomain = cfgAuthDomain.value.trim();
  const cloudModel = cfgCloudModel.value.trim() || "gemini-3.5-flash-lite";

  if (!apiKey && !projectId && !appId) {
    saveFirebaseConfig(null);
    firebaseConfig = loadFirebaseConfig();
    updateFirebaseStatusUi();
    return;
  }

  if (!apiKey || !projectId || !appId) {
    event.preventDefault();
    cfgValidationError.textContent = "Please provide API Key, Project ID, and App ID (or clear all fields for Preview Mode).";
    cfgValidationError.hidden = false;
    return;
  }

  const nextConfig: FirebaseWebConfig = {
    apiKey,
    projectId,
    appId,
    authDomain: authDomain || `${projectId}.firebaseapp.com`,
    cloudModel,
  };
  saveFirebaseConfig(nextConfig);
  firebaseConfig = nextConfig;
  updateFirebaseStatusUi();
  announce(`Connected Firebase project ${projectId}.`);
});

configDialog.addEventListener("click", (event) => {
  if (event.target === configDialog) {
    closeConfigDialog();
  }
});

configDialog.addEventListener("close", () => {
  lastDialogTrigger?.focus();
  lastDialogTrigger = null;
});

if (typeof window !== "undefined") {
  window.addEventListener("online", updateConnectivityUi);
  window.addEventListener("offline", updateConnectivityUi);
}

// Initial hydration
applyThemePreference(themePreference, false);
updateConnectivityUi();
updateFirebaseStatusUi();
renderTelemetryAndKpis();
renderQueueList();
selectScenario(activeScenarioId);
