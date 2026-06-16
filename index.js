
const { Client, GatewayIntentBits, Partials, SlashCommandBuilder, Routes, REST } = require("discord.js");
const Database = require("better-sqlite3");

// ----------------------
// CONFIGURATION
// ----------------------
const TOKEN = process.env.TOKEN;

// Channels
const LOG_CHANNEL = "1516529531622658118";
const VERIFY_CHANNEL = "1516506978350796842";

// Reward Roles
const ROLE_5_INVITES = "1516530180120907988";
const ROLE_10_INVITES = "1516530257069342841";

// ----------------------
// DATABASE SETUP
// ----------------------
const db = new Database("invites.sqlite");

db.prepare(`
  CREATE TABLE IF NOT EXISTS invites (
    user_id TEXT PRIMARY KEY,
    inviter_id TEXT,
    count INTEGER DEFAULT 0
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    inviter_id TEXT,
    uses INTEGER DEFAULT 0
  )
`).run();

// ----------------------
// DISCORD CLIENT
// ----------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ],
  partials: [Partials.GuildMember]
});

// ----------------------
// REGISTER SLASH COMMANDS
// ----------------------
const commands = [
  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verify an invite code")
    .addStringOption(option =>
      option.setName("code")
        .setDescription("The invite code to verify")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("invites")
    .setDescription("Check your invite count")
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands }
  );

  console.log("Slash commands registered.");
});

// ----------------------
// INVITE TRACKING
// ----------------------
let cachedInvites = new Map();

client.on("inviteCreate", async invite => {
  cachedInvites.set(invite.code, invite.uses);
});

client.on("ready", async () => {
  const guild = client.guilds.cache.first();
  const invites = await guild.invites.fetch();

  invites.forEach(inv => {
    cachedInvites.set(inv.code, inv.uses);
  });
});

// ----------------------
// MEMBER JOIN
// ----------------------
client.on("guildMemberAdd", async member => {
  const guild = member.guild;
  const newInvites = await guild.invites.fetch();

  let usedInvite = null;

  newInvites.forEach(inv => {
    const oldUses = cachedInvites.get(inv.code);
    if (oldUses < inv.uses) usedInvite = inv;
  });

  newInvites.forEach(inv => cachedInvites.set(inv.code, inv.uses));

  const logChannel = guild.channels.cache.get(LOG_CHANNEL);

  if (!usedInvite) {
    logChannel?.send(`❓ ${member.user.tag} joined but I couldn't detect the invite.`);
    return;
  }

  const inviterId = usedInvite.inviter.id;

  // Update database
  const row = db.prepare("SELECT count FROM invites WHERE user_id = ?").get(inviterId);

  if (!row) {
    db.prepare("INSERT INTO invites (user_id, inviter_id, count) VALUES (?, ?, ?)").run(inviterId, inviterId, 1);
  } else {
    db.prepare("UPDATE invites SET count = ? WHERE user_id = ?").run(row.count + 1, inviterId);
  }

  logChannel?.send(`📥 **${member.user.tag}** joined using **${usedInvite.code}** from <@${inviterId}>`);

  // Reward roles
  const inviter = guild.members.cache.get(inviterId);
  const newCount = db.prepare("SELECT count FROM invites WHERE user_id = ?").get(inviterId).count;

  if (newCount >= 5) inviter.roles.add(ROLE_5_INVITES).catch(() => {});
  if (newCount >= 10) inviter.roles.add(ROLE_10_INVITES).catch(() => {});
});

// ----------------------
// MEMBER LEAVE
// ----------------------
client.on("guildMemberRemove", async member => {
  const guild = member.guild;
  const logChannel = guild.channels.cache.get(LOG_CHANNEL);

  const row = db.prepare("SELECT inviter_id FROM invites WHERE user_id = ?").get(member.id);

  if (!row) return;

  const inviterId = row.inviter_id;

  const inviterRow = db.prepare("SELECT count FROM invites WHERE user_id = ?").get(inviterId);
  if (!inviterRow) return;

  const newCount = Math.max(0, inviterRow.count - 1);

  db.prepare("UPDATE invites SET count = ? WHERE user_id = ?").run(newCount, inviterId);

  logChannel?.send(`📤 **${member.user.tag}** left. Removing 1 invite from <@${inviterId}>`);

  const inviter = guild.members.cache.get(inviterId);

  if (newCount < 5) inviter.roles.remove(ROLE_5_INVITES).catch(() => {});
  if (newCount < 10) inviter.roles.remove(ROLE_10_INVITES).catch(() => {});
});

// ----------------------
// /verify COMMAND
// ----------------------
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "verify") {
    const code = interaction.options.getString("code");

    const row = db.prepare("SELECT inviter_id FROM invite_codes WHERE code = ?").get(code);

    const channel = interaction.guild.channels.cache.get(VERIFY_CHANNEL);

    if (!row) {
      channel?.send(`❌ Invalid invite code: **${code}**`);
      return interaction.reply({ content: "Invalid code.", ephemeral: true });
    }

    channel?.send(`✅ Invite code **${code}** verified! Inviter: <@${row.inviter_id}>`);
    return interaction.reply({ content: "Invite verified!", ephemeral: true });
  }

  if (interaction.commandName === "invites") {
    const row = db.prepare("SELECT count FROM invites WHERE user_id = ?").get(interaction.user.id);

    const count = row ? row.count : 0;

    return interaction.reply(`📊 You have **${count}** invites.`);
  }
});

// ----------------------
// LOGIN
// ----------------------
client.login(TOKEN);
