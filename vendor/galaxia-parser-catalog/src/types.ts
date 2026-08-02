export interface ParserProfile {
  id: string;
  modelPattern: string;
  strategy: string;
  rule: Record<string, unknown>;
  notes?: string;
  sourceIncident?: string;
}

export interface RequestedTool {
  function: { name: string };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
