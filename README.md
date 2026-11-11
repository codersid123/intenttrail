# IntentTrail

**Liability resolution for disputes in multi-agent AI purchases, built on PayPal.**

Built for the PayPal AI Hackathon 2026 — *Build What's Next with PayPal and AI*.

> 🎥 Demo video: _TODO_  ·  🌐 Live demo: _TODO_  ·  📄 Devpost: _TODO_

---

## The problem

AI agents now hand purchases off to other agents (an orchestrator → a flight agent, a hotel agent). When a user disputes one of those purchases, nobody can prove which link failed:

- the **user** (bought exactly what they asked for, then regretted it),
- an **agent** (broke its budget, category or refundability limits), or
- the **merchant** (charged more than the cart they signed).

Today the merchant usually loses by default. Standards like Google AP2, Mastercard Verifiable Intent and Visa Trusted Agent Protocol prove what was authorized *before* a purchase. None of them turns that proof into a **liability decision after a dispute**, and none tracks authority across every sub-agent hop.

## What IntentTrail does

1. **Signed, non-escalating mandates.** Every agent gets an Ed25519-signed mandate. A child mandate can only *narrow* its parent's limits (amount, categories, merchants, expiry, refundability).
2. **Real PayPal sandbox purchases.** Authorize → capture via PayPal Orders v2 / Payments v2, using a vaulted PayPal wallet so agents can buy without a click per order.
3. **Tamper-evident provenance log.** Every action is written to a hash-chained log *before* it happens. Editing any past entry breaks the chain.
4. **AI dispute engine.** When a PayPal dispute arrives, a deterministic verifier walks the chain and finds the exact point of failure. Gemini explains it in plain language, and the dispute agent acts on it through PayPal's Disputes API.
5. **Evaluation harness.** Compares IntentTrail against an "LLM reads the logs" judge on ~40 synthetic runs.

> **Design rule:** code decides fault, the LLM only explains it. The LLM can only pick from verdicts the verifier marks as possible.

### Verdicts

| Code | Meaning | Liable party |
|---|---|---|
| `USER_WITHIN_MANDATE` | Purchase matched everything the user signed | User (merchant should win) |
| `AGENT_EXCEEDED_MANDATE` | An agent broke a constraint | Agent provider |
| `AGENT_ACTED_AFTER_REVOCATION` | Agent bought after its authority was revoked | Agent provider |
| `DELEGATION_ESCALATION` | A parent issued a child mandate wider than its own | Parent agent's provider |
| `MERCHANT_CART_MISMATCH` | Captured amount differs from the merchant-signed cart | Merchant |
| `INSUFFICIENT_EVIDENCE` | Chain broken, log tampered, or records missing | Manual review |

---

## Demo scenarios

**Priya:** *"Book a Goa trip, total under $500, refundable hotels only."*

```
Priya (root mandate: $500, refundable_only, [flight, hotel], 24h)
 └── Orchestrator
      ├── Flight agent  ($200, flight)
      └── Hotel agent   ($300, hotel, refundable_only)
```

| # | Scenario | What happens | Verdict |
|---|---|---|---|
| A | User regret | Refundable $250 hotel booked; Priya disputes anyway | `USER_WITHIN_MANDATE` |
| B | Agent error | Hotel agent books a **non-refundable** $220 hotel | `AGENT_EXCEEDED_MANDATE` |
| C | Merchant error | Signed cart $190, merchant captures $215 | `MERCHANT_CART_MISMATCH` |
| D | Tampered log | Evidence edited after purchase to hide the fault | `INSUFFICIENT_EVIDENCE` |

