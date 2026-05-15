import { Command } from "commander";
import fs from "node:fs";
import {
  writeCrewSentinel,
  type CrewSentinel,
  type CrewSignalState,
} from "../lib/crew-sentinel.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function stateForEvent(event: string): CrewSignalState | null {
  if (event === "Stop" || event === "SubagentStop") return "done";
  if (event === "Notification") return "blocked";
  return null;
}

function excerptFromTranscript(transcriptPath: unknown): string {
  if (typeof transcriptPath !== "string" || !transcriptPath) return "";
  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8").trim();
    const lines = raw.split("\n").filter((l) => l.trim().startsWith("{"));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const msg = obj?.message?.content ?? obj?.content ?? obj?.text;
        if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 280);
        if (Array.isArray(msg)) {
          const t = msg
            .map((p: { text?: unknown }) => (typeof p?.text === "string" ? p.text : ""))
            .join(" ")
            .trim();
          if (t) return t.slice(0, 280);
        }
      } catch {
        // try previous line
      }
    }
  } catch {
    // no/unreadable transcript
  }
  return "";
}

export interface CrewSignalInput {
  project?: string;
  crew?: string;
  stateDir?: string;
  stdin: string;
  now?: () => string;
}

/** Pure, testable core. Returns the sentinel written, or null on no-op. */
export function handleCrewSignal(i: CrewSignalInput): CrewSentinel | null {
  // No-op for any session that is not a cockpit-spawned crew.
  if (!i.project || !i.crew || !i.stateDir) return null;

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(i.stdin || "{}");
  } catch {
    return null;
  }
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const state = stateForEvent(event);
  if (!state) return null;

  const sentinel: CrewSentinel = {
    project: i.project,
    crew: i.crew,
    state,
    event,
    sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
    ts: (i.now ?? (() => new Date().toISOString()))(),
    excerpt: excerptFromTranscript(payload.transcript_path),
  };
  writeCrewSentinel(i.stateDir, sentinel);
  return sentinel;
}

export const crewSignalCommand = new Command("crew-signal")
  .description("Internal: Claude hook entrypoint; records crew done/blocked sentinels")
  .action(async () => {
    // Hooks must never fail the agent — swallow everything.
    try {
      handleCrewSignal({
        project: process.env.COCKPIT_PROJECT,
        crew: process.env.COCKPIT_CREW,
        stateDir: process.env.COCKPIT_STATE_DIR,
        stdin: await readStdin(),
      });
    } catch {
      // intentional no-op
    }
  });
