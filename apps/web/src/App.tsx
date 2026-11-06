import { useEffect, useState } from "react";
import { FAULT_CODES } from "@intenttrail/shared";

type Health = { ok: boolean; paymentMode: string; llmModel: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-8">
      <h1 className="text-3xl font-bold">IntentTrail</h1>
      <p className="text-slate-400 mt-1">
        Liability resolution for multi-agent AI purchases
      </p>

      <section className="mt-6 rounded-lg border border-slate-800 p-4">
        <h2 className="font-semibold">Server status</h2>
        {error && (
          <p className="text-red-400 mt-2">❌ Can't reach server: {error}</p>
        )}
        {!health && !error && <p className="text-slate-400 mt-2">Checking…</p>}
        {health && (
          <p className="text-emerald-400 mt-2">
            ✅ Connected · payment mode: {health.paymentMode} · model:{" "}
            {health.llmModel}
          </p>
        )}
      </section>

      <section className="mt-4 rounded-lg border border-slate-800 p-4">
        <h2 className="font-semibold">Fault codes (from the shared package)</h2>
        <ul className="mt-2 grid gap-1 font-mono text-sm text-slate-300">
          {FAULT_CODES.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
