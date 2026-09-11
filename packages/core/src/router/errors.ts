// packages/core/src/router/errors.ts
export interface AnthropicErrorBody {
  type: "error";
  error: { type: string; message: string };
}

/** Build a status + Anthropic-shaped error envelope so Claude Code renders it natively. */
export function anthropicError(
  status: number,
  type: string,
  message: string,
): { status: number; body: AnthropicErrorBody } {
  return { status, body: { type: "error", error: { type, message } } };
}
