import { createApp } from "./app.js";

function renderFatalError(message: string): void {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) {
    return;
  }

  root.innerHTML = `
    <main style="padding:24px;font-family:'Segoe UI','Malgun Gothic',sans-serif;">
      <section style="max-width:860px;margin:0 auto;background:rgba(255,251,245,0.92);border:1px solid rgba(117,89,42,0.12);border-radius:20px;padding:20px;box-shadow:0 20px 50px rgba(73,61,38,0.12);">
        <h1 style="margin-top:0;">Release Downloader</h1>
        <p style="color:#b42318;font-weight:700;">${message}</p>
      </section>
    </main>
  `;
}

try {
  const root = document.querySelector<HTMLDivElement>("#app");

  if (!root) {
    throw new Error("\uC571 \uB8E8\uD2B8 \uC694\uC18C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  }

  createApp(root);
} catch (error) {
  const message = error instanceof Error ? error.message : "\uC54C \uC218 \uC5C6\uB294 \uB80C\uB354\uB7EC \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.";
  renderFatalError(message);
}

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  renderFatalError(reason);
});