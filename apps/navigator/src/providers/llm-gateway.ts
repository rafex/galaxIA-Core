import type {
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  ToolDefinition,
  ToolParameterSchema,
  PublishedService,
} from "@rafex/galaxia-fhs-protocol";

/** Contexto de trazabilidad (DEC-0012). */
export interface TraceContext {
  conversationId: string;
  capability: string;
  deviceId?: string;
}

export interface LlmProviderSelection {
  nodeId: string;
  providerName: string;
  service: PublishedService;
  model: ModelInfo;
}

export interface GenerateDispatchResult {
  response: GenerateResponse;
  dispatchMs: number | null;
}

/**
 * Contrato común del runtime. El Navigator no implementa un cliente remoto
 * HTTP/WebSocket: el transporte FHS obligatorio es el gateway P2P.
 * P2pLlmGateway aporta la implementación libp2p concreta.
 */
export class LlmGateway {
  generate(
    _selection: LlmProviderSelection,
    _request: GenerateRequest,
    _timeoutMs?: number,
    _trace?: TraceContext
  ): Promise<GenerateDispatchResult> {
    return Promise.reject(new Error("FHS requiere modo libp2p: no existe un gateway LLM HTTP/WebSocket"));
  }

  stream(
    _selection: LlmProviderSelection,
    _request: GenerateRequest
  ): AsyncGenerator<string, GenerateResponse, unknown> {
    return (async function* (): AsyncGenerator<string, GenerateResponse, unknown> {
      await Promise.resolve();
      throw new Error("FHS requiere modo libp2p: no existe un stream LLM HTTP/WebSocket");
    })();
  }

  supportsToolCalling(model: ModelInfo): boolean {
    return !!model.toolCalling?.supported;
  }

  toToolDefinitions(
    tools: Array<{ name: string; description?: string; inputSchema?: ToolParameterSchema }>
  ): ToolDefinition[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || `Tool ${tool.name}`,
        parameters: tool.inputSchema || { type: "object", properties: {} },
      },
    }));
  }
}
