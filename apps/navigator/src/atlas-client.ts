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
 * Vista de descubrimiento que usa el runtime. La implementación obligatoria
 * del Navigator es P2pAtlasClient; no existe un cliente Atlas HTTP paralelo.
 */
export interface AtlasClient {
  getProviders(type?: "llm" | "mcp"): Promise<ResolvedProvider[]>;
  recordSample(input: RecordSampleInput): void;
}
