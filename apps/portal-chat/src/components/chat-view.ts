import type { AgentEvent, ChatMessage, ChatState, KbCitation, ProvenanceInfo } from "../types/fhs.js";
import { connectToChat, type ChatConnection } from "../services/api.js";
import { applyTheme, cycleTheme, getCurrentTheme, getInitialTheme, themeLabel } from "../services/theme.js";
import { createDrawerGroup } from "./drawer.js";
import { initTooltips, refreshTooltip } from "./tooltip.js";
import { createTour, hasTourRun, type TourStep } from "./tour.js";

interface ModelOption {
  modelId: string;
  displayName: string;
  providerId: string;
  providerName: string;
  /** DEC-0031: true si el operador del Agent Server marcó este nodo como de confianza. */
  trusted?: boolean;
}

interface KbOption {
  providerId: string;
  providerName: string;
  description: string;
}

export function createApp(container: HTMLElement, version: string = "unknown") {
  const state: ChatState = {
    messages: [],
    isStreaming: false,
    selectedModel: "auto",
    privacyScope: "community",
    ocrMode: "confirm",
    kbProviderId: "",
    kbMaxPerQuestion: 1,
    ipfsEnabled: false,
    ipfsNetwork: "public",
    ipfsRetention: "ephemeral",
  };

  let conversationId: string | null = null;
  let chatConnection: ChatConnection | null = null;
  let pendingAttachment: string | null = null;
  let pendingAttachmentIsPdf = false;
  let pendingAttachmentName: string | null = null;

  applyTheme(getInitialTheme());

  container.innerHTML = `
    <div class="app">
      <header class="header">
        <button type="button" class="icon-btn drawer-trigger" data-drawer-trigger="sidebar"
          aria-label="Conversaciones" data-tooltip="Ver conversaciones">☰</button>
        <h1>FHS Community</h1>
        <div class="header-spacer"></div>
        <div class="network-status" data-tooltip="Estado de la conexión con la red comunitaria FHS">
          <span class="status-dot"></span>
          <span>Red: FARO</span>
          <span class="version">${version}</span>
        </div>
        <button type="button" class="icon-btn drawer-trigger" data-drawer-trigger="activity"
          aria-label="Actividad del agente" data-tooltip="Ver qué está haciendo el agente y de dónde viene la respuesta">📊</button>
        <button type="button" class="icon-btn drawer-trigger" data-drawer-trigger="settings"
          aria-label="Ajustes" data-tooltip="Modelo, privacidad, adjuntos y transporte">⚙️</button>
        <button type="button" class="icon-btn theme-toggle" aria-label="Cambiar tema" data-tooltip="Cambiar tema de color">🌓</button>
        <button type="button" class="icon-btn tour-trigger" aria-label="Ayuda: repetir el tour guiado" data-tooltip="Repetir el tour guiado">?</button>
      </header>
      <aside class="sidebar drawer-panel" data-drawer="sidebar">
        <h2 data-tooltip="Historial de conversaciones en este dispositivo">Conversaciones</h2>
        <ul class="conversation-list">
          <li class="active">OCR demo</li>
        </ul>
      </aside>
      <main class="chat-area">
        <div class="messages"></div>
        <div class="composer">
          <input type="file" class="file-input" accept="image/*,application/pdf" hidden />
          <button class="attach-btn" type="button" data-tooltip="Adjuntar una imagen o PDF para extraer texto (OCR)">📎</button>
          <textarea placeholder="Escribe un mensaje..." rows="1"></textarea>
          <button class="send-btn" type="button" data-tooltip="Enviar mensaje (Enter)">Enviar</button>
        </div>
      </main>
      <aside class="activity-panel drawer-panel" data-drawer="activity">
        <h2 data-tooltip="Pasos que sigue el agente para resolver tu mensaje, en tiempo real">Actividad del agente</h2>
        <ul class="activity-log"></ul>
        <div class="provenance-card">
          <h3 data-tooltip="De dónde vino cada parte de la respuesta: modelo, herramientas y datos usados">Procedencia</h3>
          <p class="provenance-placeholder">Esperando primera respuesta...</p>
        </div>
      </aside>
      <footer class="settings-bar drawer-panel" data-drawer="settings">
        <label data-tooltip="Qué modelo de IA responde tu mensaje. ★ = nodo de confianza del operador">
          Modelo:
          <select class="model-selector">
            <option value="auto">Automático</option>
          </select>
        </label>
        <label data-tooltip="Qué tan lejos puede viajar tu mensaje en la red para encontrar un proveedor">
          Privacidad:
          <select class="scope-selector">
            <option value="local">Sólo este equipo</option>
            <option value="network">Mi red local</option>
            <option value="community" selected>Comunidad de confianza</option>
            <option value="external">Proveedores externos autorizados</option>
          </select>
        </label>
        <label data-tooltip="Qué hacer con el texto extraído de un documento adjunto antes de usarlo">
          Documentos adjuntos:
          <select class="ocr-mode-selector">
            <option value="confirm" selected>Confirmar antes de usar</option>
            <option value="auto">Automático (más rápido, sin confirmar)</option>
          </select>
        </label>
        <label data-tooltip="Base de conocimiento a consultar para responder preguntas sobre un tema">
          Base de conocimiento:
          <select class="kb-selector">
            <option value="" selected>Recomendada automáticamente (con confirmación)</option>
          </select>
        </label>
        <label data-tooltip="Cuántas bases de conocimiento se consultan a la vez cuando no eliges una manualmente">
          KBs por pregunta:
          <select class="kb-max-selector">
            <option value="1" selected>1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        <span class="kb-max-warning" hidden>⚠️ Consultar más de una KB puede ser notablemente más lento en modelos pequeños</span>
        <label data-tooltip="Cómo viajan tus adjuntos por la red: directo al proveedor o vía IPFS">
          Transporte de adjuntos:
          <select class="ipfs-mode-selector">
            <option value="direct" selected>Transmisión directa</option>
            <option value="ipfs">Vía IPFS</option>
          </select>
        </label>
        <label class="ipfs-network-row" hidden>
          Red IPFS:
          <select class="ipfs-network-selector">
            <option value="public" selected>Pública</option>
            <option value="private">Privada (nodo del operador)</option>
          </select>
        </label>
        <label class="ipfs-retention-row" hidden>
          Retención:
          <select class="ipfs-retention-selector">
            <option value="ephemeral" selected>Efímera (se borra al responder)</option>
            <option value="reuse">Reutilizar (la borro yo después)</option>
          </select>
        </label>
        <span class="ipfs-gateway-info" hidden></span>
      </footer>
    </div>
    <div class="scrim"></div>
  `;

  const messagesEl = container.querySelector(".messages") as HTMLElement;
  const textareaEl = container.querySelector(".composer textarea") as HTMLTextAreaElement;
  const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
  const attachBtn = container.querySelector(".attach-btn") as HTMLButtonElement;
  const fileInput = container.querySelector(".file-input") as HTMLInputElement;
  const activityLogEl = container.querySelector(".activity-log") as HTMLElement;
  const modelSelector = container.querySelector(".model-selector") as HTMLSelectElement;
  const scopeSelector = container.querySelector(".scope-selector") as HTMLSelectElement;
  const ocrModeSelector = container.querySelector(".ocr-mode-selector") as HTMLSelectElement;
  const kbSelector = container.querySelector(".kb-selector") as HTMLSelectElement;
  const kbMaxSelector = container.querySelector(".kb-max-selector") as HTMLSelectElement;
  const kbMaxWarning = container.querySelector(".kb-max-warning") as HTMLElement;
  const ipfsModeSelector = container.querySelector(".ipfs-mode-selector") as HTMLSelectElement;
  const ipfsNetworkRow = container.querySelector(".ipfs-network-row") as HTMLElement;
  const ipfsNetworkSelector = container.querySelector(".ipfs-network-selector") as HTMLSelectElement;
  const ipfsRetentionRow = container.querySelector(".ipfs-retention-row") as HTMLElement;
  const ipfsRetentionSelector = container.querySelector(".ipfs-retention-selector") as HTMLSelectElement;
  const ipfsGatewayInfo = container.querySelector(".ipfs-gateway-info") as HTMLElement;
  const provenancePlaceholder = container.querySelector(".provenance-placeholder") as HTMLElement;

  const scrimEl = container.querySelector(".scrim") as HTMLElement;
  const sidebarEl = container.querySelector(".sidebar") as HTMLElement;
  const activityPanelEl = container.querySelector(".activity-panel") as HTMLElement;
  const settingsBarEl = container.querySelector(".settings-bar") as HTMLElement;
  const themeToggleBtn = container.querySelector(".theme-toggle") as HTMLButtonElement;
  const tourTriggerBtn = container.querySelector(".tour-trigger") as HTMLButtonElement;

  initTooltips(container);

  const drawers = createDrawerGroup(scrimEl);
  drawers.register(sidebarEl, container.querySelector('[data-drawer-trigger="sidebar"]') as HTMLElement);
  const activityDrawer = drawers.register(
    activityPanelEl,
    container.querySelector('[data-drawer-trigger="activity"]') as HTMLElement
  );
  const settingsDrawer = drawers.register(
    settingsBarEl,
    container.querySelector('[data-drawer-trigger="settings"]') as HTMLElement
  );

  function updateThemeToggleLabel() {
    themeToggleBtn.dataset.tooltip = `Tema actual: ${themeLabel(getCurrentTheme())} — clic para cambiar`;
    refreshTooltip(themeToggleBtn);
  }
  updateThemeToggleLabel();
  themeToggleBtn.addEventListener("click", () => {
    cycleTheme();
    updateThemeToggleLabel();
  });

  const tourSteps: TourStep[] = [
    {
      selector: ".network-status",
      title: "Bienvenido a FHS Community",
      body: "Este punto indica que estás conectado a la red comunitaria. El chat se resuelve con hardware que comparten otros miembros — no un servicio centralizado.",
    },
    {
      selector: ".model-selector",
      title: "Elige el modelo",
      body: "Aquí ves qué modelos de IA están disponibles ahora mismo en la red. ★ marca los nodos de confianza del operador.",
      beforeShow: () => settingsDrawer.open(),
    },
    {
      selector: ".attach-btn",
      title: "Adjunta documentos",
      body: "Puedes adjuntar una imagen o PDF — el texto se extrae automáticamente (OCR) antes de responder tu pregunta.",
      beforeShow: () => settingsDrawer.close(),
    },
    {
      selector: ".composer textarea",
      title: "Escribe tu mensaje",
      body: "Escribe aquí y presiona Enter (o el botón Enviar) para mandar tu mensaje a la red.",
    },
    {
      selector: '[data-drawer-trigger="activity"]',
      title: "Actividad del agente",
      body: "Aquí ves en tiempo real qué está haciendo el agente: qué modelo eligió, qué herramientas usó y de dónde vino cada dato de la respuesta.",
      beforeShow: () => activityDrawer.close(),
    },
    {
      selector: ".theme-toggle",
      title: "Cambia el tema",
      body: "Alterna entre Claro, Oscuro y Alto contraste según lo que te resulte más cómodo de leer.",
    },
    {
      selector: ".tour-trigger",
      title: "¿Necesitas repasar esto?",
      body: "Vuelve a este botón cuando quieras repetir el tour.",
    },
  ];
  const tour = createTour(tourSteps);
  tourTriggerBtn.addEventListener("click", () => tour.start());
  if (!hasTourRun()) {
    setTimeout(() => tour.start(), 400);
  }

  void loadModels();
  void loadKbs();
  void loadIpfsConfig();

  modelSelector.addEventListener("change", () => {
    state.selectedModel = modelSelector.value;
  });

  scopeSelector.addEventListener("change", () => {
    state.privacyScope = scopeSelector.value as ChatState["privacyScope"];
  });

  ocrModeSelector.addEventListener("change", () => {
    state.ocrMode = ocrModeSelector.value as ChatState["ocrMode"];
  });

  kbSelector.addEventListener("change", () => {
    state.kbProviderId = kbSelector.value;
  });

  // DEC-0027: advertencia obligatoria antes de permitir consultar más de
  // una KB por pregunta — modelos pequeños/sin GPU pueden volverse
  // notablemente más lentos combinando contexto de varias KBs.
  kbMaxSelector.addEventListener("change", () => {
    state.kbMaxPerQuestion = Number(kbMaxSelector.value);
    kbMaxWarning.hidden = state.kbMaxPerQuestion <= 1;
  });

  ipfsModeSelector.addEventListener("change", () => {
    state.ipfsEnabled = ipfsModeSelector.value === "ipfs";
    ipfsNetworkRow.hidden = !state.ipfsEnabled;
    ipfsRetentionRow.hidden = !state.ipfsEnabled;
    ipfsGatewayInfo.hidden = !state.ipfsEnabled;
  });

  ipfsNetworkSelector.addEventListener("change", () => {
    state.ipfsNetwork = ipfsNetworkSelector.value as ChatState["ipfsNetwork"];
  });

  ipfsRetentionSelector.addEventListener("change", () => {
    state.ipfsRetention = ipfsRetentionSelector.value as ChatState["ipfsRetention"];
  });

  textareaEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  });

  sendBtn.addEventListener("click", () => void submitMessage());

  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => void (async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const isPdf = file.type === "application/pdf";
    if (!file.type.startsWith("image/") && !isPdf) {
      addActivityItem("error", `Tipo de archivo no soportado: ${file.type || file.name}`);
      fileInput.value = "";
      return;
    }
    pendingAttachment = await fileToBase64(file);
    pendingAttachmentIsPdf = isPdf;
    pendingAttachmentName = file.name;
    attachBtn.textContent = `${isPdf ? "📄" : "📎"} ${file.name}`;
    attachBtn.classList.add("attached");
  })());

  async function loadModels() {
    try {
      const response = await fetch("/api/fhs/models");
      if (!response.ok) return;
      const data = (await response.json()) as { models?: ModelOption[] };
      for (const m of data.models ?? []) {
        const option = document.createElement("option");
        option.value = m.modelId;
        option.textContent = `${m.trusted ? "★ " : ""}${m.displayName} — ${m.providerName}`;
        modelSelector.appendChild(option);
      }
    } catch (err) {
      console.error("Failed to load models", err);
    }
  }

  async function loadKbs() {
    try {
      const response = await fetch("/api/fhs/providers?type=mcp");
      if (!response.ok) return;
      const providers = (await response.json()) as Array<{
        providerId: string;
        name: string;
        service: { capabilities: Array<{ id: string; description?: string }> };
      }>;
      const kbs: KbOption[] = providers
        .map((p) => {
          const cap = p.service.capabilities.find((c) => c.id === "kb.query");
          return cap ? { providerId: p.providerId, providerName: p.name, description: cap.description || p.name } : null;
        })
        .filter((kb): kb is KbOption => kb !== null);

      for (const kb of kbs) {
        const option = document.createElement("option");
        option.value = kb.providerId;
        option.textContent = `${kb.providerName} — ${kb.description}`;
        kbSelector.appendChild(option);
      }
    } catch (err) {
      console.error("Failed to load KBs", err);
    }
  }

  /**
   * SPEC-IPFS-0001 (DEC-0052, pregunta #6): el usuario debe saber qué
   * gateway público se usará antes de elegir ese transporte, no un detalle
   * oculto. Si Navigator no tiene IPFS configurado, se deshabilita la
   * opción en vez de dejar que el usuario elija algo que va a fallar.
   */
  async function loadIpfsConfig() {
    try {
      const response = await fetch("/api/ipfs-config");
      const data = (await response.json()) as { enabled: boolean; publicGatewayUrl: string };
      if (!data.enabled) {
        const ipfsOption = ipfsModeSelector.querySelector('option[value="ipfs"]') as HTMLOptionElement;
        ipfsOption.disabled = true;
        ipfsOption.textContent = "Vía IPFS (no disponible en este nodo)";
        return;
      }
      ipfsGatewayInfo.textContent = `Gateway público: ${data.publicGatewayUrl}`;
    } catch (err) {
      console.error("Failed to load IPFS config", err);
    }
  }

  function submitMessage() {
    const text = textareaEl.value.trim();
    if ((!text && !pendingAttachment) || state.isStreaming) return;

    const userContent = text || (pendingAttachment ? (pendingAttachmentIsPdf ? "[PDF adjunto]" : "[imagen adjunta]") : "");
    addMessage({
      role: "user",
      content: userContent,
      attachmentName: pendingAttachment ? pendingAttachmentName || undefined : undefined,
      attachmentIsPdf: pendingAttachmentIsPdf,
    });

    const artifacts = pendingAttachment ? [pendingAttachment] : undefined;
    const attachmentName = pendingAttachmentName;
    pendingAttachment = null;
    pendingAttachmentIsPdf = false;
    pendingAttachmentName = null;
    attachBtn.textContent = "📎";
    attachBtn.classList.remove("attached");
    textareaEl.value = "";
    textareaEl.style.height = "auto";
    state.isStreaming = true;
    sendBtn.disabled = true;
    activityLogEl.innerHTML = "";
    hideThinking();

    const sendOptions = {
      conversationId: conversationId || undefined,
      message: text,
      artifacts,
      attachmentName: attachmentName || undefined,
      preferences: {
        model: state.selectedModel,
        scope: state.privacyScope,
        allowExternalProviders: state.privacyScope === "external",
        ocrMode: state.ocrMode,
        kb: state.kbProviderId || undefined,
        kbMaxPerQuestion: state.kbMaxPerQuestion,
        ipfs: state.ipfsEnabled
          ? { enabled: true, network: state.ipfsNetwork, retention: state.ipfsRetention }
          : undefined,
      },
    };

    if (!chatConnection) {
      chatConnection = connectToChat(handleEvent, () => chatConnection?.send(sendOptions));
    } else {
      chatConnection.send(sendOptions);
    }
  }

  function handleEvent(event: AgentEvent) {
    switch (event.type) {
      case "session":
        conversationId = event.data.conversationId;
        break;
      case "agent.status":
        addActivityItem("info", event.data.message);
        showThinking(event.data.message);
        break;
      case "llm.selected":
        addActivityItem("success", `Modelo: ${event.data.modelId} @ ${event.data.providerName}`);
        break;
      case "tool.selected":
        addActivityItem("success", `Tool: ${event.data.capability} @ ${event.data.providerName}`);
        break;
      case "tool.running":
        addActivityItem("warning", `Ejecutando ${event.data.name}...`);
        break;
      case "tool.completed":
        addActivityItem(event.data.success ? "success" : "error", `${event.data.name} (${event.data.duration}ms)`);
        break;
      case "tool.error":
        addActivityItem("error", `${event.data.name}: ${event.data.error}`);
        break;
      case "assistant.delta":
        hideThinking();
        appendAssistantText(event.data.text);
        break;
      case "assistant.completed":
        hideThinking();
        renderProvenance(event.data.provenance);
        state.isStreaming = false;
        sendBtn.disabled = false;
        break;
      case "ocr.extracted":
        hideThinking();
        addOcrExtractedMessage(event.data.filename, event.data.text);
        state.isStreaming = false;
        sendBtn.disabled = false;
        break;
      case "node.lost":
        addActivityItem("error", `Nodo perdido: ${event.data.providerName}`);
        break;
      case "node.online":
        addActivityItem("success", `Nodo disponible: ${event.data.providerName}`);
        break;
      case "kb.recommended":
        hideThinking();
        addKbRecommendedMessage(event.data.conversationId, event.data.candidates, event.data.chosenByLlm);
        state.isStreaming = false;
        sendBtn.disabled = false;
        break;
      case "error":
        hideThinking();
        addActivityItem("error", `[${event.data.code}] ${event.data.message}`);
        state.isStreaming = false;
        sendBtn.disabled = false;
        break;
    }
  }

  function addMessage(message: ChatMessage) {
    state.messages.push(message);
    const div = document.createElement("div");
    div.className = `message ${message.role}`;

    if (message.role === "user" && message.attachmentName) {
      const badge = document.createElement("div");
      badge.className = "message-attachment";
      badge.textContent = `${message.attachmentIsPdf ? "📄" : "📎"} ${message.attachmentName} — cargado`;
      div.appendChild(badge);
    }

    const textEl = document.createElement("div");
    textEl.textContent = message.content;
    div.appendChild(textEl);

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  let thinkingEl: HTMLElement | null = null;

  function showThinking(statusText: string) {
    if (!thinkingEl) {
      thinkingEl = document.createElement("div");
      thinkingEl.className = "message assistant thinking";
      const dots = document.createElement("span");
      dots.className = "thinking-dots";
      dots.innerHTML = "<i></i><i></i><i></i>";
      const label = document.createElement("span");
      label.className = "thinking-label";
      thinkingEl.appendChild(dots);
      thinkingEl.appendChild(label);
      messagesEl.appendChild(thinkingEl);
    }
    const label = thinkingEl.querySelector(".thinking-label");
    if (label) label.textContent = statusText;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideThinking() {
    thinkingEl?.remove();
    thinkingEl = null;
  }

  function addOcrExtractedMessage(filename: string, text: string) {
    const div = document.createElement("div");
    div.className = "message assistant ocr-preview";

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `📄 ${filename} — texto extraído (clic para ver)`;
    details.appendChild(summary);

    const textEl = document.createElement("div");
    textEl.className = "ocr-preview-text";
    textEl.textContent = text;
    details.appendChild(textEl);
    div.appendChild(details);

    const question = document.createElement("p");
    question.className = "ocr-preview-question";
    question.textContent = "¿Uso este documento para responder tu pregunta?";
    div.appendChild(question);

    const actions = document.createElement("div");
    actions.className = "ocr-preview-actions";

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.textContent = "Usar documento";
    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "secondary";
    discardBtn.textContent = "Descartar";

    const decide = (use: boolean) => {
      useBtn.disabled = true;
      discardBtn.disabled = true;
      actions.remove();
      question.textContent = use
        ? "✓ Usando este documento — si aún no habías escrito tu pregunta, escríbela ahora."
        : "Documento descartado.";
      if (conversationId) chatConnection?.sendDecision(conversationId, use);
    };

    useBtn.addEventListener("click", () => decide(true));
    discardBtn.addEventListener("click", () => decide(false));
    actions.appendChild(useBtn);
    actions.appendChild(discardBtn);
    div.appendChild(actions);

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addKbRecommendedMessage(
    convId: string,
    candidates: Array<{ providerId: string; providerName: string; description: string }>,
    chosenByLlm?: boolean
  ) {
    const div = document.createElement("div");
    div.className = "message assistant kb-recommendation";

    const question = document.createElement("p");
    const names = candidates.map((c) => c.providerName).join(", ");
    const intro =
      candidates.length > 1
        ? `📚 Encontré ${candidates.length} bases de conocimiento relevantes: `
        : "📚 Encontré una base de conocimiento relevante: ";
    // textContent (no innerHTML) — providerName/description son autodeclarados
    // por el operador de cada nodo (DEC-0028), no se confía en que vengan
    // sanitizados (mismo cuidado ya aplicado a KbCitation, DEC-0049).
    question.textContent =
      intro +
      names +
      (chosenByLlm ? " (elegida por el modelo, sin coincidencia determinística clara)." : ".") +
      " ¿Las uso para responder?";
    div.appendChild(question);

    const list = document.createElement("ul");
    for (const c of candidates) {
      const item = document.createElement("li");
      item.textContent = `${c.providerName} — ${c.description}`;
      list.appendChild(item);
    }
    div.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "ocr-preview-actions";

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.textContent = candidates.length > 1 ? "Usar estas KBs" : "Usar esta KB";
    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "secondary";
    discardBtn.textContent = "No usar";

    const decide = (use: boolean) => {
      useBtn.disabled = true;
      discardBtn.disabled = true;
      actions.remove();
      question.textContent = use ? `✓ Usando "${names}" para responder.` : "No se usó ninguna KB para esta pregunta.";
      list.remove();
      chatConnection?.sendKbDecision(convId, use);
    };

    useBtn.addEventListener("click", () => decide(true));
    discardBtn.addEventListener("click", () => decide(false));
    actions.appendChild(useBtn);
    actions.appendChild(discardBtn);
    div.appendChild(actions);

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendAssistantText(text: string) {
    const last = state.messages[state.messages.length - 1];
    if (last && last.role === "assistant") {
      last.content += text;
      const existing = messagesEl.querySelector(".message.assistant:last-child");
      if (existing) existing.textContent = last.content;
    } else {
      addMessage({ role: "assistant", content: text });
    }
  }

  function addActivityItem(level: "info" | "success" | "warning" | "error", text: string) {
    const li = document.createElement("li");
    li.className = `activity-item ${level}`;
    li.textContent = text;
    activityLogEl.appendChild(li);
    activityLogEl.scrollTop = activityLogEl.scrollHeight;
  }

  function escapeHtml(value: string): string {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
  }

  function renderCitation(citation: KbCitation): string {
    const pages =
      citation.pageStart != null
        ? ` (p. ${citation.pageStart}${citation.pageEnd != null ? `–${citation.pageEnd}` : ""})`
        : "";
    return `${escapeHtml(citation.documentTitle)}${pages}`;
  }

  function renderProvenance(provenance: ProvenanceInfo) {
    provenancePlaceholder.innerHTML = `
      <dl>
        <dt>Modelo</dt><dd>${escapeHtml(provenance.llm.model)}</dd>
        <dt>Razonamiento</dt><dd>${escapeHtml(provenance.llm.providerName)}</dd>
        ${provenance.tools
          .map(
            (tool) => `
          <dt>Tool</dt><dd>${escapeHtml(tool.capability)} @ ${escapeHtml(tool.providerName)}</dd>
          ${
            tool.citations && tool.citations.length > 0
              ? `<dt>Fuentes</dt><dd>${tool.citations.map(renderCitation).join(", ")}</dd>`
              : ""
          }
        `
          )
          .join("")}
        <dt>Datos</dt><dd>${escapeHtml(provenance.dataExported)}</dd>
        <dt>Ámbito</dt><dd>${escapeHtml(provenance.jurisdiction)}</dd>
      </dl>
    `;
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
}
