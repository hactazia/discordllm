export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  signal?: AbortSignal;
}

export interface CompletionResponse {
  content: string;
  model: string;
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface IApiProvider {
  readonly name: string;
  readonly defaultModel: string;
  listModels(): Promise<ModelInfo[]>;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
