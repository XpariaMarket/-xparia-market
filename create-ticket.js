// Fonction serverless Netlify — crée un vrai salon Discord "ticket" dans la
// catégorie "ticket site", visible uniquement par le demandeur et le
// propriétaire de l'annonce (si connu).
//
// Le token du bot reste ici, côté serveur (variable d'environnement Netlify)
// — jamais envoyé au navigateur.

const CATEGORY_NAME = "ticket site";

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non autorisée.' }) };
    }

    const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
    const GUILD_ID = process.env.DISCORD_GUILD_ID;

    if (!BOT_TOKEN || !GUILD_ID) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Configuration manquante côté serveur (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID)." })
        };
    }

    let data;
    try {
        data = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide.' }) };
    }

    const { annonceNom, proprietaireUsername, proprietaireId, demandeurUsername, demandeurId } = data;

    if (!demandeurId || !demandeurUsername) {
        return { statusCode: 400, body: JSON.stringify({ error: "Connexion Discord requise pour ouvrir un ticket." }) };
    }

    const headers = {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json'
    };

    try {
        const channelsRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, { headers });
        const channels = await channelsRes.json();
        if (!channelsRes.ok) throw new Error(channels.message || "Impossible de lire les salons du serveur.");

        const category = channels.find(c => c.type === 4 && c.name.toLowerCase() === CATEGORY_NAME);
        if (!category) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: `Catégorie "${CATEGORY_NAME}" introuvable. Crée-la sur le serveur Discord (exactement ce nom, en minuscules).` })
            };
        }

        const VIEW_AND_SEND = "3072";
        const permission_overwrites = [
            { id: GUILD_ID, type: 0, deny: "1024" },
            { id: demandeurId, type: 1, allow: VIEW_AND_SEND }
        ];
        if (proprietaireId) {
            permission_overwrites.push({ id: proprietaireId, type: 1, allow: VIEW_AND_SEND });
        }

        const channelName = `ticket-${demandeurUsername}`
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .slice(0, 90);

        const createRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: channelName,
                type: 0,
                parent_id: category.id,
                topic: `Demande de contact — ${annonceNom} — entre ${demandeurUsername} et ${proprietaireUsername}`,
                permission_overwrites
            })
        });
        const channel = await createRes.json();
        if (!createRes.ok) throw new Error(channel.message || "Erreur lors de la création du salon.");

        await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                content:
                    `👋 Bonjour <@${demandeurId}> !\n` +
                    `Ceci est votre ticket de discussion pour l'annonce **${annonceNom}** de ` +
                    `${proprietaireId ? `<@${proprietaireId}>` : `**${proprietaireUsername}**`}.\n\n` +
                    `Merci de patienter le temps que la discussion s'engage !`
            })
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                channelId: channel.id,
                channelUrl: `https://discord.com/channels/${GUILD_ID}/${channel.id}`
            })
        };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
