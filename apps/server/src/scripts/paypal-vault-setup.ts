// One-time setup: Priya (sandbox BUYER) approves saving her PayPal wallet.
// Prints PAYPAL_VAULT_ID to paste into .env. After that, agent purchases need no approval clicks.
//   npm run paypal:vault
import http from "node:http";
import { createPaymentToken, createSetupToken, getSetupToken } from "../paypal/vault";
import { PayPalApiError } from "../paypal/errors";

const PORT = 4010;
const base = `http://localhost:${PORT}`;

// Tiny local page for PayPal to redirect back to after approval
let returned: "approved" | "cancelled" | null = null;
const server = http
  .createServer((req, res) => {
    returned = req.url?.startsWith("/cancel") ? "cancelled" : "approved";
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>IntentTrail: wallet ${returned}. You can close this tab and go back to the terminal.</h2>`);
  })
  .listen(PORT);

try {
  console.log("Creating vault setup token ...");
  const st = await createSetupToken({ returnUrl: `${base}/return`, cancelUrl: `${base}/cancel` });
  if (!st.approveUrl) throw new Error(`No approve link in response (status ${st.status})`);

  console.log("\n👉 Open this link, log in as the sandbox BUYER (personal account), and approve:\n");
  console.log("   " + st.approveUrl + "\n");
  console.log("Waiting for approval (up to 10 min) ...");

  const deadline = Date.now() + 10 * 60_000;
  let status = st.status;
  let returnedAt = 0;
  while (status !== "APPROVED") {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for approval (setup token status: ${status}).`);
    await new Promise((r) => setTimeout(r, 3000));
    if (returned === "cancelled") throw new Error("Buyer cancelled the approval.");
    status = (await getSetupToken(st.setupTokenId)).status;
    // PayPal redirected back but the status hasn't flipped after ~15s: try the exchange anyway
    if (returned === "approved" && !returnedAt) returnedAt = Date.now();
    if (returnedAt && Date.now() - returnedAt > 15_000) break;
  }
  console.log(`Setup token status: ${status}. Creating payment token ...`);

  const pt = await createPaymentToken(st.setupTokenId);
  console.log("\n✅ Wallet vaulted. Add this line to your .env (repo root):\n");
  console.log(`PAYPAL_VAULT_ID=${pt.paymentTokenId}\n`);
  console.log("Then restart the server. Purchases will authorize without a browser click.");
} catch (err) {
  console.error("\n❌ Vault setup failed:", err instanceof Error ? err.message : err);
  if (err instanceof PayPalApiError) {
    console.error("   debug_id:", err.debugId);
    if (err.status === 403 || /PERMISSION|NOT_ENABLED|NOT_AUTHORIZED/i.test(err.paypalName + (err.issue ?? ""))) {
      console.error("\n→ Your sandbox app may not have vaulting turned on.");
      console.error("  developer.paypal.com → Apps & Credentials → (Sandbox) your app → Features → tick 'Save payment methods', save, retry.");
    }
  }
  console.error("\n→ Fallback (fine for the demo): leave PAYPAL_VAULT_ID empty. Each purchase will print an approve link to click.");
  process.exitCode = 1;
} finally {
  server.close();
}