Faulty behaviour is injected deliberately via a visible `faultInjection` flag, stored in the `runs` table and **not** in the provenance log (so the LLM-only baseline can't read the answer).

---

## Architecture

```
            ┌──────────────┐  signed mandates   ┌──────────────┐
  User ───▶ │ Orchestrator │ ─────────────────▶ │  Sub-agents  │
            └──────────────┘                    └──────┬───────┘
                                                       │ signed cart → reserve budget
                                                       ▼
                                             PayPal Orders / Payments
                                              (authorize → capture)
                                                       │
         every step ──▶ hash-chained provenance log ◀──┘
                                                       │
  PayPal dispute ──▶ Dispute agent (Agent Toolkit) ──▶ Verifier ──▶ Gemini explainer
                                                       │
                                     provide evidence / accept claim / manual review
```

### Dispute actions

| Verdict | Action on PayPal |
|---|---|
| `USER_WITHIN_MANDATE` | Contest with an evidence PDF (mandate chain, signed cart, timeline, hash proof) |
| `MERCHANT_CART_MISMATCH` | Accept the claim — the system is fair, not merchant-biased |
| `AGENT_*` / `DELEGATION_ESCALATION` | Contest with evidence naming the agent and broken rule |
| `INSUFFICIENT_EVIDENCE` | Manual review, pointing to the tampered record |

---

## Tech stack

All free or hackathon-provided.

| Layer | Choice |
|---|---|
| Language | TypeScript |
| Backend | Node.js 24 + Express 5 |
| DB | SQLite (`better-sqlite3`) |
| Signing | `jose`, Ed25519 JWS |
| LLM | Google Gemini (`gemini-3.5-flash-lite`) via Vercel AI SDK |
| PayPal | REST (Orders v2, Payments v2, Disputes v1, Vault v3) + PayPal Agent Toolkit |
| Frontend | React + Vite + Tailwind v4, React Flow, AG Grid Community |
| Validation / tests | `zod`, Node test runner via `tsx --test` |

---

## Getting started

### Prerequisites
- Node.js 24+
- PayPal Developer sandbox app (Client ID + Secret) with **Save payment methods** enabled
- Gemini API key from Google AI Studio

### Setup

```powershell
git clone https://github.com/codersid123/intenttrail.git
cd intenttrail
npm install
copy .env.example .env   # then fill in the values below
```

`.env`:

```
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
PAYPAL_VAULT_ID=                 # from `npm run paypal:vault`; empty = approve each order in browser
PAYMENT_MODE=paypal              # 'paypal' for demo, 'mock' for eval/tests
GOOGLE_GENERATIVE_AI_API_KEY=
LLM_MODEL=gemini-3.5-flash-lite
DATABASE_PATH=./intenttrail.db
PORT=4000
WEB_ORIGIN=http://localhost:5173
```

### Run

```powershell
npm run paypal:token     # check PayPal credentials
npm run gemini:test      # check Gemini key
npm run paypal:vault     # one-time: save the sandbox buyer's PayPal wallet
npm run dev              # server on :4000, web on :5173
```

### Useful scripts

| Command | What it does |
|---|---|
| `npm test` | Run the test suite |
| `npm run demo:tree` | Print the 3-level mandate tree with budgets |
| `npm run scenario A` | Run scenario A / B / C / D against the PayPal sandbox |
| `npm run disputes` | List disputes (`get <id>`, `create ...`, `seller-response <id>`) |
| `npm run typecheck` | Type-check all workspaces |

---

## Evaluation

_TODO: fill in after the final eval run._

| Metric | LLM-only judge | IntentTrail |
|---|---|---|
| Overall accuracy | ___ | ___ |
| Tamper detection rate | ___ | ___ |

Numbers are reported as measured; the baseline is not tuned to look bad.

---

## What's real vs. mocked

- **Real (PayPal sandbox):** demo payments, the vaulted buyer wallet, authorizations, captures and disputes.
- **Mocked:** the merchant catalog (2 merchants, 14 items) and payments in the eval harness/tests (`PAYMENT_MODE=mock`, flagged `is_mock` in the DB).

## Security notes

Covered: escalation attempts, sibling overspend (carve-out budgets + atomic reservation), post-revocation purchases, replayed carts, forged carts/mandates, merchant overcharge, tampered evidence, hallucinated verdicts.

Out of scope for the hackathon: private keys are stored in the DB (production would use passkeys or a KMS), compromised user devices, merchant–agent collusion, and an attacker with full DB access rebuilding the whole hash chain (production would anchor the head hash externally).

## Future work

- Issue child mandates as AP2 Intent Mandates / Verifiable Intent credentials
- Route agent-fault disputes to the agent provider (liability shifting)
- Webhook-driven, real-time dispute handling
- Device-bound user keys (passkeys)
- External anchoring of the provenance head hash
- Selective disclosure of constraints to dispute reviewers
