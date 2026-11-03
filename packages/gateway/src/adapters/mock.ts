import type { ChatChunk, ChatInput, ChatProvider } from "@glc/shared";

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancelled);
      resolve();
    }, ms);
    function cancelled() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", cancelled, { once: true });
  });

export class MockChatProvider implements ChatProvider {
  readonly id = "mock";
  readonly capabilities = [{ id: "chat" as const, label: "Talk to John", risk: "safe" as const }];

  async health() { return "ready" as const; }

  async *chat(input: ChatInput, signal: AbortSignal): AsyncIterable<ChatChunk> {
    const question = input.messages.at(-1)?.content ?? "";
    if (question.toLowerCase().includes("/fail")) {
      throw Object.assign(new Error("This is a simulated rate-limit error."), { code: "rate_limited" });
    }
    const answer = [
      "Lantern John Stewart reporting in.",
      "This is the offline training simulator, so no real AI service was contacted.",
      `Your mission briefing: "${question.slice(0, 180)}"`,
      "Our headquarters interface is working! In a later phase we can connect a real AI provider here."
    ].join("\n\n");
    let emitted = 0;
    for (const part of answer.match(/\S+\s*/g) ?? []) {
      await delay(55, signal);
      if (signal.aborted) throw signal.reason;
      if (emitted++ >= input.maxOutputTokens) break;
      yield { type: "delta", text: part };
    }
    yield { type: "done", usage: { inputTokens: question.split(/\s+/).length, outputTokens: emitted } };
  }
}
