import {
  type ArtifactRef,
  type Signal,
  type GenerateRequest,
  type KbCitation,
  type KbQueryChunk,
  type LlmMessage,
  type ModelInfo,
  type PrivacyScope,
  type PublishedService,
  type ToolCall,
  type ToolDefinition,
  type UserMessage,
} from "@rafex/galaxia-fhs-protocol";
import type { AgentEvent, ProvenanceInfo } from "./events.js";

/**
 * Todo evento conversation-scoped se construye sin `conversationId` — `emit()`
 * lo adjunta siempre (ver DEC-0018) — así ningún call site puede olvidarlo.
 */
type AgentEventInput = AgentEvent extends infer E
  ? E extends { data: infer D }
    ? Omit<E, "data"> & { data: Omit<D, "conversationId"> }
    : never
  : never;
import { AtlasClient } from "../atlas-client.js";
import { EventBus } from "../events/event-bus.js";
import { LlmGateway } from "../providers/llm-gateway.js";
import { McpHost, LoadedTool } from "../providers/mcp-host.js";
import { atDeclaredCapacity } from "../providers/inflight.js";
import {
  isIpfsConfigured,
  resolveGatewayUrl,
  scheduleBackstopUnpin,
  unpinFromIpfs,
  uploadToIpfs,
} from "../ipfs/ipfs-client.js";

export interface ModelPreferences {
  model?: string;
  scope?: PrivacyScope;
  allowExternalProviders?: boolean;
  /**
   * "Kill" configurable de la espera de una Mission/Star (DEC-0010): cuánto
   * tiempo (ms) espera el Agent Server una respuesta antes de abandonar y
   * liberar la conversación, en vez del default fijo del stack (~300s). Es
   * responsabilidad del nodo (Star/Satellite) resolver internamente si se
   * atoró — esto solo controla la paciencia del lado del Portal.
   */
  maxWaitMs?: number;
  /**
   * Modo manual (SPEC-KB-0001, DEC-0027): providerId de la KB elegida
   * explícitamente por el usuario. Puede cambiar entre preguntas de una
   * misma conversación — a diferencia de RAG, no queda fija.
   */
  kb?: string;
  /**
   * Cuántas KBs se consultan por una sola pregunta (default 1). Subirlo
   * puede saturar el contexto de modelos pequeños — el Portal debe advertir
   * explícitamente antes de permitirlo (DEC-0027). Esta iteración solo
   * implementa el caso `1`; valores mayores se documentan como pendiente,
   * ver TASK-KB-0004.
   */
  kbMaxPerQuestion?: number;
  /**
   * Transporte de adjuntos vía IPFS (SPEC-IPFS-0001, DEC-0044/0051/0052) —
   * configuración explícita del Portal, no una elección por adjunto ni por
   * conversación. Si no está presente o `enabled` es `false`, el adjunto
   * viaja inline (comportamiento directo, sin cambios).
   */
  ipfs?: {
    enabled: boolean;
    network: "public" | "private";
    /** "ephemeral" (default): se borra tras usarse. "reuse": el usuario es responsable del borrado. */
    retention: "ephemeral" | "reuse";
  };
}

interface ResolvedLlm {
  nodeId: string;
  providerName: string;
  service: PublishedService;
  model: ModelInfo;
  reason: string[];
}

interface ResolvedToolProvider {
  capability: Signal;
  providerId: string;
  providerName: string;
  service: PublishedService;
}

export interface OcrExtractionResult {
  text: string | null;
  error?: { code: string; message: string };
}

export class AgentRuntime {
  private llmGateway: LlmGateway;
  private mcpHost: McpHost;
  private artifacts: string[] = [];
  private lastOcrError: string | undefined;
  private usedTools: Array<{
    capability: string;
    providerId: string;
    providerName: string;
    toolName: string;
    /** Citas de los fragmentos usados, si la tool las expone (DEC-0049). */
    citations?: KbCitation[];
  }> = [];

  constructor(
    private atlasClient: AtlasClient,
    private eventBus: EventBus,
    private conversationId: string,
    private deviceId?: string,
    llmGatewayOverride?: LlmGateway,
    mcpHostOverride?: McpHost
  ) {
    this.llmGateway = llmGatewayOverride ?? new LlmGateway();
    this.mcpHost = mcpHostOverride ?? new McpHost();
  }

