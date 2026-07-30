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

  private async discordToApiMessage(msg: DiscordMessage): Promise<Message> {
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

    // Collect image attachments and text files for context
    const images: string[] = [];
    const textContents: string[] = [];
    if (msg.attachments.size > 0) {
      for (const [, att] of msg.attachments) {
        if (att.contentType?.startsWith("image/")) {
          images.push(att.url);
          if (!content) content = `[Image: ${att.name || "image"}]`;
        } else if (this.isTextAttachment(att)) {
          // Always note the attachment, then try to fetch content
          let fetched = false;
          try {
            const res = await fetch(att.url, {
              headers: {
                "User-Agent": "DiscordBot (https://discord.com, 14)",
              },
            });
            if (res.ok) {
              const text = await res.text();
              textContents.push(
                `[File: ${att.name}]\n\`\`\`\n${text.slice(0, 4000)}\n\`\`\``
              );
              fetched = true;
            } else {
              console.log(`[ATTACH] Failed to fetch ${att.name}: HTTP ${res.status}`);
            }
          } catch (err) {
            console.log(`[ATTACH] Error fetching ${att.name}:`, err);
          }
          if (!fetched) {
            textContents.push(`[File attached: ${att.name} — could not fetch content]`);
          }
          if (!content) content = `[Attached file: ${att.name}]`;
        } else {
          // Unknown attachment type
          if (!content) content = `[Attachment: ${att.name || att.url}]`;
        }
      }
    }

    // Append text file contents to the message content
    if (textContents.length > 0) {
      content = content + "\n\n" + textContents.join("\n\n");
    }

    return { role, content: content || "(empty)", images: images.length > 0 ? images : undefined };
  }

  /// Check if an attachment is a readable text file
  private isTextAttachment(att: { contentType?: string | null; name: string }): boolean {
    const textTypes = [
      "text/", "application/json", "application/xml", "application/javascript",
      "application/typescript", "application/x-sh", "application/x-python",
      "application/x-yaml", "application/x-toml",
    ];
    const textExts = [
      ".txt", ".md", ".json", ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg",
      ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".rs", ".go", ".java", ".kt",
      ".c", ".cpp", ".h", ".hpp", ".cs", ".sh", ".bash", ".zsh", ".fish",
      ".css", ".scss", ".less", ".html", ".htm", ".vue", ".svelte",
      ".sql", ".graphql", ".env", ".gitignore", ".dockerfile", "dockerfile",
      ".log", ".csv", ".tsv", ".diff", ".patch",
    ];

    if (att.contentType) {
      for (const t of textTypes) {
        if (att.contentType.startsWith(t)) return true;
      }
    }
    const lower = att.name.toLowerCase();
    for (const ext of textExts) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
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
    return Promise.all(rawMessages.map((m) => this.discordToApiMessage(m)));
  }

  /// Close unclosed code blocks/inline code for safe streaming display in Discord
  private sanitizeForStreaming(text: string): string {
    // Count backtick triples (```) — if odd, append closing ```
    const tripleCount = (text.match(/```/g) || []).length;
    if (tripleCount % 2 !== 0) {
      return text + "\n```";
    }

    // Count inline backticks (single `, but not part of ```)
    // Remove all triple backticks, then count singles
    const withoutTriples = text.replace(/```/g, "");
    const singleCount = (withoutTriples.match(/`/g) || []).length;
    if (singleCount % 2 !== 0) {
      return text + "`";
    }

    return text;
  }

  /// Handle a DM message: build history, respond directly in the DM.
  /// Uses streaming + message editing for a typewriter effect.
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

    console.log(`[LLM] Sending ${history.length} messages to ${this.provider.name}/${this.model}:`);
    for (const m of history) {
      console.log(`  [${m.role}] ${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}`);
    }

    const controller = new AbortController();
    this.abortControllers.set(channelId, controller);

    // Send initial "thinking" placeholder message
    const statusMsg = await channel.send("💭 *Réflexion...*");

    try {
      let fullContent = "";
      let fullReasoning = "";
      let currentMsg = statusMsg;
      // Discord edit rate limit: 5 edits per 5 seconds per channel. Use 1.2s to be safe.
      const EDIT_INTERVAL = 1200;
      let lastEdit = 0;
      let editQueue = Promise.resolve();

      const editMessage = async (content: string): Promise<void> => {
        editQueue = editQueue.then(async () => {
          const sanitized = this.sanitizeForStreaming(content);
          const prefix = fullReasoning ? "🧠 *Réflexion terminée*\n" : "";
          const display = prefix + (sanitized || "...");

          // Wait for rate limit window
          const elapsed = Date.now() - lastEdit;
          if (elapsed < EDIT_INTERVAL && lastEdit > 0) {
            await new Promise((r) => setTimeout(r, EDIT_INTERVAL - elapsed));
          }

          try {
            if (currentMsg === statusMsg) {
              // First content: send a new message (don't edit the placeholder)
              currentMsg = await channel.send(display);
            } else {
              currentMsg = await currentMsg.edit(display);
            }
            lastEdit = Date.now();
          } catch (err: unknown) {
            const e = err as { status?: number; code?: number; retryAfter?: number };
            // Rate limited — wait and retry once
            if (e.status === 429 || e.code === 429) {
              const wait = (e.retryAfter ?? 2) * 1000;
              await new Promise((r) => setTimeout(r, wait));
              try {
                if (currentMsg === statusMsg) {
                  currentMsg = await channel.send(display);
                } else {
                  currentMsg = await currentMsg.edit(display);
                }
                lastEdit = Date.now();
              } catch {
                // give up
              }
            }
          }
        });
        await editQueue;
      };

      // Periodically flush accumulated content to Discord (respect rate limits)
      let lastFlushedLength = 0;
      const flushTimer = setInterval(() => {
        if (fullContent.length > lastFlushedLength) {
          lastFlushedLength = fullContent.length;
          editMessage(fullContent);
        }
      }, EDIT_INTERVAL);

      const result = await this.provider.completeStream(
        {
          model: this.model,
          messages: history,
          signal: controller.signal,
        },
        // onChunk: called for each text delta — accumulate silently
        async (_chunk: string) => {
          fullContent += _chunk;
        },
        // onReasoning: called for thinking tokens
        async (r: string) => {
          fullReasoning += r;
          const short = fullReasoning.slice(-80).replace(/\n/g, " ");
          try {
            await statusMsg.edit(`🧠 *Réflexion...* ${short}`);
          } catch {
            // ignore
          }
        },
      );

      clearInterval(flushTimer);
      // Flush final content
      await editMessage(fullContent);

      // Final message: use raw content (properly closed by the LLM), not sanitized
      if (currentMsg === statusMsg) {
        await statusMsg.edit("✅ Done (no content)");
      } else {
        const prefix = fullReasoning ? "🧠 *Réflexion terminée*\n" : "";
        try {
          await currentMsg.edit(prefix + fullContent);
        } catch {
          await channel.send(prefix + fullContent);
        }
      }

      // If the response is long, delete streamed message and re-send as split chunks
      if (fullContent.length > 1900) {
        try { await currentMsg.delete(); } catch { /* ignore */ }
        const chunks = this.splitMessage(fullContent);
        for (const c of chunks) {
          await channel.send(c);
        }
      }
    } catch (err: unknown) {
      const error = err as Error & { name?: string };
      if (error.name === "AbortError") {
        // User cancelled — delete the placeholder if still there
        try { await statusMsg.delete(); } catch { /* ignore */ }
        return;
      }
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

  /// Split a long message into Discord-compatible chunks (<=2000 chars).
  /// Preserves code blocks: if a split happens inside a ``` block, closes
  /// it at the end of the first chunk and reopens it (with original language tag)
  /// at the start of the next.
  private splitMessage(content: string, maxLen = 2000): string[] {
    const CODE_MARKER = "```";
    const OVERHEAD = 15; // safety margin for closing/opening markers + lang tag
    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > maxLen) {
      const effectiveMax = maxLen - OVERHEAD;
      let splitAt = remaining.lastIndexOf("\n", effectiveMax);
      if (splitAt <= 0) splitAt = effectiveMax;

      let firstPart = remaining.slice(0, splitAt);
      remaining = remaining.slice(splitAt);

      // Count ``` occurrences in firstPart — if odd, we're inside a code block
      const openCount = (firstPart.match(/```/g) || []).length;
      const isInsideCodeBlock = openCount % 2 !== 0;

      if (isInsideCodeBlock) {
        // Find the language tag from the opening ``` (e.g., "python" from ```python)
        const lastOpen = firstPart.lastIndexOf(CODE_MARKER);
        const afterMarker = firstPart.slice(lastOpen + 3);
        const langTag = afterMarker.match(/^(\S*)/)?.[1] ?? "";

        // Close the code block at end of first chunk
        firstPart += "\n" + CODE_MARKER;
        // Reopen with same language tag at start of next chunk
        remaining = CODE_MARKER + langTag + remaining;
      }

      chunks.push(firstPart);
    }

    if (remaining) chunks.push(remaining);
    return chunks;
  }
}
