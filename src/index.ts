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
  ChatInputCommandInteraction,
  Interaction,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  Partials,
} from "discord.js";
import { BotHandler } from "./services/BotHandler.js";
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

  const defaultProvider = providers[0];

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

  const handler = new BotHandler(client, defaultProvider.provider, defaultProvider.provider.defaultModel, SYSTEM_PROMPT);

  // Register slash commands
  const switchCommand = new SlashCommandBuilder()
    .setName("switch")
    .setDescription("Switch AI model or provider");

  const rest = new REST({ version: "10" }).setToken(token);

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);

    try {
      await rest.put(Routes.applicationCommands(readyClient.user.id), {
        body: [switchCommand.toJSON()],
      });
      console.log("Slash commands registered");
    } catch (err) {
      console.error("Failed to register slash commands:", err);
    }
  });

  // Handle /switch command
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction as ChatInputCommandInteraction;

    if (cmd.commandName === "switch") {
      // Build select menu with all available models
      const options: { label: string; value: string; description: string }[] = [];

      for (const { key, provider } of providers) {
        const models = await provider.listModels();
        for (const model of models) {
          options.push({
            label: `${provider.name} - ${model.name}`,
            value: `${key}:${model.id}`,
            description: `Switch to ${model.name} from ${provider.name}`,
          });
        }
      }

      if (options.length === 0) {
        await cmd.reply({ content: "No models available.", ephemeral: true });
        return;
      }

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("switch_model")
          .setPlaceholder("Choose a model...")
          .addOptions(options.slice(0, 25)), // Discord limit: 25 options
      );

      await cmd.reply({ content: "**Select an AI model:**", components: [row], ephemeral: true });
    }
  });

  // Handle select menu
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    const menu = interaction as StringSelectMenuInteraction;

    if (menu.customId === "switch_model") {
      const [providerKey, modelId] = menu.values[0].split(":");
      const entry = providers.find((p) => p.key === providerKey);
      if (!entry) {
        await menu.reply({ content: "Provider not found.", ephemeral: true });
        return;
      }

      handler.setProvider(entry.provider);
      handler.setModel(modelId);

      await menu.reply({
        content: `✅ Switched to **${entry.provider.name}** — model \`${modelId}\``,
        ephemeral: true,
      });
    }
  });

  // DM: build history and respond directly
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (message.channel.type === ChannelType.DM) {
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
