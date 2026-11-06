import { getAccessToken } from "../paypal/client";

const { token, expiresAt, scope } = await getAccessToken();

console.log("✅ PayPal sandbox token OK");
console.log("   token:   ", token.slice(0, 12) + "…  (hidden)");
console.log("   expires: ", new Date(expiresAt).toLocaleString());

const scopes = scope.split(" ");
const disputeScopes = scopes.filter((s) => s.includes("disputes"));
console.log(`   scopes:   ${scopes.length} total`);
console.log(
  disputeScopes.length
    ? `   disputes: ✅ ${disputeScopes.map((s) => s.split("/services/")[1]).join(", ")}`
    : "   disputes: ⚠️  no dispute scopes on this app (we'll handle it on Day 3)",
);
