import { describe, expect, it } from "vitest";
import type { GenerateRequest, LlmMessage, ToolDefinition } from "@rafex/galaxia-fhs-protocol";
import type { AgentEvent } from "../events.js";
import { AgentRuntime } from "../runtime.js";
import { EventBus } from "../../events/event-bus.js";
import type { AtlasClient } from "../../atlas-client.js";
import {
  LlmGateway,
  type DeltaHandler,
  type GenerateDispatchResult,
  type LlmProviderSelection,
  type TraceContext,
} from "../../providers/llm-gateway.js";

/** Gateway falso: manda los deltas como lo haría un Star y responde el texto completo. */
class FakeGateway extends LlmGateway {
  constructor(private readonly deltas: string[], private readonly executedBy?: string, private readonly withToolCall = false) {
    super();
  }
  override generate(
    _selection: LlmProviderSelection,
    request: GenerateRequest,
    _timeoutMs?: number,
    _trace?: TraceContext,
    onDelta?: DeltaHandler,
  ): Promise<GenerateDispatchResult> {
    for (const delta of this.deltas) onDelta?.(delta);
    return Promise.resolve({
      response: {
        message: { role: "assistant", content: this.deltas.join("") },
        toolCalls: this.withToolCall ? [{ id: "c1", type: "function", function: { name: "kb_query", arguments: "{}" } }] : [],
        model: request.model ?? "auto",
        provider: "p2p",
      },
      dispatchMs: 1,
      providerId: this.executedBy,
    });
  }
}

const atlas: AtlasClient = { getProviders: () => Promise.resolve([]), recordSample: () => undefined };
const llm = {
  nodeId: "did:star:elegido",
  providerName: "Star elegido",
  service: {} as never,
  model: { id: "auto" } as never,
  reason: [],
};

type CallLlm = (
  llm: unknown,
  messages: LlmMessage[],
  tools?: ToolDefinition[],
  maxWaitMs?: number,
  emitAnswer?: boolean,
) => Promise<{ message: LlmMessage }>;

function setup(gateway: LlmGateway) {
  const bus = new EventBus();
  const deltas: string[] = [];
  bus.subscribe({ id: "t", send: (event: AgentEvent) => { if (event.type === "assistant.delta") deltas.push(event.data.text); } });
  const runtime = new AgentRuntime(atlas, bus, "conv-1", undefined, gateway);
  const callLlm = (runtime as unknown as { callLlm: CallLlm }).callLlm.bind(runtime);
  return { runtime, deltas, callLlm };
}

const ask: LlmMessage[] = [{ role: "user", content: "hola" }];

describe("AgentRuntime.callLlm", () => {
  it("reenvía cada delta del Star al portal en vivo (no todo al final)", async () => {
    const { deltas, callLlm } = setup(new FakeGateway(["Ho", "la", " mundo"]));
    await callLlm(llm, ask);
    expect(deltas).toEqual(["Ho", "la", " mundo"]);
  });

  it("las llamadas internas (elegir KB) no aparecen en el chat", async () => {
    const { deltas, callLlm } = setup(new FakeGateway(['{"kbId": null}']));
    await callLlm(llm, ask, undefined, undefined, false);
    expect(deltas).toEqual([]);
  });

  it("con tools no transmite texto a medias; si no hubo tool calls, lo emite completo al final", async () => {
    const tools: ToolDefinition[] = [{ type: "function", function: { name: "kb_query", parameters: { type: "object" } } }];
    const { deltas, callLlm } = setup(new FakeGateway(["Res", "puesta"]));
    await callLlm(llm, ask, tools);
    expect(deltas).toEqual(["Respuesta"]);

    const withToolCall = setup(new FakeGateway(["pensando…"], undefined, true));
    await withToolCall.callLlm(llm, ask, tools);
    expect(withToolCall.deltas).toEqual([]);
  });

  it("la procedencia nombra al Star que ejecutó si no fue el elegido", async () => {
    const { runtime, callLlm } = setup(new FakeGateway(["ok"], "did:star:otro"));
    await callLlm(llm, ask);
    const provenance = (runtime as unknown as { buildProvenance: (l: unknown) => { llm: { providerId: string } } }).buildProvenance(llm);
    expect(provenance.llm.providerId).toBe("did:star:otro");
  });
});
