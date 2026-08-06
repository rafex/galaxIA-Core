import type { AgentEvent, ChatConversation, ChatMessage, ChatState, KbCitation, ProvenanceInfo, RagMode } from "../types/fhs.js";
import {
  connectToChat,
  type ApiOptions,
  type ChatConnection,
  type ChatConnectionStatus,
  type ChatConnectionStatusInfo,
} from "../services/api.js";
import {
  createChatHistory,
  createConversation,
  formatDayLabel,
  formatDuration,
  formatMessageTime,
  loadChatHistory,
  saveChatHistory,
  upsertConversation,
  type ChatHistory,
} from "../services/chat-history.js";
import { applyTheme, cycleTheme, getCurrentTheme, getInitialTheme, themeLabel } from "../services/theme.js";
import { createDrawerGroup } from "./drawer.js";
import { initTooltips, refreshTooltip } from "./tooltip.js";
import { createTour, hasTourRun, type TourStep } from "./tour.js";
import { COMMON_RAG_SCOPE, LocalRagStore, type LocalRagChunk } from "../services/local-rag/index.js";

interface RetryPayload {
  message: string;
  artifacts?: string[];
  attachmentName?: string;
  documentId?: string;
  documentContext?: {
    filename: string;
    text: string;
  };
}

export function createApp(container: HTMLElement, version: string = "unknown") {
  const state: ChatState = {
    messages: [],
    isStreaming: false,
    selectedModel: "auto",
    privacyScope: "community",
    kbProviderId: "",
    kbMaxPerQuestion: 1,
    ipfsEnabled: false,
    ipfsNetwork: "public",
    ipfsRetention: "ephemeral",
  };

  let conversationId: string | null = null;
  let historyConversationId: string | null = null;
  let chatHistory: ChatHistory = createChatHistory();
  let pendingConversationRagMode: RagMode = "common";
  let responseStartedAt: number | null = null;
  let responseMessageId: string | null = null;
  let pendingMessageId: string | null = null;
  let chatConnection: ChatConnection | null = null;
  let queuedSendOptions: ApiOptions | null = null;
  let responseTimer: number | null = null;
  let pendingAttachment: string | null = null;
  let pendingAttachmentIsPdf = false;
  let pendingAttachmentName: string | null = null;
  const retryPayloads = new Map<string, RetryPayload>();
  let promptHistoryIndex = -1;
  let promptHistoryDraft = "";
  let navigatingPromptHistory = false;
  let temporaryDocumentContext: { filename: string; text: string } | null = null;
  let activeDocumentId: string | undefined;
  const localRag = typeof Worker === "undefined" ? null : new LocalRagStore();

  localRag?.onStatus((status) => {
    if (!state.isStreaming) return;
    const labels = {
      "loading-embedding-model": "Preparando búsqueda local…",
      indexing: "Indexando el documento en este navegador…",
      querying: "Buscando contexto relevante…",
      fallback: "SQLite local no disponible; usando IndexedDB…",
      idle: "",
    } as const;
    const label = labels[status.phase];
    if (label) {
      const message = status.detail ? `${label} ${status.detail}` : label;
      showThinking(message);
      addActivityItem("info", message);
    }
  });

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
          <span class="connection-label">Desconectado</span>
          <span class="version">${version}</span>
          <button class="reconnect-btn" type="button" data-tooltip="Reconectar este chat a la red P2P">↻ Reconectar</button>
        </div>
        <button type="button" class="icon-btn drawer-trigger" data-drawer-trigger="activity"
          aria-label="Actividad del agente" data-tooltip="Ver qué está haciendo el agente y de dónde viene la respuesta">📊</button>
        <button type="button" class="icon-btn drawer-trigger" data-drawer-trigger="settings"
          aria-label="Ajustes" data-tooltip="Modelo, privacidad, adjuntos y transporte">⚙️</button>
        <button type="button" class="icon-btn theme-toggle" aria-label="Cambiar tema" data-tooltip="Cambiar tema de color">🌓</button>
        <button type="button" class="icon-btn tour-trigger" aria-label="Ayuda: repetir el tour guiado" data-tooltip="Repetir el tour guiado">?</button>
      </header>
      <aside class="sidebar drawer-panel" data-drawer="sidebar">
        <div class="sidebar-heading">
          <h2 data-tooltip="Historial de conversaciones en este dispositivo">Conversaciones locales</h2>
          <button type="button" class="new-conversation-btn" data-tooltip="Crear una conversación nueva">＋</button>
        </div>
        <p class="history-local-note">Solo en este navegador</p>
        <ul class="conversation-list"></ul>
        <button type="button" class="clear-history-btn">Borrar historial local</button>
      </aside>
      <div class="conversation-rag-dialog" hidden role="dialog" aria-modal="true" aria-labelledby="conversation-rag-title">
        <div class="conversation-rag-dialog-card">
          <h2 id="conversation-rag-title">Nueva conversación</h2>
          <p>¿Cómo quieres que esta conversación use el contexto de documentos?</p>
          <fieldset>
            <legend>Ámbito del RAG</legend>
            <label class="rag-mode-option">
              <input type="radio" name="new-conversation-rag-mode" value="common" checked />
              <span><strong>RAG común</strong><small>Comparte documentos con otras conversaciones comunes de este navegador.</small></span>
            </label>
            <label class="rag-mode-option">
              <input type="radio" name="new-conversation-rag-mode" value="independent" />
              <span><strong>RAG independiente</strong><small>Mantiene los documentos aislados en esta conversación.</small></span>
            </label>
          </fieldset>
          <p class="rag-mode-note">La elección queda fija para esta conversación. Para cambiarla, crea otra.</p>
          <div class="conversation-rag-dialog-actions">
            <button type="button" class="rag-dialog-cancel">Cancelar</button>
            <button type="button" class="rag-dialog-create">Crear conversación</button>
          </div>
        </div>
      </div>
      <main class="chat-area">
        <div class="messages"></div>
        <div class="composer">
          <input type="file" class="file-input" accept="image/*,application/pdf" hidden />
          <button class="attach-btn" type="button" data-tooltip="Adjuntar una imagen o PDF para extraer texto (OCR)">📎</button>
          <textarea placeholder="Escribe un mensaje... (↑/↓ historial)" rows="1"
            aria-label="Escribe un mensaje; usa las flechas arriba y abajo para recorrer el historial"></textarea>
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
        <label data-tooltip="Base de conocimiento a consultar para responder preguntas sobre un tema">
          Base de conocimiento:
          <select class="kb-selector">
            <option value="" selected>Recomendada automáticamente</option>
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
  const conversationListEl = container.querySelector(".conversation-list") as HTMLElement;
  const newConversationBtn = container.querySelector(".new-conversation-btn") as HTMLButtonElement;
  const ragDialog = container.querySelector(".conversation-rag-dialog") as HTMLDivElement;
  const ragDialogCancel = container.querySelector(".rag-dialog-cancel") as HTMLButtonElement;
  const ragDialogCreate = container.querySelector(".rag-dialog-create") as HTMLButtonElement;
  const clearHistoryBtn = container.querySelector(".clear-history-btn") as HTMLButtonElement;
  const modelSelector = container.querySelector(".model-selector") as HTMLSelectElement;
  const scopeSelector = container.querySelector(".scope-selector") as HTMLSelectElement;
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
  const statusDotEl = container.querySelector(".status-dot") as HTMLElement;
  const connectionLabelEl = container.querySelector(".connection-label") as HTMLElement;
  const reconnectBtn = container.querySelector(".reconnect-btn") as HTMLButtonElement;

  initializeHistory();
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

  configureIpfsSettings();
  updateConnectionStatus("disconnected");

  reconnectBtn.addEventListener("click", () => {
    if (chatConnection) {
      chatConnection.reconnect();
    } else {
      createChatConnection();
    }
  });

  modelSelector.addEventListener("change", () => {
    state.selectedModel = modelSelector.value;
  });

  scopeSelector.addEventListener("change", () => {
    state.privacyScope = scopeSelector.value as ChatState["privacyScope"];
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
    if (event.key === "ArrowUp" && !event.shiftKey && (promptHistoryIndex !== -1 || !textareaEl.value || (textareaEl.selectionStart === 0 && textareaEl.selectionEnd === 0))) {
      if (navigatePromptHistory("up")) event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey && (promptHistoryIndex !== -1 || (textareaEl.selectionStart === textareaEl.value.length && textareaEl.selectionEnd === textareaEl.value.length))) {
      if (navigatePromptHistory("down")) event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  });

  textareaEl.addEventListener("input", () => {
    if (!navigatingPromptHistory) resetPromptHistoryNavigation();
  });

  sendBtn.addEventListener("click", () => void submitMessage());

  newConversationBtn.addEventListener("click", () => {
    if (state.isStreaming) return;
    openNewConversationDialog();
  });

  ragDialogCancel.addEventListener("click", closeNewConversationDialog);
  ragDialogCreate.addEventListener("click", () => {
    const selected = container.querySelector<HTMLInputElement>('input[name="new-conversation-rag-mode"]:checked');
    startNewConversation(selected?.value === "independent" ? "independent" : "common");
    closeNewConversationDialog();
  });
  ragDialog.addEventListener("click", (event) => {
    if (event.target === ragDialog) closeNewConversationDialog();
  });

  clearHistoryBtn.addEventListener("click", () => {
    if (!window.confirm("¿Borrar todas las conversaciones guardadas en este navegador?")) return;
    if (localRag) {
      void localRag.clear().catch(() => {
        addActivityItem("warning", "No se pudo limpiar todo el índice RAG local.");
      });
    }
    chatHistory = createChatHistory();
    saveChatHistory(chatHistory);
    startNewConversation();
  });

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

  function initializeHistory() {
    chatHistory = loadChatHistory();
    const active = chatHistory.conversations[0];
    historyConversationId = active?.id ?? null;
    pendingConversationRagMode = active?.ragMode ?? "common";
    state.messages = active ? [...active.messages] : [];
    renderConversationList();
    renderMessages();
  }

  function openNewConversationDialog() {
    ragDialog.hidden = false;
    const commonOption = container.querySelector<HTMLInputElement>('input[name="new-conversation-rag-mode"][value="common"]');
    const independentOption = container.querySelector<HTMLInputElement>('input[name="new-conversation-rag-mode"][value="independent"]');
    if (pendingConversationRagMode === "independent") {
      if (commonOption) commonOption.checked = false;
      if (independentOption) independentOption.checked = true;
    } else {
      if (commonOption) commonOption.checked = true;
      if (independentOption) independentOption.checked = false;
    }
    (pendingConversationRagMode === "independent" ? independentOption : commonOption)?.focus();
  }

  function closeNewConversationDialog() {
    ragDialog.hidden = true;
  }

  function startNewConversation(ragMode: RagMode = "common") {
    chatConnection?.close();
    chatConnection = null;
    conversationId = null;
    historyConversationId = null;
    pendingConversationRagMode = ragMode;
    responseStartedAt = null;
    responseMessageId = null;
    pendingMessageId = null;
    queuedSendOptions = null;
    temporaryDocumentContext = null;
    activeDocumentId = undefined;
    resetPromptHistoryNavigation();
    state.messages = [];
    state.isStreaming = false;
    hideThinking();
    activityLogEl.innerHTML = "";
    provenancePlaceholder.textContent = "Esperando primera respuesta...";
    renderConversationList();
    renderMessages();
    textareaEl.focus();
  }

  function selectConversation(id: string) {
    if (state.isStreaming) return;
    const selected = chatHistory.conversations.find((conversation) => conversation.id === id);
    if (!selected) return;
    chatConnection?.close();
    chatConnection = null;
    conversationId = null;
    historyConversationId = selected.id;
    pendingConversationRagMode = selected.ragMode;
    responseStartedAt = null;
    responseMessageId = null;
    pendingMessageId = null;
    queuedSendOptions = null;
    temporaryDocumentContext = null;
    activeDocumentId = undefined;
    resetPromptHistoryNavigation();
    state.messages = [...selected.messages];
    activityLogEl.innerHTML = "";
    provenancePlaceholder.textContent = "Esperando primera respuesta...";
    renderConversationList();
    renderMessages();
  }

  function resetPromptHistoryNavigation() {
    promptHistoryIndex = -1;
    promptHistoryDraft = "";
  }

  function promptHistory(): string[] {
    return state.messages
      .filter((message): message is Extract<ChatMessage, { role: "user" }> => message.role === "user")
      .map((message) => message.content)
      .filter((content) => content.length > 0);
  }

  function navigatePromptHistory(direction: "up" | "down"): boolean {
    const prompts = promptHistory();
    if (prompts.length === 0) return false;

    if (direction === "up") {
      if (promptHistoryIndex === -1) promptHistoryDraft = textareaEl.value;
      if (promptHistoryIndex >= prompts.length - 1) return false;
      promptHistoryIndex += 1;
      setTextareaFromPromptHistory(prompts[prompts.length - 1 - promptHistoryIndex] ?? "");
      return true;
    }

    if (promptHistoryIndex === -1) return false;
    if (promptHistoryIndex === 0) {
      promptHistoryIndex = -1;
      setTextareaFromPromptHistory(promptHistoryDraft);
      promptHistoryDraft = "";
      return true;
    }
    promptHistoryIndex -= 1;
    setTextareaFromPromptHistory(prompts[prompts.length - 1 - promptHistoryIndex] ?? "");
    return true;
  }

  function setTextareaFromPromptHistory(value: string) {
    navigatingPromptHistory = true;
    textareaEl.value = value;
    textareaEl.setSelectionRange(value.length, value.length);
    navigatingPromptHistory = false;
  }

  function ensureHistoryConversation(): ChatConversation {
    const active = historyConversationId
      ? chatHistory.conversations.find((conversation) => conversation.id === historyConversationId)
      : undefined;
    if (active) return active;
    const conversation = createConversation(Date.now(), undefined, pendingConversationRagMode);
    historyConversationId = conversation.id;
    chatHistory = upsertConversation(chatHistory, conversation);
    saveChatHistory(chatHistory);
    return conversation;
  }

  function persistActiveConversation() {
    const active = ensureHistoryConversation();
    const updated = { ...active, messages: [...state.messages], updatedAt: Date.now() };
    chatHistory = upsertConversation(chatHistory, updated);
    saveChatHistory(chatHistory);
    renderConversationList();
  }

  function renderConversationList() {
    conversationListEl.innerHTML = "";
    for (const conversation of chatHistory.conversations) {
      const item = document.createElement("li");
      item.className = conversation.id === historyConversationId ? "active" : "";
      item.dataset.conversationId = conversation.id;
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", `Abrir ${conversation.title}`);

      const details = document.createElement("span");
      details.className = "conversation-details";
      const title = document.createElement("span");
      title.className = "conversation-title";
      title.textContent = conversation.title;
      const ragMode = document.createElement("small");
      ragMode.className = "conversation-rag-mode";
      ragMode.textContent = conversation.ragMode === "common" ? "RAG común" : "RAG independiente";
      details.append(title, ragMode);
      const time = document.createElement("time");
      time.className = "conversation-time";
      time.dateTime = new Date(conversation.updatedAt).toISOString();
      time.textContent = formatMessageTime(conversation.updatedAt);
      item.append(details, time);

      item.addEventListener("click", () => selectConversation(conversation.id));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectConversation(conversation.id);
        }
      });
      conversationListEl.appendChild(item);
    }
  }

  function renderMessages() {
    messagesEl.innerHTML = "";
    let previousDay = "";
    for (const message of state.messages) {
      const day = new Date(messageTimestamp(message)).toDateString();
      if (day !== previousDay) {
        const separator = document.createElement("div");
        separator.className = "message-day-separator";
        separator.textContent = formatDayLabel(messageTimestamp(message));
        messagesEl.appendChild(separator);
        previousDay = day;
      }
      messagesEl.appendChild(renderMessageElement(message));
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderMessageElement(message: ChatMessage): HTMLElement {
    const div = document.createElement("div");
    div.className = `message ${message.role}`;
    div.dataset.messageId = message.id;

    if (message.role === "user" && message.attachmentName) {
      const badge = document.createElement("div");
      badge.className = "message-attachment";
      badge.textContent = `${message.attachmentIsPdf ? "📄" : "📎"} ${message.attachmentName} — cargado`;
      div.appendChild(badge);
    }

    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.content;
    div.appendChild(body);

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = formatMessageTime(messageTimestamp(message)) +
      (message.role === "assistant" && message.durationMs != null ? ` · ${formatDuration(message.durationMs)}` : "");
    meta.title = new Date(messageTimestamp(message)).toLocaleString();
    div.appendChild(meta);

    if (message.role === "user" && message.failed) {
      const failure = document.createElement("div");
      failure.className = "message-failure";
      failure.textContent = message.failureMessage || "No se pudo enviar este mensaje.";
      div.appendChild(failure);

      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "retry-btn";
      retryBtn.textContent = "Reintentar";
      const canRetryAttachment = !message.attachmentName || retryPayloads.has(message.id);
      retryBtn.disabled = !canRetryAttachment;
      retryBtn.title = canRetryAttachment
        ? "Enviar de nuevo este mensaje en la misma conversación"
        : "El adjunto ya no está disponible; vuelve a cargarlo";
      retryBtn.addEventListener("click", () => retryMessage(message.id));
      div.appendChild(retryBtn);
    }
    return div;
  }

  function refreshMessageElement(message: ChatMessage) {
    const element = messagesEl.querySelector(`[data-message-id="${message.id}"]`);
    if (!element) return;
    const body = element.querySelector(".message-body");
    if (body) body.textContent = message.content;
    const meta = element.querySelector(".message-meta");
    if (meta) {
      meta.textContent = formatMessageTime(messageTimestamp(message)) +
        (message.role === "assistant" && message.durationMs != null ? ` · ${formatDuration(message.durationMs)}` : "");
    }
  }

  /** La configuración IPFS es local/build-time; no se consulta por HTTP. */
  function configureIpfsSettings() {
    const gateway = import.meta.env.VITE_FHS_IPFS_GATEWAY_URL as string | undefined;
    const ipfsOption = ipfsModeSelector.querySelector('option[value="ipfs"]') as HTMLOptionElement;
    if (!gateway) {
      ipfsOption.disabled = true;
      ipfsOption.textContent = "Vía IPFS (configuración local no disponible)";
      return;
    }
    ipfsGatewayInfo.textContent = `Gateway público: ${gateway}`;
  }

  async function submitMessage() {
    const text = textareaEl.value.trim();
    if ((!text && !pendingAttachment) || state.isStreaming) return;

    const userContent = text || (pendingAttachment ? (pendingAttachmentIsPdf ? "[PDF adjunto]" : "[imagen adjunta]") : "");
    const createdAt = Date.now();
    const messageId = crypto.randomUUID();
    const artifacts = pendingAttachment ? [pendingAttachment] : undefined;
    const attachmentName = pendingAttachmentName;
    const documentId = artifacts ? crypto.randomUUID() : activeDocumentId;
    if (artifacts) {
      temporaryDocumentContext = null;
      activeDocumentId = documentId;
    }
    addMessage({
      id: messageId,
      role: "user",
      content: userContent,
      createdAt,
      attachmentName: attachmentName || undefined,
      attachmentIsPdf: pendingAttachmentIsPdf,
    });
    retryPayloads.set(messageId, {
      message: text,
      artifacts,
      attachmentName: attachmentName || undefined,
      documentId,
      documentContext: artifacts ? undefined : temporaryDocumentContext || undefined,
    });
    pendingAttachment = null;
    pendingAttachmentIsPdf = false;
    pendingAttachmentName = null;
    attachBtn.textContent = "📎";
    attachBtn.classList.remove("attached");
    textareaEl.value = "";
    textareaEl.style.height = "auto";
    resetPromptHistoryNavigation();
    await dispatchMessage(messageId, { message: text, artifacts, attachmentName: attachmentName || undefined, documentId });
  }

  async function dispatchMessage(messageId: string, payload: RetryPayload) {
    const userMessage = state.messages.find((message) => message.id === messageId);
    if (!userMessage || userMessage.role !== "user") return;
    userMessage.failed = false;
    userMessage.failureMessage = undefined;
    refreshMessageElement(userMessage);
    responseStartedAt = Date.now();
    responseMessageId = null;
    pendingMessageId = messageId;
    state.isStreaming = true;
    sendBtn.disabled = true;
    activityLogEl.innerHTML = "";
    showThinking("Conectando con la red FHS…");
    persistActiveConversation();

    const documentContext = await resolveDocumentContext(payload);
    if (!state.isStreaming || pendingMessageId !== messageId) return;
    const sendOptions = {
      conversationId: conversationId || undefined,
      message: payload.message,
      artifacts: payload.artifacts,
      attachmentName: payload.attachmentName,
      documentContext,
      preferences: {
        model: state.selectedModel,
        scope: state.privacyScope,
        allowExternalProviders: state.privacyScope === "external",
        kb: state.kbProviderId || undefined,
        kbMaxPerQuestion: state.kbMaxPerQuestion,
        ipfs: state.ipfsEnabled
          ? { enabled: true, network: state.ipfsNetwork, retention: state.ipfsRetention }
          : undefined,
      },
    };

    if (!chatConnection) {
      queuedSendOptions = sendOptions;
      createChatConnection();
    } else {
      chatConnection.send(sendOptions);
    }
  }

  function createChatConnection() {
    chatConnection = connectToChat(handleEvent, () => {
      if (!queuedSendOptions || !pendingMessageId || !state.isStreaming) return;
      const next = queuedSendOptions;
      queuedSendOptions = null;
      chatConnection?.send(next);
    }, updateConnectionStatus);
  }

  function retryMessage(messageId: string) {
    if (state.isStreaming) return;
    const message = state.messages.find((candidate) => candidate.id === messageId);
    if (!message || message.role !== "user" || !message.failed) return;

    const payload = retryPayloads.get(messageId) ?? (
      message.attachmentName
        ? undefined
        : { message: message.content }
    );
    if (!payload) {
      addActivityItem("error", "El adjunto ya no está disponible para reenviar; vuelve a cargarlo.");
      return;
    }

    const failedIndex = state.messages.findIndex((candidate) => candidate.id === messageId);
    const incompleteAssistantIds = new Set<string>();
    for (const candidate of state.messages.slice(failedIndex + 1)) {
      if (candidate.role === "user") break;
      if (candidate.role === "assistant" && candidate.completedAt == null) incompleteAssistantIds.add(candidate.id);
    }
    if (responseMessageId) incompleteAssistantIds.add(responseMessageId);
    if (incompleteAssistantIds.size > 0) {
      state.messages = state.messages.filter((candidate) => !incompleteAssistantIds.has(candidate.id));
      responseMessageId = null;
      renderMessages();
    }
    retryPayloads.set(messageId, payload);
    void dispatchMessage(messageId, payload);
  }

  async function resolveDocumentContext(payload: RetryPayload): Promise<RetryPayload["documentContext"]> {
    if (!payload.message.trim() || payload.artifacts || !localRag) return payload.documentContext;
    const conversation = ensureHistoryConversation();
    try {
      const chunks = await localRag.query({
        conversationId: conversation.id,
        ragScope: conversationRagScope(conversation),
        documentId: payload.documentId,
        query: payload.message,
        topK: 4,
      });
      if (chunks.length > 0) return toDocumentContext(chunks);
    } catch (error) {
      addActivityItem("warning", `RAG local no disponible; se usará el contexto temporal. ${error instanceof Error ? error.message : String(error)}`);
    }
    return payload.documentContext ?? temporaryDocumentContext ?? undefined;
  }

  function toDocumentContext(chunks: LocalRagChunk[]): { filename: string; text: string } {
    const filename = chunks[0]?.filename || temporaryDocumentContext?.filename || "Documento";
    const text = chunks
      .map((chunk) => `[${chunk.filename} · fragmento ${chunk.chunkIndex + 1}]\n${chunk.text}`)
      .join("\n\n");
    return { filename, text };
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
        completeAssistantResponse(event.data.provenance);
        if (pendingMessageId) retryPayloads.delete(pendingMessageId);
        pendingMessageId = null;
        state.isStreaming = false;
        sendBtn.disabled = false;
        break;
      case "ocr.extracted": {
        hideThinking();
        const text = normalizeOcrText(event.data.text);
        temporaryDocumentContext = { filename: event.data.filename, text };
        const pendingPayload = pendingMessageId ? retryPayloads.get(pendingMessageId) : undefined;
        const documentId = pendingPayload?.documentId ?? activeDocumentId ?? crypto.randomUUID();
        activeDocumentId = documentId;
        addOcrExtractedMessage(event.data.filename, text);
        if (localRag) {
          const conversation = ensureHistoryConversation();
          void localRag.index({ conversationId: conversation.id, ragScope: conversationRagScope(conversation), documentId, filename: event.data.filename, text })
            .then((result) => addActivityItem("success", `RAG local: ${result.chunksIndexed} fragmentos indexados (${result.backend}).`))
            .catch((error: unknown) => addActivityItem("warning", `No se pudo indexar localmente el documento: ${error instanceof Error ? error.message : String(error)}`));
        }
        if (pendingPayload?.message.trim()) {
          state.isStreaming = true;
          sendBtn.disabled = true;
          showThinking("Texto extraído; procesando tu pregunta…");
        } else {
          state.isStreaming = false;
          sendBtn.disabled = false;
          pendingMessageId = null;
          textareaEl.focus();
        }
        break;
      }
      case "node.lost":
        addActivityItem("error", `Nodo perdido: ${event.data.providerName}`);
        break;
      case "node.online":
        addActivityItem("success", `Nodo disponible: ${event.data.providerName}`);
        break;
      case "kb.recommended":
        hideThinking();
        addKbRecommendedMessage(event.data.conversationId, event.data.candidates, event.data.chosenByLlm);
        if (pendingMessageId) retryPayloads.delete(pendingMessageId);
        pendingMessageId = null;
        state.isStreaming = false;
        sendBtn.disabled = false;
        break;
      case "error":
        hideThinking();
        addActivityItem("error", `[${event.data.code}] ${event.data.message}`);
        queuedSendOptions = null;
        markPendingMessageFailed(event.data.message);
        persistActiveConversation();
        responseStartedAt = null;
        pendingMessageId = null;
        state.isStreaming = false;
        sendBtn.disabled = false;
        break;
    }
  }

  function conversationRagScope(conversation: ChatConversation): string {
    return conversation.ragMode === "common" ? COMMON_RAG_SCOPE : conversation.id;
  }

  function addMessage(message: ChatMessage) {
    state.messages.push(message);
    const day = new Date(messageTimestamp(message)).toDateString();
    const previousMessage = state.messages[state.messages.length - 2];
    if (!previousMessage || new Date(messageTimestamp(previousMessage)).toDateString() !== day) {
      const separator = document.createElement("div");
      separator.className = "message-day-separator";
      separator.textContent = formatDayLabel(messageTimestamp(message));
      messagesEl.appendChild(separator);
    }
    messagesEl.appendChild(renderMessageElement(message));
    persistActiveConversation();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function markPendingMessageFailed(message: string) {
    if (!pendingMessageId) return;
    const userMessage = state.messages.find((candidate) => candidate.id === pendingMessageId);
    if (!userMessage || userMessage.role !== "user") return;
    userMessage.failed = true;
    userMessage.failureMessage = message;
    renderMessages();
  }

  let thinkingEl: HTMLElement | null = null;

  function updateConnectionStatus(status: ChatConnectionStatus, info?: ChatConnectionStatusInfo) {
    const labels: Record<ChatConnectionStatus, string> = {
      connecting: info?.retryInMs
        ? `Reintentando en ${formatDuration(info.retryInMs)}…`
        : "Conectando…",
      connected: "Conectado",
      disconnected: "Desconectado",
    };
    statusDotEl.dataset.status = status;
    connectionLabelEl.textContent = labels[status];
    reconnectBtn.hidden = status === "connected";
    reconnectBtn.disabled = status === "connecting";
    reconnectBtn.title = status === "connecting" ? "Conectando con la red P2P…" : "Reconectar este chat a la red P2P";
    if (status === "connecting" && info?.automatic && state.isStreaming) {
      showThinking(`Reconectando con la red FHS… (intento ${info.attempt})`);
    }
  }

  function startResponseTimer() {
    if (responseTimer != null) window.clearInterval(responseTimer);
    const tick = () => {
      if (!thinkingEl || responseStartedAt == null) return;
      const timer = thinkingEl.querySelector(".thinking-timer");
      if (timer) timer.textContent = formatDuration(Date.now() - responseStartedAt);
    };
    tick();
    responseTimer = window.setInterval(tick, 100);
  }

  function stopResponseTimer() {
    if (responseTimer != null) {
      window.clearInterval(responseTimer);
      responseTimer = null;
    }
  }

  function showThinking(statusText: string) {
    if (!thinkingEl) {
      thinkingEl = document.createElement("div");
      thinkingEl.className = "message assistant thinking";
      const dots = document.createElement("span");
      dots.className = "thinking-dots";
      dots.innerHTML = "<i></i><i></i><i></i>";
      const label = document.createElement("span");
      label.className = "thinking-label";
      const timer = document.createElement("span");
      timer.className = "thinking-timer";
      timer.setAttribute("aria-label", "Tiempo transcurrido");
      thinkingEl.appendChild(dots);
      thinkingEl.appendChild(label);
      thinkingEl.appendChild(timer);
      messagesEl.appendChild(thinkingEl);
    }
    const label = thinkingEl.querySelector(".thinking-label");
    if (label) label.textContent = statusText;
    startResponseTimer();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideThinking() {
    stopResponseTimer();
    thinkingEl?.remove();
    thinkingEl = null;
  }

  function normalizeOcrText(rawText: string): string {
    const raw = rawText.trim();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "result" in parsed) {
        const result = (parsed as { result?: unknown }).result;
        return typeof result === "string"
          ? result.trim()
          : result == null
            ? ""
            : JSON.stringify(result);
      }
    } catch {
      // El proveedor puede devolver texto OCR plano; se conserva sin modificar.
    }
    return raw;
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

    const status = document.createElement("p");
    status.className = "ocr-preview-status";
    status.textContent = "Texto extraído y disponible para las preguntas de este chat.";
    div.appendChild(status);

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
    const assistant = responseMessageId
      ? state.messages.find((message) => message.id === responseMessageId)
      : undefined;
    if (assistant?.role === "assistant") {
      assistant.content += text;
      refreshMessageElement(assistant);
    } else {
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: text,
        createdAt: Date.now(),
      };
      responseMessageId = assistantMessage.id;
      addMessage(assistantMessage);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function completeAssistantResponse(provenance: ProvenanceInfo) {
    const assistant = responseMessageId
      ? state.messages.find((message) => message.id === responseMessageId)
      : [...state.messages].reverse().find((message) => message.role === "assistant");
    const completedAt = Date.now();
    if (assistant?.role === "assistant") {
      assistant.provenance = provenance;
      assistant.completedAt = completedAt;
      assistant.durationMs = responseStartedAt == null ? undefined : Math.max(0, completedAt - responseStartedAt);
      refreshMessageElement(assistant);
    }
    persistActiveConversation();
    responseStartedAt = null;
    responseMessageId = null;
  }

  function messageTimestamp(message: ChatMessage): number {
    return message.role === "assistant" && message.completedAt != null ? message.completedAt : message.createdAt;
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
