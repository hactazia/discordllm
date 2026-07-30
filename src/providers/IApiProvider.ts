export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  /** URLs for vision models */
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

/** Callback for streaming chunks */
export type StreamCallback = (chunk: string) => void;

export interface StreamResult {
  content: string;
  model: string;
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
  /** Non-streaming completion */
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** Streaming completion: calls onChunk for each text delta, onReasoning for thinking */
  completeStream(
    request: CompletionRequest,
    onChunk: StreamCallback,
    onReasoning?: StreamCallback,
  ): Promise<StreamResult>;
}
