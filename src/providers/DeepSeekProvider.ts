import { IApiProvider, CompletionRequest, CompletionResponse, ModelInfo, StreamCallback, StreamResult } from "./IApiProvider.js";

const MODELS: ModelInfo[] = [
  { id: "deepseek-chat", name: "DeepSeek V3" },
  { id: "deepseek-reasoner", name: "DeepSeek R1" },
];

export class DeepSeekProvider implements IApiProvider {
  readonly name = "DeepSeek";
  readonly defaultModel = "deepseek-chat";

  constructor(private apiKey: string) {}

  async listModels(): Promise<ModelInfo[]> {
    return MODELS;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: false,
      }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`DeepSeek error: ${res.statusText}`);
    const data = (await res.json()) as {
      choices: { message: { content: string; reasoning_content?: string } }[];
      model: string;
    };
    return {
      content: data.choices[0].message.content,
      reasoning: data.choices[0].message.reasoning_content,
      model: data.model || request.model,
    };
  }

  async completeStream(
    request: CompletionRequest,
    onChunk: StreamCallback,
    onReasoning?: StreamCallback,
  ): Promise<StreamResult> {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: true,
      }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`DeepSeek error: ${res.statusText}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    let fullReasoning = "";
    let model = request.model;
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") break;

        try {
          const parsed = JSON.parse(data) as {
            choices?: { delta?: { content?: string; reasoning_content?: string } }[];
            model?: string;
          };
          if (parsed.model) model = parsed.model;
          for (const choice of parsed.choices ?? []) {
            if (choice.delta?.reasoning_content) {
              fullReasoning += choice.delta.reasoning_content;
              onReasoning?.(choice.delta.reasoning_content);
            }
            if (choice.delta?.content) {
              fullContent += choice.delta.content;
              onChunk(choice.delta.content);
            }
          }
          // Tiny delay to let Discord ratelimit breathe
          await new Promise((r) => setTimeout(r, 50));
        } catch {
          // skip unparseable lines
        }
      }
    }

    return { content: fullContent, model, reasoning: fullReasoning || undefined };
  }
}
