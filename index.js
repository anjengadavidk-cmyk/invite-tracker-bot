const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, REST, Routes } = require('discord.js');
const Database = require('better-sqlite3');

// ----------------------
// DATABASE SETUP
// ----------------------
const db = new Database('./invites.db');

db.prepare(`
CREATE TABLE IF NOT EXISTS invite_stats (
    user_id TEXT PRIMARY KEY,
    joins INTEGER DEFAULT 0,
    leaves INTEGER DEFAULT 0,
    fake INTEGER DEFAULT 0,
    rejoins INTEGER DEFAULT 0,
    last_verified INTEGER DEFAULT 0
)
`).run();

function getStats(userId) {
    let row = db.prepare(`SELECT * FROM invite_stats WHERE user_id = ?`).get(userId);

    if (!row) {
        db.prepare(`INSERT INTO invite_stats (user_id) VALUES (?)`).run(userId);
        row = { user_id: userId, joins: 0, leaves: 0, fake: 0, rejoins: 0, last_verified: 0 };
    }

    return row;
}

function increment(userId, field) {
    db.prepare(`UPDATE invite_stats SET ${field} = ${field} + 1 WHERE user_id = ?`).run(userId);
}

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
// SLASH COMMANDS
// ----------------------
const commands = [
    {
        name: "invites",
        description: "Show your invite statistics"
    },
    {
        name: "verify",
        description: "Verify your most recent invite",
        options: [
            {
                name: "invite",
                description: "Verify your latest invite",
                type: 1
            }
        ]
    }
];

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
    try {
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        console.log("Slash commands registered.");
    } catch (err) {
        console.error(err);
    }
})();

// ----------------------
// INVITE CACHE
// ----------------------
const inviteCache = new Map();

async function loadInvites(guild) {
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, invites);
}

client.on("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);

    for (const guild of client.guilds.cache.values()) {
        await loadInvites(guild);
    }
});

// ----------------------
// INVITE TRACKING
// ----------------------
client.on("guildMemberAdd", async (member) => {
    const cached = inviteCache.get(member.guild.id);
    const newInvites = await member.guild.invites.fetch();

    const used = newInvites.find(inv => {
        const old = cached.get(inv.code);
        return old && inv.uses > old.uses;
    });

    if (used) {
        increment(used.inviter.id, "joins");
    }

    inviteCache.set(member.guild.id, newInvites);
});

client.on("guildMemberRemove", async (member) => {
    increment(member.id, "leaves");
});

// ----------------------
// COMMAND HANDLER
// ----------------------
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const userId = interaction.user.id;

    // /invites
    if (interaction.commandName === "invites") {
        const stats = getStats(userId);
        const total = stats.joins - stats.leaves - stats.fake + stats.rejoins;

        const embed = new EmbedBuilder()
            .setTitle("📊 Invite Log")
            .setDescription(
                `🪪 **${interaction.user.username}** has **${total}** invites\n\n` +
                `📥 **Joins:** ${stats.joins}\n` +
                `📤 **Left:** ${stats.leaves}\n` +
                `⚠️ **Fake:** ${stats.fake}\n` +
                `🔄 **Rejoins:** ${stats.rejoins} (7d)\n\n`
            )
            .setFooter({ text: `Requested by ${interaction.user.username} • Today` })
            .setColor("#2b2d31");

        return interaction.reply({ embeds: [embed] });
    }

    // /verify invite
    if (interaction.commandName === "verify") {
        const stats = getStats(userId);

        if (stats.joins <= stats.last_verified) {
            return interaction.reply({
                content: "❌ No new invites detected.",
                ephemeral: true
            });
        }

        db.prepare(`UPDATE invite_stats SET last_verified = joins WHERE user_id = ?`).run(userId);

        const total = stats.joins - stats.leaves - stats.fake + stats.rejoins;

        return interaction.reply({
            content: `✅ Invite verified! You now have **${total}** invites.`,
            ephemeral: true
        });
    }
});

// ----------------------
// LOGIN
// ----------------------
client.login(process.env.TOKEN);
