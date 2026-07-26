import { IApiProvider, CompletionRequest, CompletionResponse, ModelInfo } from "./IApiProvider.js";

const MODELS: ModelInfo[] = [
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
];

export class AnthropicProvider implements IApiProvider {
  readonly name = "Claude";
  readonly defaultModel = "claude-sonnet-4-20250514";

  constructor(private apiKey: string) {}

  async listModels(): Promise<ModelInfo[]> {
    return MODELS;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const systemMessage = request.messages.find((m) => m.role === "system");
    const chatMessages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: 4096,
      messages: chatMessages,
    };
    if (systemMessage) {
      body.system = systemMessage.content;
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic error: ${res.status} ${err}`);
    }
    const data = (await res.json()) as {
      content: { type: string; text: string }[];
      model: string;
    };
    const text = data.content.find((c) => c.type === "text")?.text ?? "";
    return { content: text, model: data.model || request.model };
  }
}
