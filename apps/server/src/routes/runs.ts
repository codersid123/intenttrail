import { Router } from "express";
import { z } from "zod";
import type { DB } from "../db/db";
import type { PaymentProvider } from "../paypal/types";
import { newRunId, runScenario, SCENARIO_IDS, SCENARIOS } from "../agents/scenarios";
import { getEvents, verifyChain } from "../provenance/log";
import { decodeJws } from "../crypto/jws";

const StartRun = z.object({ scenario: z.enum(SCENARIO_IDS), wait: z.boolean().optional() });

type RunRow = {
  id: string;
  scenario: string;
  payment_mode: string;
  fault_injection: string | null;
  status: string;
  approve_url: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
};

const parseRun = (r: RunRow) => ({
  ...r,
  fault_injection: r.fault_injection ? JSON.parse(r.fault_injection) : null,
  result: r.result ? JSON.parse(r.result) : null,
});

export function runsRouter(db: DB, provider: PaymentProvider): Router {
  const r = Router();

  r.get("/scenarios", (_req, res) => {
    res.json(Object.values(SCENARIOS));
  });

  /** Start a run. Returns 202 + runId right away; poll GET /api/runs/:id.
   *  Send { wait: true } to block until it finishes (handy from PowerShell). */
  r.post("/runs", async (req, res) => {
    const parsed = StartRun.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "body must be { scenario: 'A' | 'B' | 'C' | 'D', wait?: boolean }" });
      return;
    }
    const { scenario, wait } = parsed.data;
    const runId = newRunId(scenario);
    const done = runScenario(db, provider, scenario, {
      runId,
      hooks: { onApprovalRequired: (url) => console.log(`[${runId}] 👉 Approve as the sandbox BUYER: ${url}`) },
    });
    if (wait) {
      res.json(await done);
      return;
    }
    done.catch((e) => console.error(`[${runId}]`, e));
    res.status(202).json({ runId, status: "running", poll: `/api/runs/${runId}` });
  });

  r.get("/runs", (_req, res) => {
    const rows = db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 50").all() as RunRow[];
    res.json(rows.map(parseRun));
  });

  /** Everything the Run / Tree pages need for one run. */
  r.get("/runs/:runId", (req, res) => {
    const id = req.params.runId;
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!run) {
      res.status(404).json({ error: `run ${id} not found` });
      return;
    }
    const mandates = (
      db.prepare("SELECT mid, parent_mid, iss, sub, jws, max_amount, revoked_at, created_at FROM mandates WHERE run_id = ? ORDER BY created_at").all(id) as Array<{
        mid: string;
        jws: string;
      }>
    ).map((m) => ({ ...m, payload: decodeJws(m.jws) }));
    const mids = mandates.map((m) => m.mid);
    const ledger = mids.length
      ? db.prepare(`SELECT * FROM budget_ledger WHERE mid IN (${mids.map(() => "?").join(",")}) ORDER BY created_at`).all(...mids)
      : [];
    const transactions = db.prepare("SELECT * FROM transactions WHERE run_id = ?").all(id);
    res.json({
      run: parseRun(run),
      mandates,
      ledger,
      transactions,
      events: getEvents(db, id),
      chain: verifyChain(db, id),
    });
  });

  return r;
}
