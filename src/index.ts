import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Events,
  Message,
  ChannelType,
  SlashCommandBuilder,
  REST,
  Routes,
  Interaction,
  ChatInputCommandInteraction,
  Partials,
} from "discord.js";
import { BotHandler } from "./services/BotHandler.js";
import { loadCache, saveCache } from "./services/cache.js";
import { type IApiProvider, OpenAIProvider, AnthropicProvider, DeepSeekProvider } from "./providers/index.js";

interface ProviderEntry {
  key: string;
  provider: IApiProvider;
}

const SYSTEM_PROMPT = `You are a helpful AI assistant running as a Discord bot. You communicate exclusively in Direct Messages. Always respond in the same language as the user's message. Be concise, friendly, and helpful. Format your responses using Discord markdown.`;

export async function main() {
  const token = process.env.DISCORD_TOKEN;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  if (!token) {
    console.error("DISCORD_TOKEN is required in .env");
    process.exit(1);
  }

  // Build provider list from available API keys
  const providers: ProviderEntry[] = [];
  if (openaiKey) providers.push({ key: "chatgpt", provider: new OpenAIProvider(openaiKey) });
  if (anthropicKey) providers.push({ key: "claude", provider: new AnthropicProvider(anthropicKey) });
  if (deepseekKey) providers.push({ key: "deepseek", provider: new DeepSeekProvider(deepseekKey) });

  if (providers.length === 0) {
    console.error("At least one API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY) is required in .env");
    process.exit(1);
  }

  // Parse allowed users from env + cache
  const envAllowed = (process.env.ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const defaultProvider = providers[0];

  // Try to restore last used model and allowed users from cache
  const cached = loadCache();
  let activeProvider = defaultProvider;
  let activeModel = defaultProvider.provider.defaultModel;
  let allowedUsers: Set<string> = new Set(envAllowed);

  if (cached) {
    const cachedEntry = providers.find((p) => p.key === cached.providerKey);
    if (cachedEntry) {
      activeProvider = cachedEntry;
      activeModel = cached.modelId;
      console.log(`[CACHE] Restored: ${cachedEntry.provider.name} / ${cached.modelId}`);
    }
    for (const id of cached.allowedUsers) {
      allowedUsers.add(id);
    }
  }

  // If whitelist is non-empty, only those users can talk to the bot
  // If empty (no ALLOWED_USERS and no cached users), everyone can DM
  const isWhitelisted = (userId: string): boolean => {
    if (allowedUsers.size === 0) return true;
    return allowedUsers.has(userId);
  };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
    ],
  });

  const handler = new BotHandler(client, activeProvider.provider, activeModel, SYSTEM_PROMPT);

  // Register slash commands
  const switchCommand = new SlashCommandBuilder()
    .setName("switch")
    .setDescription("Switch AI model or provider")
    .setDMPermission(true)
    .addStringOption((option) =>
      option
        .setName("model")
        .setDescription("The model to switch to")
        .setRequired(true)
        .setAutocomplete(true),
    );

  const allowCommand = new SlashCommandBuilder()
    .setName("allow")
    .setDescription("Allow a user to talk to the bot in DMs")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The user to allow")
        .setRequired(true),
    );

  const rest = new REST({ version: "10" }).setToken(token);

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);

    try {
      await rest.put(Routes.applicationCommands(readyClient.user.id), {
        body: [switchCommand.toJSON(), allowCommand.toJSON()],
      });
      console.log("Slash commands registered");
    } catch (err) {
      console.error("Failed to register slash commands:", err);
    }
  });

  // Handle autocomplete for /switch
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isAutocomplete()) return;
    if (interaction.commandName !== "switch") return;

    const focused = interaction.options.getFocused();
    const choices: { name: string; value: string }[] = [];

    for (const { key, provider } of providers) {
      try {
        const models = await provider.listModels();
        for (const model of models) {
          const label = `${provider.name}: ${model.name} (${model.id})`;
          if (focused.length === 0 || label.toLowerCase().includes(focused.toLowerCase())) {
            choices.push({
              name: label,
              value: `${key}:${model.id}`,
            });
          }
        }
      } catch {
        // skip failed providers
      }
    }

    await interaction.respond(choices.slice(0, 25));
  });

  // Handle /switch command
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction as ChatInputCommandInteraction;

    if (cmd.commandName === "switch") {
      const value = cmd.options.getString("model", true);
      const [providerKey, modelId] = value.split(":");
      const entry = providers.find((p) => p.key === providerKey);

      if (!entry) {
        await cmd.reply({ content: "❌ Provider not found.", ephemeral: true });
        return;
      }

      handler.setProvider(entry.provider);
      handler.setModel(modelId);
      saveCache(providerKey, modelId, [...allowedUsers]);

      await cmd.reply({
        content: `✅ Switched to **${entry.provider.name}** — model \`${modelId}\``,
        ephemeral: true,
      });
    }

    if (cmd.commandName === "allow") {
      const user = cmd.options.getUser("user", true);
      allowedUsers.add(user.id);
      saveCache(activeProvider.key, activeModel, [...allowedUsers]);

      await cmd.reply({
        content: `✅ **${user.tag}** (${user.id}) can now DM the bot.`,
        ephemeral: true,
      });
    }
  });

  // DM: build history and respond directly (whitelist check)
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (message.channel.type === ChannelType.DM) {
      if (!isWhitelisted(message.author.id)) {
        console.log(`[DM] Blocked ${message.author.tag} — not whitelisted`);
        return;
      }
      console.log(`[DM] Message from ${message.author.tag}: "${message.content.slice(0, 50)}"`);
      // Fire typing indicator IMMEDIATELY, before any async work
      message.channel.sendTyping().catch(() => {});
      await handler.handleDM(message);
    }
  });

  // Edit: delete subsequent bot messages and re-respond
  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    if (!oldMessage.partial && newMessage.author && !newMessage.author.bot) {
      console.log(`[EDIT] Message edited by ${newMessage.author.tag}`);
      await handler.handleMessageEdit(oldMessage, newMessage as Message);
    }
  });

  await client.login(token);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
