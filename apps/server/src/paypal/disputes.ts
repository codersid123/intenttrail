// Disputes v1 (REST). Day 3 = de-risk only (list / get / sandbox create).
// Day 4 adds provide-evidence and the Agent Toolkit dispute agent on top of this.
import { env } from "../config";
import { money, paypalRequest } from "./client";

export type DisputeSummary = {
  dispute_id: string;
  create_time: string;
  update_time?: string;
  reason: string;
  status: string;
  dispute_amount?: { currency_code: string; value: string };
};

export async function listDisputes(): Promise<DisputeSummary[]> {
  const res = await paypalRequest<{ items?: DisputeSummary[] }>("GET", "/v1/customer/disputes?page_size=20");
  return res.items ?? [];
}

export async function getDispute(id: string): Promise<any> {
  return paypalRequest("GET", `/v1/customer/disputes/${id}`);
}

/** Unsigned JWT that tells PayPal "act as this buyer" (sandbox testing). */
function buyerAuthAssertion(buyerEmail: string): string {
  const b64u = (s: string) => Buffer.from(s).toString("base64url");
  return `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify({ iss: env.PAYPAL_CLIENT_ID, email: buyerEmail }))}.`;
}

/** SANDBOX ONLY: create a dispute as the buyer, by API. Fallback if the sandbox website flow misbehaves.
 *  buyerTransactionId = the transaction ID shown in the BUYER's sandbox account activity (not our capture id). */
export async function createSandboxDispute(args: {
  buyerTransactionId: string;
  buyerEmail: string;
  amount: number;
  reason?: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" | "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" | "UNAUTHORISED";
}) {
  const input = {
    disputed_transactions: [{ buyer_transaction_id: args.buyerTransactionId }],
    reason: args.reason ?? "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    dispute_amount: money(args.amount),
    extensions: {
      merchant_contacted: true,
      merchant_contacted_outcome: "NO_RESPONSE",
      merchandize_dispute_properties: { issue_type: "SERVICE" },
    },
  };
  const form = new FormData();
  form.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
  return paypalRequest("POST", "/v1/customer/disputes", {
    form,
    headers: { "PayPal-Auth-Assertion": buyerAuthAssertion(args.buyerEmail) },
  });
}

/** SANDBOX ONLY: move a dispute from UNDER_REVIEW to WAITING_FOR_SELLER_RESPONSE so the seller can respond. */
export async function requireSellerEvidence(id: string) {
  return paypalRequest("POST", `/v1/customer/disputes/${id}/require-evidence`, { body: { action: "SELLER_EVIDENCE" } });
}
