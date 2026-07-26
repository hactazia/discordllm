import { IApiProvider, CompletionRequest, CompletionResponse, ModelInfo } from "./IApiProvider.js";

export class OpenAIProvider implements IApiProvider {
  readonly name = "ChatGPT";
  readonly defaultModel = "gpt-4o";

  constructor(private apiKey: string) {}

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI list models failed: ${res.statusText}`);
    const data = (await res.json()) as { data: { id: string }[] };
    return data.data
      .filter((m) => m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3"))
      .map((m) => ({ id: m.id, name: m.id }));
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
    if (!res.ok) throw new Error(`OpenAI error: ${res.statusText}`);
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
      model: string;
    };
    return {
      content: data.choices[0].message.content,
      model: data.model || request.model,
    };
  }
}
