export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // En-têtes CORS pour les appels API du frontend
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        // 1. Route pour gérer le callback Discord OAuth2
        if (url.pathname === "/api/auth/discord/callback") {
            const code = url.searchParams.get("code");
            
            if (!code) {
                return Response.redirect(`${url.origin}/?error=no_code`, 302);
            }

            try {
                const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
                    method: "POST",
                    body: new URLSearchParams({
                        client_id: env.DISCORD_CLIENT_ID,
                        client_secret: env.DISCORD_CLIENT_SECRET,
                        grant_type: "authorization_code",
                        code: code,
                        redirect_uri: env.DISCORD_REDIRECT_URI,
                    }),
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                });

                const tokenData = await tokenResponse.json();

                if (!tokenData.access_token) {
                    throw new Error("Échec de l'obtention du token Discord");
                }

                const userResponse = await fetch("https://discord.com/api/users/@me", {
                    headers: {
                        authorization: `Bearer ${tokenData.access_token}`,
                    },
                });

                const userData = await userResponse.json();

                return Response.redirect(`${url.origin}/?user=${encodeURIComponent(userData.username)}&id=${userData.id}`, 302);

            } catch (error) {
                return new Response(`Erreur d'authentification : ${error.message}`, { status: 500, headers: corsHeaders });
            }
        }

        // 2. Routes de création et fermeture de tickets
        if (url.pathname === '/api/create-ticket' && request.method === 'POST') {
            return handleCreateTicket(request, env);
        }

        if (url.pathname === '/api/close-ticket' && request.method === 'POST') {
            return handleCloseTicket(request, env);
        }

        // 3. Tout le reste (index.html, assets, etc.) est servi depuis /public
        return env.ASSETS.fetch(request);
    }
};

async function handleCloseTicket(request, env) {
    const BOT_TOKEN = env.DISCORD_BOT_TOKEN;
    if (!BOT_TOKEN) {
        return jsonResponse(500, { error: "Configuration manquante côté serveur (DISCORD_BOT_TOKEN)." });
    }

    let data;
    try {
        data = await request.json();
    } catch (e) {
        return jsonResponse(400, { error: "Requête invalide." });
    }

    const { channelId } = data;
    if (!channelId) {
        return jsonResponse(400, { error: "Identifiant de salon manquant." });
    }

    try {
        const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });
        if (!res.ok && res.status !== 404) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.message || "Erreur lors de la suppression du salon.");
        }
        return jsonResponse(200, { success: true });
    } catch (err) {
        return jsonResponse(500, { error: err.message });
    }
}

async function handleCreateTicket(request, env) {
    const BOT_TOKEN = env.DISCORD_BOT_TOKEN;
    const GUILD_ID = env.DISCORD_GUILD_ID;

    if (!BOT_TOKEN || !GUILD_ID) {
        return jsonResponse(500, { error: "Configuration manquante côté serveur (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID)." });
    }

    let data;
    try {
        data = await request.json();
    } catch (e) {
        return jsonResponse(400, { error: "Requête invalide." });
    }

    const { annonceNom, proprietaireUsername, proprietaireId, demandeurUsername, demandeurId, categoryName, welcomeMessage } = data;
    const CATEGORY_NAME = (categoryName || env.TICKET_CATEGORY_NAME || "ticket site").toLowerCase();

    if (!demandeurId || !demandeurUsername) {
        return jsonResponse(400, { error: "Connexion Discord requise pour ouvrir un ticket." });
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
            return jsonResponse(500, { error: `Catégorie "${CATEGORY_NAME}" introuvable. Crée-la sur le serveur Discord (exactement ce nom, en minuscules).` });
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

        const defaultMessage =
            `👋 Bonjour <@${demandeurId}> !\n` +
            `Ceci est votre ticket de discussion pour l'annonce **${annonceNom}** de ` +
            `${proprietaireId ? `<@${proprietaireId}>` : `**${proprietaireUsername}**`}.\n\n` +
            `Merci de patienter le temps que la discussion s'engage !`;

        const finalMessage = welcomeMessage
            ? welcomeMessage
                .replaceAll('{demandeur}', `<@${demandeurId}>`)
                .replaceAll('{proprietaire}', proprietaireId ? `<@${proprietaireId}>` : proprietaireUsername)
                .replaceAll('{annonce}', annonceNom)
            : defaultMessage;

        await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ content: finalMessage })
        });

        return jsonResponse(200, {
            success: true,
            channelId: channel.id,
            channelUrl: `https://discord.com/channels/${GUILD_ID}/${channel.id}`
        });
    } catch (err) {
        return jsonResponse(500, { error: err.message });
    }
}

function jsonResponse(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
