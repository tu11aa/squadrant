// #592: deliberately answer a crew's own open AskUserQuestion/permission
// SELECTION MODAL. `crew send` correctly refuses to touch a pane while a
// modal is open (#484/#516) — a bare keystroke would confirm whatever option
// happens to be highlighted. This is the escape hatch: it reads the rendered
// option list back, requires an EXPLICIT index or text match (never an
// implicit default), and only then drives the selection.

import type { RuntimeDriver, PaneRef, ModalOption } from "@squadrant/shared";
import { findCrewPane } from "./crew-spawn.js";

export interface CrewAnswerDeps {
  /** Read the crew pane's screen and parse its open modal (null = none visible). */
  readModalOptions(pane: PaneRef): Promise<ModalOption[] | null>;
  log?(msg: string): void;
}

export interface CrewAnswerOpts {
  /** Refuse unless the resolved option's label contains this text (case-insensitive). */
  expect?: string;
  /** Free-text answer: typed into the box after selecting the option (e.g. "Type something."). */
  text?: string;
}

export interface CrewAnswerResult {
  selected: ModalOption;
  /** Whether the modal was confirmed gone on a re-read after driving the selection. */
  closed: boolean;
}

function describeOptions(options: ModalOption[]): string {
  return options.map((o) => `  ${o.highlighted ? "❯" : " "} ${o.index}. ${o.label}`).join("\n");
}

function resolveOption(options: ModalOption[], selector: string): ModalOption {
  const trimmed = selector.trim();
  if (/^\d+$/.test(trimmed)) {
    const byIndex = options.find((o) => o.index === Number(trimmed));
    if (!byIndex) {
      throw new Error(`No option ${trimmed} in the visible prompt. Visible options:\n${describeOptions(options)}`);
    }
    return byIndex;
  }
  const lower = trimmed.toLowerCase();
  const exact = options.filter((o) => o.label.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Option text "${selector}" matches multiple options ambiguously:\n${describeOptions(exact)}`);
  }
  const prefix = options.filter((o) => o.label.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new Error(`Option text "${selector}" matches multiple options ambiguously:\n${describeOptions(prefix)}`);
  }
  throw new Error(`No option matches "${selector}". Visible options:\n${describeOptions(options)}`);
}

export async function runCrewAnswer(
  project: string,
  name: string,
  option: string,
  runtime: RuntimeDriver,
  workspaceId: string,
  deps: CrewAnswerDeps,
  opts?: CrewAnswerOpts,
): Promise<CrewAnswerResult> {
  const crew = await findCrewPane(runtime, workspaceId, project, name);
  if (!crew) {
    throw new Error(`Crew '${name}' not found for ${project}. Run 'squadrant crew list ${project}'.`);
  }

  const options = await deps.readModalOptions(crew);
  if (!options) {
    throw new Error(
      `Crew '${name}' has no interactive option prompt visible right now — nothing to answer. ` +
        `Read its screen with 'squadrant crew read ${project} ${name}' to check its state.`,
    );
  }

  const target = resolveOption(options, option);
  if (opts?.expect && !target.label.toLowerCase().includes(opts.expect.toLowerCase())) {
    throw new Error(
      `Refusing: option ${target.index} is "${target.label}", which does not contain expected text "${opts.expect}". ` +
        `Option order is model-generated and can shift between renders — re-check with 'squadrant crew read ${project} ${name}'.\n` +
        `Visible options:\n${describeOptions(options)}`,
    );
  }

  const log = deps.log ?? (() => {});
  log(`→ selecting ${target.index}. "${target.label}"`);

  // Drive from wherever ❯ currently sits, not from row 1 — the highlighted
  // default is whatever the model rendered, not necessarily option 1.
  const current = options.find((o) => o.highlighted) ?? options[0];
  const steps = target.index - current.index;
  const key = steps >= 0 ? "Down" : "Up";
  for (let i = 0; i < Math.abs(steps); i++) {
    await runtime.sendKeyToPane(crew, key);
  }
  await runtime.sendKeyToPane(crew, "Enter");

  if (opts?.text) {
    await runtime.pasteToPane(crew, opts.text);
    await runtime.sendKeyToPane(crew, "Enter");
  }

  const after = await deps.readModalOptions(crew);
  return { selected: target, closed: after === null };
}
