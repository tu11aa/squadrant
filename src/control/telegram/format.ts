// src/control/telegram/format.ts

/** Forum-topic title for a crew session. */
export function crewTopicName(crewName: string): string {
  return `🔧 ${crewName}`;
}

/** Captain-facing rendering of an inbound Telegram reply. */
export function inboundCaptainMessage(crewName: string | undefined, text: string): string {
  return crewName ? `📩 [from Telegram · ${crewName}] ${text}` : `📩 [from Telegram] ${text}`;
}
