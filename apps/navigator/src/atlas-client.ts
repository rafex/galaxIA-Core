import type { PublishedService } from "@rafex/galaxia-fhs-protocol";

export interface ResolvedProvider {
  providerId: string;
  name: string;
  type: string;
  service: PublishedService;
}

export interface RecordSampleInput {
  providerId: string;
  capability: string;
  sample: {
    dispatchMs: number | null;
    totalMs: number;
    success: boolean;
    at: number;
  };
}

/**
 * Cliente HTTP de Atlas — reemplaza las llamadas en proceso a la clase
 * `Atlas` (registry.ts) que existían cuando Navigator y Atlas vivían en el
 * mismo proceso. `getProviders` es la única lectura que el runtime necesita
 * antes de resolver un LLM/tool; `recordSample` es fire-and-forget: una
 * muestra de telemetría perdida no debe afectar la respuesta al usuario
 * (SPEC-SATRATING-0001) si Atlas está lento o caído.
 */
export class AtlasClient {
  constructor(private atlasUrl: string) {}

  async getProviders(type?: "llm" | "mcp"): Promise<ResolvedProvider[]> {
    const url = new URL("/api/fhs/providers", this.atlasUrl);
    if (type) url.searchParams.set("type", type);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new Error(`Atlas respondió ${res.status} en /api/fhs/providers`);
    }
    return (await res.json()) as ResolvedProvider[];
  }

  recordSample(input: RecordSampleInput): void {
    const url = new URL("/api/fhs/metrics/sample", this.atlasUrl);
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      // best-effort: no propagar el error al flujo de chat.
    });
  }
}
