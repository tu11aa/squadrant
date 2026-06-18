import type { NotifierDriver } from "../../types.js";

export function createMemoryNotifier(): NotifierDriver & {
  messages: string[];
} {
  const messages: string[] = [];
  return {
    name: "memory",
    messages,
    async probe() {
      return { installed: true, reachable: true };
    },
    async notify(message: string) {
      messages.push(message);
    },
  };
}
