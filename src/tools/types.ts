/** Minimal registrar used to collect Grok/Cursor shim tools. */

export type ToolExecuteContext = { cwd: string };

export type ToolExecuteResult = {
  content: { type: string; text: string }[];
  details?: Record<string, unknown>;
};

export type ShimRegisteredTool = {
  name: string;
  description: string;
  label?: string;
  prepareArguments?: (params: Record<string, unknown>) => Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ToolExecuteContext,
  ) => Promise<ToolExecuteResult>;
  renderCall?: (...args: unknown[]) => { render: (width: number) => string[] };
  renderResult?: (...args: unknown[]) => { render: (width: number) => string[] };
};

export type ToolRegistrar = {
  registerTool: (tool: ShimRegisteredTool) => void;
  on?: (event: string, handler: unknown) => void;
};
