export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  /** Base64-encoded images or URLs for vision models */
  images?: string[];
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  signal?: AbortSignal;
}

export interface CompletionResponse {
  content: string;
  model: string;
  /** Thinking/reasoning chain-of-thought from the model, if supported */
  reasoning?: string;
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
