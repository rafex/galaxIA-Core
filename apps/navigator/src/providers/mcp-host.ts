import type {
  PublishedService,
  Signal,
  ToolParameterSchema,
} from "@rafex/galaxia-fhs-protocol";

export interface LoadedTool {
  name: string;
  description?: string;
  inputSchema?: ToolParameterSchema;
  providerId: string;
  providerName: string;
  capabilityId: string;
}

export interface DispatchResult {
  message: unknown;
  dispatchMs: number | null;
}

export interface TraceContext {
  conversationId: string;
  capabilityId: string;
  deviceId?: string;
}

/**
 * Contrato común del runtime. El descubrimiento e invocación de tools se
 * realiza exclusivamente por P2pMcpHost/libp2p; no hay cliente MCP HTTP,
 * WebSocket, SSE ni JSON sobre el wire FHS.
 */
export class McpHost {
  connectProvider(
    _providerId: string,
    _providerName: string,
    _service: PublishedService
  ): Promise<never> {
    return Promise.reject(new Error("FHS requiere modo libp2p: no existe conexión MCP HTTP/WebSocket"));
  }

  loadToolsForCapabilities(
    _providers: Array<{ providerId: string; providerName: string; service: PublishedService }>
  ): Promise<LoadedTool[]> {
    return Promise.resolve([]);
  }

  callTool(
    _providerId: string,
    _toolName: string,
    _args: Record<string, unknown>,
    _timeoutMs?: number,
    _trace?: TraceContext
  ): Promise<DispatchResult> {
    return Promise.reject(new Error("FHS tool provider no conectado: el transporte FHS requiere modo libp2p"));
  }

  disconnect(_providerId: string): void {
    // El lifecycle del stream P2P lo administra P2pMcpHost.
  }

  protected matchCapabilityId(capabilities: Signal[], toolName: string): string {
    if (capabilities.length === 1) return capabilities[0].id;
    const toolWords = new Set(toolName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    let best: { id: string; score: number } | null = null;
    for (const capability of capabilities) {
      const words = capability.id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const score = words.filter((word) => toolWords.has(word)).length;
      if (score > 0 && (!best || score > best.score)) best = { id: capability.id, score };
    }
    return best?.id ?? toolName;
  }
}
