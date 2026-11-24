# VeilDocs — Local Privacy Vault & Hybrid AI Workspace

**Privacy-first local + cloud hybrid AI workspace built for Google [`#BuildHybridAI`](https://firebasehybridaihackathon.devpost.com/) (2026).**

VeilDocs lets clinicians, security engineers, legal teams, and contractors analyze sensitive PDF and text documents with cloud-scale Gemini models **without leaking raw PII, tax IDs, payment cards, or API credentials across the network**.

## Why Hybrid AI Matters Here

| Stage | `firebase/ai` Mode | Execution Location | Outbound Cloud Bytes | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **1. Boundary Redaction & PDF Parse** | Deterministic + `InferenceMode.ONLY_ON_DEVICE` | Browser / Chrome Gemini Nano + `pdfjs-dist` | **0 bytes** | Extracts text from local `.pdf`/`.txt`/`.md`/`.csv`/`.log`/`.json` files and masks secrets (`AIza...`, `sk-...`), Luhn cards, SSN/NHI/IRD IDs, emails, phones, IPs, custom terms, and contextual names into `[CATEGORY_N]` tokens |
| **2. Fast Local Triage & Private Q&A** | `InferenceMode.PREFER_ON_DEVICE` / `ONLY_ON_DEVICE` | Chrome Built-in Gemini Nano (fallback: sanitized Gemini Cloud) | **0 bytes on-device** | Streaming triage bullets and interactive Q&A directly inside the browser |
| **3. Sanitized Deep Audit** | `InferenceMode.ONLY_IN_CLOUD` | Gemini Cloud via Firebase AI Logic (`generateContentStream`) | **Verified 0-PII tokenized payload only** | Multi-clause risk synthesis that preserves `[TOKEN_N]` placeholders verbatim so your browser **re-hydrates** real names/IDs locally |
| **4. Offline Queue Resilience** | Local Job Queue (`localStorage`) | Browser | **0 bytes until online** | Queues sanitized cloud audits when offline and flushes them safely on reconnect |

## Architecture Overview

```text
+-------------------------------------------------------------------+
| Browser Privacy Boundary (Zero Raw PII Leaves This Box)           |
|                                                                   |
|  Raw Document (.pdf via pdfjs-dist / .txt/.md/.csv/.log/paste)    |
|        |                                                          |
|        v                                                          |
|  src/privacy/redactor.ts  <-- optional ONLY_ON_DEVICE NER scan    |
|        |                                                          |
|        +--> Local Token Vault Map { "[SECRET_1]": "sk-live..." }  |
|        +--> verifyZeroPiiLeak() fail-closed outbound guard        |
|        |                                                          |
|        v                                                          |
|  Sanitized Payload ---> firebase/ai (GoogleAIBackend + stream)    |
|                              |                                    |
|           +------------------+------------------+                 |
|           v                                     v                 |
|   InferenceSource.ON_DEVICE            InferenceSource.IN_CLOUD   |
|   (Chrome Gemini Nano, $0)             (Gemini Flash-Lite Cloud)  |
|           |                                     |                 |
|           +------------------+------------------+                 |
|                              v                                    |
|             rehydrateText() restores original names in UI         |
+-------------------------------------------------------------------+
```

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure Firebase AI Logic (optional for Demo Preview, required for live AI)
1. Create or open a project in the [Firebase Console](https://console.firebase.google.com/).
2. Enable **Firebase AI Logic** (Gemini Developer API backend), **Firebase App Check** (reCAPTCHA v3 site key or debug token), and register a **Web App** (`</>`).
3. Either:
   - Copy `.env.example` to `.env.local` and fill in `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_CLOUD_MODEL` (default `gemini-3.5-flash-lite`), and optional `VITE_FIREBASE_APP_CHECK_SITE_KEY` / `VITE_FIREBASE_APP_CHECK_DEBUG_TOKEN`, **OR**
   - Launch the app and enter credentials in **Workspace Settings** (stored locally in your browser's `localStorage`).

> **Note on Chrome On-Device Gemini Nano:** On desktop Chrome supporting Web Built-in AI (`chrome://flags/#prompt-api-for-gemini-nano` and `chrome://flags/#optimization-guide-on-device-model`), click **Warm up Nano** after any user interaction so `GenerativeModel.initializeDeviceModel()` prepares the local model. If unavailable, VeilDocs demonstrates `PREFER_ON_DEVICE` fallback cleanly while still keeping raw PII masked.

### 3. Run locally, typecheck, test, and build
```bash
npm run dev
npm run typecheck
npm test
npm run build
```

## 3-Minute Hackathon Demo Recording Plan (Devpost Checklist)

1. **0:00–0:35 (Problem & Privacy Boundary):** Open VeilDocs on `Clinical Intake & Referral Note` (or drag-and-drop a local `.pdf`). Toggle between **Masked Tokens** and **Source Highlights** to show `[SSN_OR_TAX_ID_1]`, `[EMAIL_1]`, `[CUSTOM_1]`, and the `0 PII Leaks Verified` badge live.
2. **0:35–1:25 (On-Device Execution):** Click **Warm up Nano** -> **Fast Local Triage** (`PREFER_ON_DEVICE`) and click a starter prompt chip / **Ask AI** (`Strict on-device only (ONLY_ON_DEVICE)`). Open **Wire & Audit Log** in the sidebar to highlight `ON_DEVICE`, latency, `0 B` outbound, and **$0.0000** cloud spend.
3. **1:25–2:20 (Sanitized Cloud + Local Re-Hydration):** Switch to `Production Incident Postmortem` (containing exposed `AIza...` / `sk-...` tokens) and click **Sanitized Deep Audit** (`ONLY_IN_CLOUD`). Toggle **Show tokenized wire view** on and off to prove Gemini Cloud only saw `[SECRET_1]` / `[EMAIL_1]`, while your browser locally restored the real entities.
4. **2:20–2:55 (Offline Queue Resilience):** Enable **Offline sim**, run **Sanitized Deep Audit** to queue it locally (`0 B` sent), disable **Offline sim**, open **Offline Queue**, and click **Flush Pending Jobs**.

## License

MIT — see [LICENSE](./LICENSE).
