export interface LoadedDocument {
  readonly fileName: string;
  readonly text: string;
  readonly byteSize: number;
  readonly pageCount?: number;
}

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB client-side guard

/**
 * Extracts readable text strictly inside the browser from plain-text files
 * (.txt, .md, .csv, .log, .json) or PDF documents using a locally bundled pdf.js worker.
 * Zero bytes ever leave the device during file parsing.
 */
export async function loadLocalDocumentFile(file: File): Promise<LoadedDocument> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File "${file.name}" exceeds the 15 MB in-browser limit.`);
  }

  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    const text = await file.text();
    if (!text.trim()) {
      throw new Error(`"${file.name}" appears empty or contains no readable text.`);
    }
    return {
      fileName: file.name,
      text,
      byteSize: file.size,
    };
  }

  const [{ GlobalWorkerOptions, getDocument }, workerSrcModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);

  GlobalWorkerOptions.workerSrc = workerSrcModule.default;

  const buffer = await file.arrayBuffer();
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  try {
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const strings = content.items
        .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
        .filter((segment) => segment.length > 0);
      if (strings.length > 0) {
        pageTexts.push(strings.join(" "));
      }
    }

    const extracted = pageTexts.join("\n\n").trim();
    if (!extracted) {
      throw new Error(
        `No selectable text found in "${file.name}". Scanned image-only PDFs require OCR before redaction.`
      );
    }

    return {
      fileName: file.name,
      text: extracted,
      byteSize: file.size,
      pageCount: pdf.numPages,
    };
  } finally {
    await pdf.cleanup();
    await loadingTask.destroy();
  }
}
