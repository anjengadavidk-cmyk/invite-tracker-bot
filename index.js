const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, REST, Routes } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();

// ----------------------
// DATABASE SETUP
// ----------------------
const db = new sqlite3.Database('./invites.db');

db.run(`
CREATE TABLE IF NOT EXISTS invite_stats (
    user_id TEXT PRIMARY KEY,
    joins INTEGER DEFAULT 0,
    leaves INTEGER DEFAULT 0,
    fake INTEGER DEFAULT 0,
    rejoins INTEGER DEFAULT 0,
    last_verified INTEGER DEFAULT 0
)
`);

function getStats(userId) {
    return new Promise((resolve) => {
        db.get(`SELECT * FROM invite_stats WHERE user_id = ?`, [userId], (err, row) => {
            if (!row) {
                db.run(`INSERT INTO invite_stats (user_id) VALUES (?)`, [userId]);
                return resolve({ joins: 0, leaves: 0, fake: 0, rejoins: 0, last_verified: 0 });
            }
            resolve(row);
        });
    });
}

function updateStat(userId, field) {
    db.run(`UPDATE invite_stats SET ${field} = ${field} + 1 WHERE user_id = ?`, [userId]);
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

client.commands = new Collection();

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

    client.guilds.cache.forEach(async (guild) => {
        await loadInvites(guild);
    });
});

// ----------------------
// INVITE TRACKING
// ----------------------
client.on("guildMemberAdd", async (member) => {
    const cachedInvites = inviteCache.get(member.guild.id);
    const newInvites = await member.guild.invites.fetch();

    const usedInvite = newInvites.find(inv => {
        const old = cachedInvites.get(inv.code);
        return old && inv.uses > old.uses;
    });

    if (usedInvite) {
        updateStat(usedInvite.inviter.id, "joins");
    }

    inviteCache.set(member.guild.id, newInvites);
});

client.on("guildMemberRemove", async (member) => {
    updateStat(member.id, "leaves");
});

// ----------------------
// COMMAND HANDLER
// ----------------------
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const userId = interaction.user.id;

    // /invites
    if (interaction.commandName === "invites") {
        const stats = await getStats(userId);
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
        const stats = await getStats(userId);

        if (stats.joins <= stats.last_verified) {
            return interaction.reply({
                content: "❌ No new invites detected.",
                ephemeral: true
            });
        }

        db.run(`UPDATE invite_stats SET last_verified = joins WHERE user_id = ?`, [userId]);

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