  async run(
    message: UserMessage,
    preferences: ModelPreferences,
    artifacts?: string[],
    preExtractedText?: string,
    ragActive?: boolean,
    kbProviderIds?: string[]
  ) {
    this.artifacts = preExtractedText ? [] : artifacts || [];
    this.emitStatus("classifying", "Analizando tu petición...");

    const capabilities = classifyIntent(message.content);
    // Adjuntar un archivo ya expresa la intención de OCR sin ambigüedad —
    // no depender de que el texto del mensaje también contenga palabras
    // clave como "ocr"/"texto"/"imagen" (ver DEC-0020). Si el texto ya viene
    // pre-extraído (DocumentContext de una pregunta anterior), no hace
    // falta resolver el provider de OCR de nuevo.
    if (this.artifacts.length > 0 && !capabilities.includes("document.ocr")) {
      capabilities.push("document.ocr");
    }
    this.emitStatus("resolving-model", "Buscando modelo disponible...");

    const llm = await this.resolveLlm(preferences);
    if (!llm) {
      this.emitError("NO_LLM", "No hay modelos disponibles con tool calling en tu scope");
      return;
    }

    this.emit({
      type: "llm.selected",
      data: {
        providerId: llm.nodeId,
        providerName: llm.providerName,
        modelId: llm.model.id,
        reason: llm.reason,
      },
    });

    this.emitStatus("resolving-tools", "Buscando herramientas...");
    const toolProviders = await this.resolveToolProviders(capabilities, preferences.scope);
    const loadedTools = await this.mcpHost.loadToolsForCapabilities(
      toolProviders.map((t) => ({
        providerId: t.providerId,
        providerName: t.providerName,
        service: t.service,
      }))
    );

    // Ejecución determinística: si hay un archivo adjunto y existe un provider
    // para document.ocr, se ejecuta el OCR directamente, sin esperar a que el
    // LLM "decida" invocarlo vía tool calling. Modelos pequeños/locales no son
    // confiables tomando esa decisión (ver spec-native/DECISIONS.md DEC-0020) —
    // cuando el usuario adjunta un archivo, la intención ya es inequívoca.
    let userContent = message.content;
    if (preExtractedText) {
      userContent = `[Texto extraído automáticamente del archivo adjunto mediante OCR]\n${preExtractedText}\n\n[Pregunta del usuario]\n${message.content}`;
      // No hay archivo real en este turno (ya se extrajo antes) — si se deja
      // la tool disponible, el LLM puede igual decidir invocarla sin adjunto
      // y fallar (ver bug encontrado en la demo multi-host: el modelo llamaba
      // ocr_extract sobre un /tmp/ocr.png inexistente tras reutilizar el contexto).
      for (let i = loadedTools.length - 1; i >= 0; i--) {
        if (loadedTools[i].capabilityId === "document.ocr") {
          loadedTools.splice(i, 1);
        }
      }
    } else {
      const ocrTools = this.artifacts.length > 0
        ? loadedTools.filter((t) => t.capabilityId === "document.ocr")
        : [];

      if (ocrTools.length > 0) {
        const ocrText = await this.runOcrDeterministically(ocrTools, preferences);
        for (let i = loadedTools.length - 1; i >= 0; i--) {
          if (loadedTools[i].capabilityId === "document.ocr") {
            loadedTools.splice(i, 1);
          }
        }
        userContent = ocrText
          ? `[Texto extraído automáticamente del archivo adjunto mediante OCR]\n${ocrText}\n\n[Pregunta del usuario]\n${message.content}`
          : `${message.content}\n\n(No se pudo extraer texto del archivo adjunto.)`;
      }
    }

    // SPEC-RAG-0001: recuperación determinística, nunca una decisión del LLM
    // vía tool calling — se dispara en cada turno de una conversación ya
    // marcada como "RAG activa" por la sesión Portal. Silenciosa: no se expone en
    // la UI qué fragmentos se recuperaron (a diferencia de OCR).
    if (ragActive) {
      const ragContext = await this.queryRagContext(message.content, preferences);
      if (ragContext) {
        userContent = `[Fragmentos relevantes del documento indexado]\n${ragContext}\n\n[Pregunta del usuario]\n${userContent}`;
      }
    }

    // SPEC-KB-0001/SPEC-KB-0002: kbProviderIds ya viene resuelto por
    // la sesión Portal — modo manual (preferences.kb, un solo id) o modo
    // recomendado/límite ya confirmado por el usuario (kb.decision, uno o
    // varios ids). Nunca el LLM decide qué KB(s) usar sin que el usuario
    // haya visto y confirmado cuáles se van a consultar.
    if (kbProviderIds && kbProviderIds.length > 0) {
      const kbContext = await this.queryMultipleKbs(kbProviderIds, message.content, preferences);
      if (kbContext) {
        userContent = `[Fragmentos relevantes de la(s) base(s) de conocimiento]\n${kbContext}\n\n${userContent}`;
      }
    }

    const toolDefinitions: ToolDefinition[] = this.llmGateway.toToolDefinitions(loadedTools);

    // Preparar mensajes
    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          "Eres un asistente útil de una red soberana de IA comunitaria. " +
          "Responde siempre en español. " +
          "Si necesitas usar una herramienta, hazlo UNA SOLA VEZ y luego responde con la información obtenida. " +
          "No repitas llamadas a herramientas.",
      },
      { role: "user", content: userContent },
    ];

    // Primera llamada: permite que el LLM solicite tools
    let response = await this.callLlm(llm, messages, toolDefinitions, preferences.maxWaitMs);
    messages.push(response.message);

    // Ejecutar tools solicitadas (una sola ronda)
    if (response.toolCalls.length > 0) {
      const executed = new Set<string>();
      for (const toolCall of response.toolCalls) {
        const key = `${toolCall.function.name}:${toolCall.function.arguments}`;
        if (executed.has(key)) continue;
        executed.add(key);
        await this.executeToolCall(toolCall, loadedTools, preferences, messages);
      }

      // Segunda llamada: genera respuesta final SIN tools
      response = await this.callLlm(llm, messages, undefined, preferences.maxWaitMs);
      messages.push(response.message);
    }

    this.emit({ type: "assistant.completed", data: { provenance: this.buildProvenance(llm) } });
  }

  private async resolveLlm(preferences: ModelPreferences): Promise<ResolvedLlm | null> {
    const providers = await this.atlasClient.getProviders("llm");
    const inScope = providers.filter((p) =>
      preferences.scope ? matchesScope(p.service, preferences.scope) : true
    );

    // Backpressure (DEC-0072): no mandar la petición N+1 a un nodo que
    // declaró capacidad N y ya la tiene ocupada desde este Navigator. Es un
    // filtro best-effort (vista local, no global) — si TODOS los candidatos
    // están a tope, se usa la lista completa igual: mejor encolar en el
    // provider (que puede rechazar con OVERLOADED y disparar failover) que
    // responder "no hay modelos" a un usuario cuando sí los hay.
    const withCapacity = inScope.filter(
      (p) => !p.service.models?.every((m) => atDeclaredCapacity(p.providerId, m.availability?.maxConcurrentRequests))
    );
    const candidates = withCapacity.length > 0 ? withCapacity : inScope;

    if (preferences.model && preferences.model !== "auto") {
      for (const p of candidates) {
        const model = p.service.models?.find((m) => m.id === preferences.model);
        if (model) {
          return {
            nodeId: p.providerId,
            providerName: p.name,
            service: p.service,
            model,
            reason: ["manual-selection"],
          };
        }
      }
    }

    // Preferir modelo con tool calling nativo
    for (const p of candidates) {
      const model = p.service.models?.find((m) =>
        m.capabilities.includes("tool.calling") && m.toolCalling?.supported
      );
      if (model) {
        return {
          nodeId: p.providerId,
          providerName: p.name,
          service: p.service,
          model,
          reason: ["tool-calling", "available"],
        };
      }
    }

    // Fallback al primer modelo disponible
    const first = candidates[0];
    const model = first?.service.models?.[0];
    if (!model) return null;

    return {
      nodeId: first.providerId,
      providerName: first.name,
      service: first.service,
      model,
      reason: ["available"],
    };
  }

  private async resolveToolProviders(
    capabilities: string[],
    scope?: PrivacyScope
  ): Promise<ResolvedToolProvider[]> {
    const providers = await this.atlasClient.getProviders("mcp");
    const result: ResolvedToolProvider[] = [];
    const seen = new Set<string>();

    for (const cap of capabilities) {
      for (const p of providers) {
        if (scope && !matchesScope(p.service, scope)) continue;
        const capability = p.service.capabilities.find((c) => c.id === cap);
        if (capability && !seen.has(`${p.providerId}:${capability.id}`)) {
          seen.add(`${p.providerId}:${capability.id}`);
          result.push({
            capability,
            providerId: p.providerId,
            providerName: p.name,
            service: p.service,
          });
        }
      }
    }

    return result;
  }

  /**
   * Ejecuta OCR sobre el artifact adjunto y emite `ocr.extracted`, sin llamar
   * al LLM. El Portal puede diferir la emisión para registrar primero el
   * contexto efímero y luego continuar automáticamente con el prompt.
   */
  async extractOcrText(
    artifacts: string[],
    filename: string,
    preferences: ModelPreferences,
    emitExtractedEvent = true,
  ): Promise<OcrExtractionResult> {
    this.artifacts = artifacts;
    this.lastOcrError = undefined;
    const toolProviders = await this.resolveToolProviders(["document.ocr"], preferences.scope);
    const loadedTools = await this.mcpHost.loadToolsForCapabilities(
      toolProviders.map((t) => ({ providerId: t.providerId, providerName: t.providerName, service: t.service }))
    );
    const ocrTools = loadedTools.filter((t) => t.capabilityId === "document.ocr");
    if (ocrTools.length === 0) {
      return {
        text: null,
        error: { code: "NO_OCR_PROVIDER", message: "No hay proveedores de OCR disponibles en tu scope" },
      };
    }

    const text = await this.runOcrDeterministically(ocrTools, preferences);
    if (text) {
      if (emitExtractedEvent) this.emit({ type: "ocr.extracted", data: { filename, text } });
      return { text };
    }
    const ocrError: string | undefined = this.lastOcrError;
    return {
      text: null,
      error: {
        code: "OCR_FAILED",
        message: ocrError
          ? `No se pudo procesar el archivo adjunto: ${String(ocrError)}`
          : "No se pudo procesar el archivo adjunto.",
      },
    };
  }

  /**
   * Indexa un documento ya confirmado en un rag-provider (SPEC-RAG-0001) —
   * llamado por la sesión Portal en el mismo instante en que se resuelve
   * `attachment.decision { use: true }`, nunca antes ni de forma
   * especulativa. Degradación graceful: si no hay ningún rag-provider en el
   * scope del usuario, simplemente no hay RAG disponible para esta
   * conversación — no es un error visible para el usuario.
   */
  async indexDocumentForRag(
    text: string,
    preferences: ModelPreferences,
    source = "user-upload"
  ): Promise<boolean> {
    const toolProviders = await this.resolveToolProviders(["document.index"], preferences.scope);
    const loadedTools = await this.mcpHost.loadToolsForCapabilities(
      toolProviders.map((t) => ({ providerId: t.providerId, providerName: t.providerName, service: t.service }))
    );
    const indexTool = loadedTools.find((t) => t.capabilityId === "document.index");
    if (!indexTool) return false;

    try {
      await this.mcpHost.callTool(
        indexTool.providerId,
        indexTool.name,
        { text, conversationId: this.conversationId, source },
        preferences.maxWaitMs,
        { conversationId: this.conversationId, capabilityId: indexTool.capabilityId, deviceId: this.deviceId }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Recupera los fragmentos más relevantes del índice RAG de esta
   * conversación — silencioso (SPEC-RAG-0001: "la recuperación en turnos
   * 2+ es silenciosa", sin eventos tool.selected/running/completed como sí
   * emite OCR). Devuelve null si no hay rag-provider o no hay nada indexado.
   */
  private async queryRagContext(
    query: string,
    preferences: ModelPreferences,
    topK = 3,
    /** Etiqueta opcional por `source` (SPEC-KB-0002) — usado por la fusión multi-KB para citar de qué KB vino cada fragmento. */
    labelSource?: (source: string) => string | undefined
  ): Promise<string | null> {
    const toolProviders = await this.resolveToolProviders(["document.query"], preferences.scope);
    const loadedTools = await this.mcpHost.loadToolsForCapabilities(
      toolProviders.map((t) => ({ providerId: t.providerId, providerName: t.providerName, service: t.service }))
    );
    const queryTool = loadedTools.find((t) => t.capabilityId === "document.query");
    if (!queryTool) return null;

    const startTime = Date.now();
    try {
      const { message: result, dispatchMs } = await this.mcpHost.callTool(
        queryTool.providerId,
        queryTool.name,
        { query, conversationId: this.conversationId, top_k: topK },
        preferences.maxWaitMs,
        { conversationId: this.conversationId, capabilityId: queryTool.capabilityId, deviceId: this.deviceId }
      );
      const parsed = JSON.parse(extractText(result)) as {
        chunks: Array<{ text: string; score: number; source?: string }>;
      };
      this.atlasClient.recordSample({
        providerId: queryTool.providerId,
        capability: queryTool.capabilityId,
        sample: { dispatchMs, totalMs: Date.now() - startTime, success: true, at: Date.now() },
      });
      if (!parsed.chunks || parsed.chunks.length === 0) return null;

      this.usedTools.push({
        capability: queryTool.capabilityId,
        providerId: queryTool.providerId,
        providerName: queryTool.providerName,
        toolName: queryTool.name,
      });
      return parsed.chunks
        .map((c) => {
          const label = c.source ? labelSource?.(c.source) : undefined;
          return label ? `[Fuente: ${label}]\n${c.text}` : c.text;
        })
        .join("\n---\n");
    } catch {
      this.atlasClient.recordSample({
        providerId: queryTool.providerId,
        capability: queryTool.capabilityId,
        sample: { dispatchMs: null, totalMs: Date.now() - startTime, success: false, at: Date.now() },
      });
      return null;
    }
  }

  /** Lista los nodos `mcp` con capability `kb.query` visibles en el scope dado. */
  private async listKbProviders(
    scope?: PrivacyScope
  ): Promise<Array<{ providerId: string; providerName: string; description: string; tags: string[] }>> {
    const providers = await this.atlasClient.getProviders("mcp");
    const result: Array<{ providerId: string; providerName: string; description: string; tags: string[] }> = [];
    for (const p of providers) {
      if (scope && !matchesScope(p.service, scope)) continue;
      const kbCapability = p.service.capabilities.find((c) => c.id === "kb.query");
      if (!kbCapability) continue;
      result.push({
        providerId: p.providerId,
        providerName: p.name,
        description: kbCapability.description || kbCapability.id,
        tags: kbCapability.tags || [],
      });
    }
    return result;
  }

  /**
   * Umbral mínimo de similitud para considerar una KB "candidata" en el
   * matching determinístico (SPEC-KB-0002, pregunta abierta #1, DEC-0054) —
   * mismo valor ya usado por el modo "recomendado" de SPEC-KB-0001, para no
   * introducir un segundo número arbitrario sin justificación adicional.
   */
  private static readonly KB_MATCH_THRESHOLD = 0.05;

  /**
   * Matching determinístico (Jaccard contra `capability.description`/`tags`,
   * DEC-0028) — nunca el LLM decide en este paso. Devuelve las KBs que
   * superan el umbral, mejor puntuada primero, acotadas a `maxCount`
   * (SPEC-KB-0002 paso 4: top-N sobre un umbral, nunca todas las KBs).
   */
  private async recommendKbCandidates(
    question: string,
    scope: PrivacyScope | undefined,
    maxCount: number
  ): Promise<Array<{ providerId: string; providerName: string; description: string }>> {
    const kbs = await this.listKbProviders(scope);
    const questionTokens = tokenizeForMatching(question);

    return kbs
      .map((kb) => ({
        ...kb,
        score: jaccardSimilarity(questionTokens, tokenizeForMatching([kb.description, ...kb.tags].join(" "))),
      }))
      .filter((kb) => kb.score > AgentRuntime.KB_MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCount)
      .map(({ providerId, providerName, description }) => ({ providerId, providerName, description }));
  }

  /**
   * Caso límite de SPEC-KB-0002 (paso 5): ninguna KB superó el umbral
   * determinístico. En vez de un loop de razonamiento de varios pasos (cada
   * paso es una nueva oportunidad de que el modelo no llene el formato
   * esperado, DEC-0016/DEC-0017), se usa la misma disciplina ya aplicada al
   * catálogo de parsers tolerantes (DEC-0050/SPEC-PARSER-0001): **una sola
   * llamada al LLM + un parser determinístico y tolerante**, validado contra
   * los ids realmente ofrecidos — nunca se acepta un id que no esté en la
   * lista de candidatas. Si el parseo falla o el LLM no decide, el resultado
   * determinístico es "ninguna" — nunca se adivina.
   */
  private async chooseKbViaTolerantParse(
    question: string,
    candidates: Array<{ providerId: string; providerName: string; description: string }>,
    preferences: ModelPreferences
  ): Promise<string | null> {
    if (candidates.length === 0) return null;

    const llm = await this.resolveLlm(preferences);
    if (!llm) return null;

    const candidateList = candidates.map((c) => `- id: "${c.providerId}" — ${c.description}`).join("\n");
    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          "Tienes disponibles las siguientes bases de conocimiento:\n" +
          candidateList +
          "\n\nNinguna coincidió claramente con la pregunta según un análisis automático previo. " +
          'Responde ÚNICAMENTE con un JSON de la forma {"kbId": "<id>"} si alguna aplica, ' +
          'o {"kbId": null} si ninguna aplica. No agregues texto adicional, ni explicación, ni markdown.',
      },
      { role: "user", content: question },
    ];

    let content: string;
    try {
      const response = await this.callLlm(llm, messages, undefined, preferences.maxWaitMs);
      content = response.message.content || "";
    } catch {
      return null;
    }

    const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const kbId = parsed && typeof parsed === "object" ? (parsed as { kbId?: unknown }).kbId : undefined;
    if (typeof kbId !== "string") return null;
    const known = new Set(candidates.map((c) => c.providerId));
    return known.has(kbId) ? kbId : null;
  }

  /**
   * Resuelve qué KB(s) consultar para una pregunta sin selección manual
   * (SPEC-KB-0002) — top-N determinístico sobre el umbral; si ninguna
   * califica, el LLM elige una sola vez entre TODAS las KBs registradas
   * (paso 5), con el mismo parser tolerante ya usado para tool-calling.
   * La sesión Portal llama esto para construir la confirmación `kb.recommended`
   * — nunca se consulta nada sin que el usuario la haya visto antes.
   */
  async resolveKbCandidates(
    question: string,
    preferences: ModelPreferences
  ): Promise<{
    candidates: Array<{ providerId: string; providerName: string; description: string }>;
    chosenByLlm: boolean;
  }> {
    const maxCount = preferences.kbMaxPerQuestion ?? 1;
    const topN = await this.recommendKbCandidates(question, preferences.scope, maxCount);
    if (topN.length > 0) return { candidates: topN, chosenByLlm: false };

    const allKbs = await this.listKbProviders(preferences.scope);
    const chosenId = await this.chooseKbViaTolerantParse(question, allKbs, preferences);
    if (!chosenId) return { candidates: [], chosenByLlm: false };

    const chosen = allKbs.find((kb) => kb.providerId === chosenId)!;
    return {
      candidates: [{ providerId: chosen.providerId, providerName: chosen.providerName, description: chosen.description }],
      chosenByLlm: true,
    };
  }

  /**
   * Consulta N KBs (SPEC-KB-0002) y fusiona sus resultados reutilizando el
   * motor de RAG de la conversación — cada resultado se indexa en el RAG
   * con `source: "kb:<providerId>"` (una llamada `document_index` por KB, el
   * bridge acumula en vez de reemplazar, ver DEC-0054) y se resuelve con una
   * sola `document_query` sobre el índice combinado, en vez de inventar un
   * motor de reranking nuevo (DEC-0026/DEC-0037). Todas las KBs consultadas
   * quedan registradas en `usedTools` — incluso si alguna no aporta ningún
   * fragmento al resultado final — porque el requisito no negociable de
   * SPEC-KB-0002 es mostrar qué se consultó, no solo qué se usó.
   */
  private async queryMultipleKbs(
    kbProviderIds: string[],
    query: string,
    preferences: ModelPreferences
  ): Promise<string | null> {
    const providers = await this.atlasClient.getProviders("mcp");
    const providerNames = new Map<string, string>();
    let anyIndexed = false;

    for (const kbProviderId of kbProviderIds) {
      const target = providers.find((p) => p.providerId === kbProviderId);
      if (!target) continue;
      providerNames.set(kbProviderId, target.name);

      const loadedTools = await this.mcpHost.loadToolsForCapabilities([
        { providerId: target.providerId, providerName: target.name, service: target.service },
      ]);
      const kbTool = loadedTools.find((t) => t.capabilityId === "kb.query");
      if (!kbTool) continue;

      const startTime = Date.now();
      try {
        const { message: result, dispatchMs } = await this.mcpHost.callTool(
          kbTool.providerId,
          kbTool.name,
          { query, top_k: 3 },
          preferences.maxWaitMs,
          { conversationId: this.conversationId, capabilityId: kbTool.capabilityId, deviceId: this.deviceId }
        );
        const parsed = JSON.parse(extractText(result)) as { chunks: KbQueryChunk[] };
        this.atlasClient.recordSample({
          providerId: kbTool.providerId,
          capability: kbTool.capabilityId,
          sample: { dispatchMs, totalMs: Date.now() - startTime, success: true, at: Date.now() },
        });

        const citations = (parsed.chunks || []).map((c) => c.citation).filter((c): c is KbCitation => !!c);
        this.usedTools.push({
          capability: kbTool.capabilityId,
          providerId: kbTool.providerId,
          providerName: kbTool.providerName,
          toolName: kbTool.name,
          citations: citations.length > 0 ? citations : undefined,
        });

        if (parsed.chunks && parsed.chunks.length > 0) {
          const text = parsed.chunks
            .map((c) => (c.citation ? `[Fuente: ${c.citation.documentTitle}]\n${c.text}` : c.text))
            .join("\n---\n");
          const indexed = await this.indexDocumentForRag(text, preferences, `kb:${kbProviderId}`);
          if (indexed) anyIndexed = true;
        }
      } catch {
        this.atlasClient.recordSample({
          providerId: kbTool.providerId,
          capability: kbTool.capabilityId,
          sample: { dispatchMs: null, totalMs: Date.now() - startTime, success: false, at: Date.now() },
        });
      }
    }

    if (!anyIndexed) return null;

    // Fusión: una sola consulta sobre el índice combinado (todas las KBs +
    // cualquier documento del usuario ya indexado en esta conversación).
    // top_k proporcional al número de KBs consultadas para no perder
    // fragmentos relevantes de cada una al fusionar.
    const fused = await this.queryRagContext(
      query,
      preferences,
      Math.max(3, kbProviderIds.length * 2),
      (source) => (source.startsWith("kb:") ? providerNames.get(source.slice(3)) : undefined)
    );
    return fused;
  }

  /**
   * Ejecuta document.ocr directamente contra los providers, sin pasar por una
   * decisión del LLM. Emite los mismos eventos que executeToolCall para que
   * el frontend muestre la misma actividad (tool.selected/running/completed).
   * Itera sobre la lista de tools en orden — si una falla, intenta la
   * siguiente automáticamente (failover), emitiendo `provider.failover`.
   * Devuelve el texto extraído, o null si todas fallan (degradación graceful).
   */
  private async runOcrDeterministically(
    tools: LoadedTool[],
    preferences: ModelPreferences
  ): Promise<string | null> {
    if (tools.length === 0) return null;
    const artifact = this.artifacts[0];
    if (!artifact) return null;
    this.lastOcrError = undefined;

    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];

      this.emit({
        type: "tool.selected",
        data: { capability: tool.capabilityId, providerId: tool.providerId, providerName: tool.providerName },
      });
      this.emit({ type: "tool.running", data: { name: tool.name, providerId: tool.providerId } });
      const startTime = Date.now();

      let ipfsCid: string | undefined;
      let ipfsRetention: "ephemeral" | "reuse" | undefined;
      try {
        const built = await this.buildFileArtifact(artifact, preferences);
        ipfsCid = built.ipfsCid;
        ipfsRetention = built.ipfsRetention;
        const args = { file: built.file };
        const { message: result, dispatchMs } = await this.mcpHost.callTool(
          tool.providerId,
          tool.name,
          args,
          preferences.maxWaitMs,
          { conversationId: this.conversationId, capabilityId: tool.capabilityId, deviceId: this.deviceId }
        );
        const duration = Date.now() - startTime;
        const textResult = extractText(result);

        this.emit({ type: "tool.completed", data: { name: tool.name, duration, success: true } });
        this.atlasClient.recordSample({
          providerId: tool.providerId,
          capability: tool.capabilityId,
          sample: { dispatchMs, totalMs: duration, success: true, at: Date.now() },
        });
        this.usedTools.push({
          capability: tool.capabilityId,
          providerId: tool.providerId,
          providerName: tool.providerName,
          toolName: tool.name,
        });
        if (ipfsCid && ipfsRetention !== "reuse") void unpinFromIpfs(ipfsCid);
        return textResult;
      } catch (err) {
        const duration = Date.now() - startTime;
        const message = err instanceof Error ? err.message : String(err);
        this.lastOcrError = message;
        this.emit({ type: "tool.error", data: { name: tool.name, error: message } });
        this.atlasClient.recordSample({
          providerId: tool.providerId,
          capability: tool.capabilityId,
          sample: { dispatchMs: null, totalMs: duration, success: false, at: Date.now() },
        });
        if (ipfsCid && ipfsRetention !== "reuse") void unpinFromIpfs(ipfsCid);

        if (i < tools.length - 1) {
          const next = tools[i + 1];
          this.emit({
            type: "provider.failover",
            data: {
              capability: tool.capabilityId,
              failedProviderId: tool.providerId,
              failedProviderName: tool.providerName,
              nextProviderId: next.providerId,
              nextProviderName: next.providerName,
            },
          });
        }
      }
    }

    return null;
  }

  /**
   * Resuelve un adjunto (data URL) a un `ArtifactRef` (DEC-0047) — inline si
   * IPFS no está activo en las preferencias, o subido vía Navigator si sí
   * (DEC-0051). Devuelve también el CID y el modo de retención cuando aplica,
   * para que el llamador pueda hacer unpin inmediato tras la respuesta
   * (DEC-0052) — el TTL de respaldo ya queda agendado aquí mismo.
   */
  private async buildFileArtifact(
    artifact: string,
    preferences: ModelPreferences
  ): Promise<{ file: ArtifactRef; ipfsCid?: string; ipfsRetention?: "ephemeral" | "reuse" }> {
    const parsed = parseDataUrl(artifact);
    const filename = `upload-${Date.now()}.${parsed.extension}`;

    if (preferences.ipfs?.enabled && isIpfsConfigured()) {
      const network = preferences.ipfs.network;
      const retention = preferences.ipfs.retention;
      const cid = await uploadToIpfs(parsed.base64, filename);
      scheduleBackstopUnpin(cid, retention);
      const file: ArtifactRef = {
        transport: "ipfs",
        cid,
        network,
        gatewayUrl: resolveGatewayUrl(network),
        filename,
        retention,
      };
      return { file, ipfsCid: cid, ipfsRetention: retention };
    }

    return { file: { transport: "inline", base64: parsed.base64, filename } };
  }

  private async executeToolCall(
    toolCall: ToolCall,
    loadedTools: LoadedTool[],
    preferences: ModelPreferences,
    messages?: LlmMessage[]
  ) {
    const toolName = toolCall.function.name;
    const tool = loadedTools.find((t) => t.name === toolName);

    if (!tool) {
      this.emit({ type: "tool.error", data: { name: toolName, error: "Tool no encontrada" } });
      messages?.push({ role: "tool", content: "Error: tool no encontrada", tool_call_id: toolCall.id });
      return;
    }

    this.emit({
      type: "tool.selected",
      data: {
        capability: tool.capabilityId,
        providerId: tool.providerId,
        providerName: tool.providerName,
      },
    });

    if (!authorize(tool.providerId, preferences.scope)) {
      this.emit({
        type: "tool.error",
        data: { name: toolName, error: "No autorizado por política de privacidad" },
      });
      messages?.push({ role: "tool", content: "Error: no autorizado", tool_call_id: toolCall.id });
      return;
    }

    this.emit({ type: "tool.running", data: { name: toolName, providerId: tool.providerId } });
    const startTime = Date.now();

    let ipfsCid: string | undefined;
    let ipfsRetention: "ephemeral" | "reuse" | undefined;
    try {
      const args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;

      if (tool.capabilityId === "document.ocr" && !args.file) {
        const artifact = this.artifacts[0];
        if (!artifact) {
          this.emit({ type: "tool.error", data: { name: toolName, error: "No hay archivo adjunto para OCR" } });
          messages?.push({ role: "tool", content: "Error: no hay archivo adjunto", tool_call_id: toolCall.id });
          return;
        }
        const built = await this.buildFileArtifact(artifact, preferences);
        args.file = built.file;
        ipfsCid = built.ipfsCid;
        ipfsRetention = built.ipfsRetention;
      }

      const { message: result, dispatchMs } = await this.mcpHost.callTool(
        tool.providerId,
        toolName,
        args,
        preferences.maxWaitMs,
        { conversationId: this.conversationId, capabilityId: tool.capabilityId }
      );
      const duration = Date.now() - startTime;
      const textResult = extractText(result);

      this.emit({ type: "tool.completed", data: { name: toolName, duration, success: true } });
      this.atlasClient.recordSample({
        providerId: tool.providerId,
        capability: tool.capabilityId,
        sample: { dispatchMs, totalMs: duration, success: true, at: Date.now() },
      });
      this.usedTools.push({
        capability: tool.capabilityId,
        providerId: tool.providerId,
        providerName: tool.providerName,
        toolName,
      });

      messages?.push({ role: "tool", content: textResult, tool_call_id: toolCall.id });
      if (ipfsCid && ipfsRetention !== "reuse") void unpinFromIpfs(ipfsCid);
    } catch (err) {
      const duration = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "tool.error", data: { name: toolName, error: message } });
      this.atlasClient.recordSample({
        providerId: tool.providerId,
        capability: tool.capabilityId,
        sample: { dispatchMs: null, totalMs: duration, success: false, at: Date.now() },
      });
      messages?.push({ role: "tool", content: `Error: ${message}`, tool_call_id: toolCall.id });
      if (ipfsCid && ipfsRetention !== "reuse") void unpinFromIpfs(ipfsCid);
    }
  }

  private async callLlm(
    llm: ResolvedLlm,
    messages: LlmMessage[],
    tools?: ToolDefinition[],
    maxWaitMs?: number
  ): Promise<{ message: LlmMessage; toolCalls: ToolCall[] }> {
    const request: GenerateRequest = {
      model: llm.model.id,
      messages,
      tools,
      stream: false,
      temperature: 0.7,
    };

    const startTime = Date.now();
    let dispatchResult;
    try {
      dispatchResult = await this.llmGateway.generate(
        { nodeId: llm.nodeId, providerName: llm.providerName, service: llm.service, model: llm.model },
        request,
        maxWaitMs,
        { conversationId: this.conversationId, capability: llm.model.id, deviceId: this.deviceId }
      );
    } catch (err) {
      this.atlasClient.recordSample({
        providerId: llm.nodeId,
        capability: llm.model.id,
        sample: { dispatchMs: null, totalMs: Date.now() - startTime, success: false, at: Date.now() },
      });
      throw err;
    }

    const { response, dispatchMs } = dispatchResult;
    this.atlasClient.recordSample({
      providerId: llm.nodeId,
      capability: llm.model.id,
      sample: { dispatchMs, totalMs: Date.now() - startTime, success: true, at: Date.now() },
    });

    // Stream el delta si el frontend lo espera
    if (response.message.content && response.toolCalls.length === 0) {
      this.emit({ type: "assistant.delta", data: { text: response.message.content } });
    }

    return { message: response.message, toolCalls: response.toolCalls };
  }

  private buildProvenance(llm: ResolvedLlm): ProvenanceInfo {
    return {
      llm: {
        providerId: llm.nodeId,
        providerName: llm.providerName,
        model: llm.model.id,
      },
      tools: this.usedTools.map((t) => ({
        capability: t.capability,
        providerId: t.providerId,
        providerName: t.providerName,
        citations: t.citations,
      })),
      dataExported: this.usedTools.length > 0 ? "Datos enviados a tools federadas" : "Ninguno",
      jurisdiction: "red local comunitaria",
    };
  }

  // Todo evento conversation-scoped pasa por aquí para que conversationId se
  // adjunte siempre — así ningún call site puede olvidarlo (ver DEC-0018).
  private emit(event: AgentEventInput) {
    this.eventBus.emit({
      ...event,
      data: { ...event.data, conversationId: this.conversationId },
    } as AgentEvent);
  }

  private emitStatus(status: string, message: string) {
    this.emit({ type: "agent.status", data: { status, message } });
  }

  private emitError(code: string, message: string) {
    this.emit({ type: "error", data: { code, message } });
  }
}

