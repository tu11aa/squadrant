export { createCursorEmitter } from "./cursor.js";
export { createCodexEmitter } from "./codex.js";
export { createGeminiEmitter } from "./gemini.js";
export { createOpencodeEmitter } from "./opencode.js";
export { ProjectionRegistry } from "./registry.js";
export { mergeWithMarkers, MARKER_START, MARKER_END } from "./marker.js";
export type {
  ProjectionSource,
  ProjectionDestination,
  ProjectionEmitter,
  ProjectionEmitResult,
  ProjectionEmitterFactory,
} from "@cockpit/shared";
