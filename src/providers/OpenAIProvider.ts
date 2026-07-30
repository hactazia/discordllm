import { IApiProvider, CompletionRequest, CompletionResponse, ModelInfo, StreamCallback, StreamResult } from "./IApiProvider.js";

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

  async completeStream(
    request: CompletionRequest,
    onChunk: StreamCallback,
  ): Promise<StreamResult> {
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
        stream: true,
      }),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`OpenAI error: ${res.statusText}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
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
            choices?: { delta?: { content?: string } }[];
            model?: string;
          };
          if (parsed.model) model = parsed.model;
          if (parsed.choices?.[0]?.delta?.content) {
            fullContent += parsed.choices[0].delta.content;
            onChunk(parsed.choices[0].delta.content);
          }
          await new Promise((r) => setTimeout(r, 50));
        } catch {
          // skip
        }
      }
    }

    return { content: fullContent, model };
  }
}
