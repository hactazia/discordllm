import { IApiProvider, CompletionRequest, CompletionResponse, ModelInfo } from "./IApiProvider.js";

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
}
