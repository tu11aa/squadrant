export type ToolEntry = { min?: string; lastVerified?: string };

export const compatManifest = {
  tools: {
    cmux:     { min: "0.64.0",  lastVerified: "0.64.16" } satisfies ToolEntry,
    claude:   { min: "2.1.32" }                           satisfies ToolEntry,
    node:     { min: "18.0.0",  lastVerified: "24.6.0"  } satisfies ToolEntry,
    // presence-checked; no floor enforced yet
    codex:    { lastVerified: "0.139.0" }                 satisfies ToolEntry,
    gemini:   { lastVerified: "0.38.2"  }                 satisfies ToolEntry,
    opencode: { lastVerified: "1.17.4"  }                 satisfies ToolEntry,
  },
} as const;
