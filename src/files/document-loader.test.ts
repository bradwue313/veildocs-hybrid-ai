import { describe, expect, it } from "vitest";
import { loadLocalDocumentFile } from "./document-loader";

describe("loadLocalDocumentFile", () => {
  it("loads non-empty plain-text files strictly in-browser", async () => {
    const file = new File(["Patient report for test@example.com"], "note.txt", {
      type: "text/plain",
    });
    const loaded = await loadLocalDocumentFile(file);
    expect(loaded.fileName).toBe("note.txt");
    expect(loaded.text).toBe("Patient report for test@example.com");
    expect(loaded.pageCount).toBeUndefined();
  });

  it("rejects empty text files with an actionable message", async () => {
    const empty = new File(["   \n  "], "blank.md", { type: "text/markdown" });
    await expect(loadLocalDocumentFile(empty)).rejects.toThrow(/empty/i);
  });
});
