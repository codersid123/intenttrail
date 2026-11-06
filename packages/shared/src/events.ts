export const EVENT_TYPES = [
  "MANDATE_ISSUED",
  "MANDATE_REJECTED",
  "MANDATE_REVOKED",
  "AGENT_DECISION",
  "CART_SIGNED",
  "BUDGET_RESERVED",
  "BUDGET_RESERVE_DENIED",
  "PAYPAL_ORDER_CREATED",
  "PAYPAL_APPROVAL_REQUIRED",
  "PAYPAL_AUTHORIZED",
  "PAYPAL_CAPTURED",
  "PAYPAL_VOIDED",
  "PAYPAL_ERROR",
  "BUDGET_RELEASED",
  "DISPUTE_RECEIVED",
  "VERDICT_ISSUED",
  "DISPUTE_ACTION_TAKEN",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type ProvenanceEvent = {
  seq: number;
  runId: string;
  actor: string;
  type: EventType;
  data: unknown;
  ts: number;
  prevHash: string;
  hash: string;
};
