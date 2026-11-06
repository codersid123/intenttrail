import http from "node:http";
import type { Express } from "express";

const page = (ok: boolean) =>
  `<!doctype html><meta charset="utf-8"><title>IntentTrail</title>
   <body style="font-family:system-ui;padding:40px">
   <h2>${ok ? "✅ Approved." : "❌ Cancelled."} IntentTrail ${ok ? "will continue the purchase" : "will stop waiting"}.</h2>
   <p>You can close this tab.</p></body>`;

/** Where PayPal sends the buyer after approving/cancelling an order (no-vault mode). */
export function mountReturnPages(app: Express) {
  app.get("/api/paypal/return", (_req, res) => {
    res.type("html").send(page(true));
  });
  app.get("/api/paypal/cancel", (_req, res) => {
    res.type("html").send(page(false));
  });
}

/** For CLI scripts: serve the same pages on the server port if the server isn't running. */
export function startStandaloneReturnPages(port: number): () => void {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page(!req.url?.includes("/cancel")));
  });
  server.on("error", () => {}); // port busy = the real server is running and serves them
  server.listen(port);
  return () => server.close();
}
