import htmlSource from "../../index.html?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("VeilDocs App Shell UI integration, multi-view nav & accessibility", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();

    const bodyMatch = htmlSource.match(/<body>([\s\S]*)<script type="module"/);
    const headMatch = htmlSource.match(/<head>([\s\S]*)<\/head>/);
    if (!bodyMatch || !headMatch) {
      throw new Error("Could not parse index.html head/body");
    }

    document.head.innerHTML = headMatch[1] ?? "";
    document.body.innerHTML = bodyMatch[1] ?? "";

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const dialog = document.getElementById("firebase-config-dialog") as HTMLDialogElement & {
      showModal?: () => void;
      close?: (val?: string) => void;
    };
    dialog.showModal = () => {
      dialog.setAttribute("open", "");
    };
    dialog.close = (val = "") => {
      dialog.returnValue = val;
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new Event("close"));
    };
  });

  it("mounts App Shell landmarks, switches vault documents & views, and runs offline preview flows", async () => {
    await import("../main");

    // App shell semantic landmarks
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("aside#app-sidebar.sidebar")).not.toBeNull();
    expect(document.querySelector("header.app-header")).not.toBeNull();
    expect(document.querySelector("table.audit-table")).not.toBeNull();
    expect(document.querySelector('dialog[closedby="any"]')).not.toBeNull();

    // 3 vault documents rendered in sidebar
    const initialDocs = document.querySelectorAll("#scenario-list button.doc-item");
    expect(initialDocs).toHaveLength(3);
    expect(initialDocs[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("zero-leak-badge")?.textContent).toContain("0 PII Leaks");

    // Switch to 2nd document and run Fast Local Triage
    (initialDocs[1] as HTMLButtonElement).click();
    const updatedDocs = document.querySelectorAll("#scenario-list button.doc-item");
    expect(updatedDocs[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(document.getElementById("main-content")?.textContent).toBe("Production Incident Postmortem");

    (document.getElementById("run-triage-btn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 350));
    expect(document.getElementById("active-route-badge")?.textContent).toContain("Demo Preview");
    expect(document.getElementById("analysis-output-box")?.textContent).toContain("Local Hybrid Triage");
    expect((document.getElementById("copy-report-btn") as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById("nav-audit-count")?.textContent).toBe("1");

    // Switch to Audit view via sidebar nav and verify semantic table row rendered
    const navAuditBtn = document.getElementById("nav-audit-btn") as HTMLButtonElement;
    navAuditBtn.click();
    expect(navAuditBtn.getAttribute("aria-current")).toBe("page");
    expect(document.getElementById("view-studio")?.hidden).toBe(true);
    expect(document.getElementById("view-audit")?.hidden).toBe(false);
    expect(document.querySelectorAll("#telemetry-table-body tr")).toHaveLength(1);

    // Return to Studio, enable Simulate offline, queue a Sanitized Deep Audit, and inspect Queue view
    (document.getElementById("nav-studio-btn") as HTMLButtonElement).click();
    expect(document.getElementById("view-studio")?.hidden).toBe(false);

    const offlineToggle = document.getElementById("simulate-offline-toggle") as HTMLInputElement;
    offlineToggle.checked = true;
    offlineToggle.dispatchEvent(new Event("change"));
    expect(document.getElementById("connectivity-text")?.textContent).toBe("Simulated Offline");

    (document.getElementById("run-cloud-audit-btn") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.getElementById("queue-count")?.textContent).toBe("1");

    (document.getElementById("nav-queue-btn") as HTMLButtonElement).click();
    expect(document.getElementById("view-queue")?.hidden).toBe(false);
    expect(document.getElementById("cloud-queue-list")?.textContent).toContain("QUEUED");
  });

  it("syncs quick sidebar theme controls with settings dialog & executes starter prompt chips", async () => {
    await import("../main");

    // Quick theme switch in sidebar syncs color-scheme + dialog radio
    (document.getElementById("quick-theme-dark") as HTMLButtonElement).click();
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("dark");
    expect(document.getElementById("quick-theme-dark")?.getAttribute("aria-pressed")).toBe("true");
    expect((document.getElementById("theme-dark") as HTMLInputElement).checked).toBe(true);

    // Clicking starter prompt chip fills Q&A input and runs private Q&A
    const starterChip = document.querySelector("#analysis-output-box button.prompt-chip") as HTMLButtonElement;
    expect(starterChip).not.toBeNull();
    starterChip.click();
    await new Promise((r) => setTimeout(r, 350));
    expect((document.getElementById("qa-question-input") as HTMLInputElement).value.length).toBeGreaterThan(10);
    expect(document.getElementById("nav-audit-count")?.textContent).toBe("1");

    // Open settings dialog and switch to Mineral Light
    (document.getElementById("open-config-btn") as HTMLButtonElement).click();
    const dialog = document.getElementById("firebase-config-dialog") as HTMLDialogElement;
    expect(dialog.hasAttribute("open")).toBe(true);

    const lightRadio = document.getElementById("theme-light") as HTMLInputElement;
    lightRadio.checked = true;
    lightRadio.dispatchEvent(new Event("change"));
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("light");
    expect(document.getElementById("quick-theme-light")?.getAttribute("aria-pressed")).toBe("true");

    (document.getElementById("close-config-dialog-btn") as HTMLButtonElement).click();
    expect(dialog.hasAttribute("open")).toBe(false);
  });
});