function classifyIntent(content: string): string[] {
  const text = content.toLowerCase();
  const capabilities: string[] = [];

  if (text.includes("ocr") || text.includes("texto") || text.includes("imagen") || text.includes("foto")) {
    capabilities.push("document.ocr");
  }
  if (text.includes("resumen") || text.includes("resume")) {
    capabilities.push("text.summarize");
  }

  return capabilities;
}

// SPEC-KB-0001: matching determinístico de texto para el modo "recomendado"
// — mismo mecanismo de similitud (Jaccard) que rag-provider usa para
// recuperación, reutilizado aquí para decidir qué KB recomendar, nunca cuál
// invocar (eso lo confirma el usuario).
function tokenizeForMatching(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Regla 6 del protocolo (scope de privacidad), implementada de verdad desde
// la revisión 2026-07-10 — antes era un stub que retornaba true. Los ámbitos
// forman una jerarquía: un usuario que pide scope "local" solo acepta nodos
// locales; "external" acepta todo. Los servicios registrados antes de que
// Atlas propagara `visibility` no traen el campo — se tratan como "external"
// (el ámbito más restrictivo para el usuario: solo se usan si el usuario
// aceptó explícitamente el scope más amplio), nunca se cuelan en "local".
const SCOPE_RANK: Record<PrivacyScope, number> = {
  local: 0,
  network: 1,
  community: 2,
  external: 3,
};

function matchesScope(service: PublishedService, scope: PrivacyScope): boolean {
  const serviceScope: PrivacyScope = service.visibility ?? "external";
  return SCOPE_RANK[serviceScope] <= SCOPE_RANK[scope];
}

// Regla 8 del protocolo (veto de proveedores): lista de dids vetados por el
// operador vía FHS_VETOED_PROVIDERS (separados por coma). El veto por usuario
// individual llegará con identidad de usuario (SPEC-AUTH-0001); mientras
// tanto el operador del Navigator ya puede excluir nodos concretos. Los ids
// de sub-servicio de nodos multi llevan fragmento (`did#llm`) — el veto
// aplica al did base.
const vetoedProviders = new Set(
  (process.env.FHS_VETOED_PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function authorize(providerId: string, _scope?: PrivacyScope): boolean {
  const baseDid = providerId.split("#")[0];
  return !vetoedProviders.has(baseDid) && !vetoedProviders.has(providerId);
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

function parseDataUrl(dataUrl: string): { base64: string; mimeType: string; extension: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    // No es un data URL; se asume base64 crudo de una imagen.
    return { base64: dataUrl, mimeType: "image/png", extension: "png" };
  }
  const [, mimeType, base64] = match;
  return { base64, mimeType, extension: EXTENSION_BY_MIME[mimeType] || "bin" };
}

function extractText(result: unknown): string {
  if (typeof result === "string") {
    const raw = result.trim();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "result" in parsed) {
        const nested = (parsed as { result?: unknown }).result;
        return typeof nested === "string" ? nested.trim() : extractText(nested);
      }
    } catch {
      // El proveedor puede devolver texto OCR plano.
    }
    return result;
  }
  if (result && typeof result === "object") {
    if ("result" in result) {
      return extractText((result as { result?: unknown }).result);
    }
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
        .join("\n");
      return extractText(text);
    }
    return JSON.stringify(result);
  }
  return String(result);
}
