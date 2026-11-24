export interface SampleDocument {
  readonly id: string;
  readonly title: string;
  readonly domain: string;
  readonly summary: string;
  readonly text: string;
  readonly defaultCustomTerms: readonly string[];
}

export const SAMPLE_DOCUMENTS: readonly SampleDocument[] = [
  {
    id: "clinical-intake",
    title: "Clinical Intake & Referral Note",
    domain: "Healthcare / Privacy-First",
    summary: "Patient identifiers, NHI/IRD IDs, contact details, and medication escalation.",
    defaultCustomTerms: ["Aroha Patel", "Dr. Marcus Lin", "Waitemata Clinic"],
    text: [
      "CONFIDENTIAL PATIENT REFERRAL — Waitemata Clinic",
      "Patient: Aroha Patel (DOB: 1988-04-19)",
      "National Health Index: NHI-KLM4821 | Tax ID: IRD 104-882-910",
      "Contact: +64 21 555 0148 | aroha.patel.nz@example.com",
      "Attending Physician: Dr. Marcus Lin",
      "",
      "Clinical Summary:",
      "Patient presented with acute bilateral migraine aura and elevated blood pressure (158/96).",
      "Current regimen includes sumatriptan 50mg PRN and newly initiated lisinopril 10mg daily.",
      "Note mild wheezing reported after recent NSAID trial; evaluate beta-blocker contraindication",
      "and recommend neurology follow-up within 7 days. Escalation note: patient recently flew long-haul",
      "and reports transient visual scotoma lasting 25 minutes.",
    ].join("\n"),
  },
  {
    id: "incident-postmortem",
    title: "Production Incident Postmortem",
    domain: "Security & Engineering",
    summary: "Leaked credentials, internal IPs, customer email, and remediation sequencing.",
    defaultCustomTerms: ["Northstar Payments", "Elena Novak"],
    text: [
      "INCIDENT #INC-4092 — Northstar Payments Checkout Timeout",
      "Incident Commander: Elena Novak (elena.novak@northstar-internal.example)",
      "Affected Node IP: 10.42.18.94 | Public Ingress: 203.0.113.44",
      "Exposed Sandbox Key Found in Logs: sk-test-99481726354819283746",
      "Escalation Contact: +1 (415) 555-0192 | Billing Audit SSN: 123-45-6789",
      "",
      "Root Cause Draft:",
      "At 03:14 UTC, a retry storm exhausted the connection pool on 10.42.18.94 after webhook",
      "worker queues backed up for 18 minutes. Emergency log dump accidentally included",
      "authorization header Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.examplepayload.signature",
      "from canary requests. Need immediate key rotation checklist, SLA impact summary,",
      "and customer-safe disclosure wording without exposing internal hostnames or secrets.",
    ].join("\n"),
  },
  {
    id: "nda-vendor-review",
    title: "Vendor MSA & Indemnity Redline",
    domain: "Legal / Procurement",
    summary: "Counterparty names, tax identifiers, indemnity caps, and unilateral audit terms.",
    defaultCustomTerms: ["Kestrel Robotics Ltd", "Jordan Reyes"],
    text: [
      "MASTER SERVICES AGREEMENT EXCERPT — Kestrel Robotics Ltd",
      "Authorized Signatory: Jordan Reyes (jordan.reyes@kestrel-robotics.example)",
      "Phone: +64 9 555 0177 | Tax Ref: IRD 88-419-203",
      "Billing Card on File: 4532-0151-1283-0366",
      "",
      "Section 9.2 Liability & Data Processing:",
      "Vendor liability for all direct damages shall be capped at NZD $5,000 regardless of gross",
      "negligence or subcontractor breach. Customer grants Vendor a perpetual, irrevocable right",
      "to retain raw telemetry logs for model training unless Customer delivers written opt-out",
      "notice 90 days prior to renewal. Section 11.4 allows unilateral fee increases of up to 35%",
      "with 10 days electronic notice.",
    ].join("\n"),
  },
];
