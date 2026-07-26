import { IApiProvider, type Message } from "../providers/IApiProvider.js";
import {
  Client,
  Message as DiscordMessage,
  DMChannel,
  TextBasedChannel,
  Collection,
} from "discord.js";

export class BotHandler {
  private abortControllers = new Map<string, AbortController>();

  constructor(
    private client: Client,
    private provider: IApiProvider,
    private model: string,
    private systemPrompt: string
  ) {}

  getProvider(): IApiProvider {
    return this.provider;
  }

  getModel(): string {
    return this.model;
  }

  setProvider(provider: IApiProvider): void {
    this.provider = provider;
  }

  setModel(model: string): void {
    this.model = model;
  }

  private discordToApiMessage(msg: DiscordMessage): Message {
    let content = msg.content || "";
    if (msg.embeds.length > 0) {
      for (const embed of msg.embeds) {
        if (embed.description) content += "\n" + embed.description;
        if (embed.title) content = embed.title + "\n" + content;
      }
    }
    const role: Message["role"] = msg.author.id === this.client.user?.id ? "assistant" : "user";
    // Strip leading "!" from user messages (used as new-conversation marker)
    if (role === "user") {
      content = content.trimStart();
      if (content.startsWith("!")) {
        content = content.slice(1).trimStart();
      }
    }

    // Collect image attachments as base64 URLs
    const images: string[] = [];
    if (msg.attachments.size > 0) {
      for (const [, att] of msg.attachments) {
        if (att.contentType?.startsWith("image/")) {
          images.push(att.url);
        }
        if (!content) {
          content = `[Attachment: ${att.name || att.url}]`;
        }
      }
    }

    return { role, content: content || "(empty)", images: images.length > 0 ? images : undefined };
  }

  /// Build full conversation history from a DM channel.
  /// Stops when hitting the beginning of the channel or a user message starting with "!".
  private async buildHistory(channel: TextBasedChannel): Promise<Message[]> {
    const rawMessages: DiscordMessage[] = [];
    let lastId: string | undefined;
    let stop = false;

    // Fetch all messages from newest to oldest, stop at "!" barrier
    while (!stop) {
      const batch: Collection<string, DiscordMessage> = await channel.messages.fetch({
        limit: 100,
        ...(lastId ? { before: lastId } : {}),
      });
      if (batch.size === 0) break;

      const sorted = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      for (const msg of sorted) {
        // Stop if this is a user message starting with "!" — it starts a new conversation
        if (
          msg.author.id !== this.client.user?.id &&
          msg.content.trimStart().startsWith("!")
        ) {
          stop = true;
          break;
        }
        rawMessages.push(msg);
        lastId = msg.id;
      }
      if (batch.size < 100) break;
    }

    // Reverse to chronological order before converting
    rawMessages.reverse();
    return rawMessages.map((m) => this.discordToApiMessage(m));
  }

  /// Handle a DM message: build history, respond directly in the DM.
  /// Caller should have already called channel.sendTyping() before this for instant feedback.
  async handleDM(message: DiscordMessage): Promise<void> {
    if (message.author.bot) return;
    const channel = message.channel as DMChannel;
    const channelId = channel.id;

    // Cancel any previous ongoing request in this DM
    this.cancelRequest(channelId);

    // Build dynamic context with user info
    const now = new Date();
    const userTag = message.author.tag;
    const userId = message.author.id;
    const displayName = message.author.displayName;
    const username = message.author.username;
    const isBot = message.author.bot;
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;

    const contextPrompt = [
      this.systemPrompt,
      "",
      "--- Current context ---",
      `Date: ${now.toISOString()}`,
      `Day: ${now.toLocaleDateString(locale, { weekday: "long" })}`,
      `Time: ${now.toLocaleTimeString(locale)}`,
      `User tag: ${userTag}`,
      `Username: ${username}`,
      `Display name: ${displayName}`,
      `User ID: ${userId}`,
      `Is bot: ${isBot}`,
      `Locale: ${locale}`,
    ].join("\n");

    // Build history
    const history: Message[] = [];
    history.push({ role: "system", content: contextPrompt });
    const dmHistory = await this.buildHistory(channel);
    history.push(...dmHistory);

    // Debug: log what's sent to the LLM
    console.log(`[LLM] Sending ${history.length} messages to ${this.provider.name}/${this.model}:`);
    for (const m of history) {
      console.log(`  [${m.role}] ${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}`);
    }

    const controller = new AbortController();
    this.abortControllers.set(channelId, controller);

    try {
      const response = await this.provider.complete({
        model: this.model,
        messages: history,
        signal: controller.signal,
      });

      // If the model provided reasoning/thinking, show it in a spoiler
      if (response.reasoning && response.reasoning.trim()) {
        const thinkingChunks = this.splitMessage(
          `🧠 **Thinking:**\n||${response.reasoning.slice(0, 1800)}||`
        );
        for (const chunk of thinkingChunks) {
          await channel.send(chunk);
        }
      }

      const chunks = this.splitMessage(response.content);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    } catch (err: unknown) {
      const error = err as Error & { name?: string };
      if (error.name === "AbortError") return;
      await channel.send(`❌ **Error:** ${error.message}`).catch(() => {});
    } finally {
      this.abortControllers.delete(channelId);
    }
  }

  /// Handle edited message in DM: delete subsequent bot messages, re-respond.
  async handleMessageEdit(oldMessage: DiscordMessage, newMessage: DiscordMessage): Promise<void> {
    if (newMessage.author?.bot) return;
    const channel = newMessage.channel as DMChannel;
    const channelId = channel.id;

    // Cancel any ongoing request
    this.cancelRequest(channelId);

    // Delete all messages after the edited message
    const allMessages = await channel.messages.fetch({ limit: 100 });
    const sorted = [...allMessages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const editedIndex = sorted.findIndex((m) => m.id === newMessage.id);

    if (editedIndex >= 0) {
      for (let i = sorted.length - 1; i > editedIndex; i--) {
        try {
          await sorted[i]!.delete();
        } catch {
          // ignore
        }
      }
    }

    // Re-generate response (builds history from remaining messages)
    await this.handleDM(newMessage);
  }

  cancelRequest(channelId: string): void {
    const controller = this.abortControllers.get(channelId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(channelId);
    }
  }

  private splitMessage(content: string, maxLen = 2000): string[] {
    const chunks: string[] = [];
    let remaining = content;
    while (remaining.length > maxLen) {
      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }
}
