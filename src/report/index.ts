/**
 * HTML → PDF report harness — app-agnostic.
 *
 * The MECHANISM is webview-native printing: render a self-contained HTML document
 * in a hidden iframe and invoke the webview's own print engine (WebView2
 * "Save as PDF" on Windows desktop, the browser print dialog in a plain browser).
 * No PDF dependency, no backend. The APP supplies the report TEMPLATES (the HTML
 * builders); this module only knows how to print a finished HTML string.
 */

/** Escape a string for safe interpolation into HTML text/attribute content. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * Render `html` in a hidden iframe and invoke the webview's print dialog (where
 * the user chooses "Save as PDF"). Works in both the Tauri webview and a plain
 * browser. Fire-and-forget: the iframe is cleaned up shortly after printing.
 */
export function printHtmlAsPdf(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();

  const cleanup = () => {
    // Give the print dialog time to capture the frame before removing it.
    setTimeout(() => iframe.remove(), 1000);
  };

  const trigger = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      cleanup();
    }
  };

  // Wait for the document (incl. fonts) to settle before printing.
  if (iframe.contentWindow?.document.readyState === "complete") {
    setTimeout(trigger, 50);
  } else {
    iframe.onload = () => setTimeout(trigger, 50);
  }
}
