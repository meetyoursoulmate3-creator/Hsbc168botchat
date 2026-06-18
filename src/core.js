/**
 * Open Wegram Bot - Core Logic
 * Shared code between Cloudflare Worker and Vercel deployments
 */

export function validateSecretToken(token) {
    return token.length > 15 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {'Content-Type': 'application/json'}
    });
}

export async function postToTelegramApi(token, method, body) {
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    });
}

export async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
        }, 400);
    }

    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.hostname}`;
    const webhookUrl = `${baseUrl}/${prefix}/webhook/${ownerUid}/${botToken}`;

    try {
        const response = await postToTelegramApi(botToken, 'setWebhook', {
            url: webhookUrl,
            allowed_updates: ['message'],
            secret_token: secretToken
        });

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully installed.'});
        }

        return jsonResponse({success: false, message: `Failed to install webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error installing webhook: ${error.message}`}, 500);
    }
}

export async function handleUninstall(botToken, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
        }, 400);
    }

    try {
        const response = await postToTelegramApi(botToken, 'deleteWebhook', {})

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully uninstalled.'});
        }

        return jsonResponse({success: false, message: `Failed to uninstall webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error uninstalling webhook: ${error.message}`}, 500);
    }
}

/**
 * 处理 Webhook 请求
 * @param {Request} request 
 * @param {string} ownerUid - 注册时绑定的主要管理员 UID
 * @param {string} botToken 
 * @param {string} secretToken 
 * @param {Array<string>} adminIds - 额外的管理员 UID 列表（可选）
 */
export async function handleWebhook(request, ownerUid, botToken, secretToken, adminIds = []) {
    // 验证 Secret Token
    if (secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
        return new Response('Unauthorized', {status: 401});
    }

    const update = await request.json();
    if (!update.message) {
        return new Response('OK');
    }

    const message = update.message;
    const reply = message.reply_to_message;

    try {
        // ========== 1. 优先处理 /start 命令 ==========
        if ("/start" === message.text) {
            const welcomeMessage = `欢迎来到汇丰财富联盟！✨

长期招实力靠谱车队🚗
业务频道：@huifengshbc1688
交流群：@huifengshbc1688

【大区精聊】【常规】实力码车，各种丝滑码车，汇率到顶，车队来谈，单子量大，不罚站，小车可扶持，大车可包养。中介永久返点！ 诚邀长期合作！。`;

            await postToTelegramApi(botToken, 'sendMessage', {
                chat_id: message.chat.id,
                text: welcomeMessage,
                reply_to_message_id: message.message_id
            });

            // 不转发 /start 给管理员
            return new Response('OK');
        }

        // ========== 2. 处理管理员回复用户 ==========
        if (reply && message.chat.id.toString() === ownerUid) {
            const rm = reply.reply_markup;
            if (rm && rm.inline_keyboard && rm.inline_keyboard.length > 0) {
                let senderUid = rm.inline_keyboard[0][0].callback_data;
                if (!senderUid) {
                    senderUid = rm.inline_keyboard[0][0].url.split('tg://user?id=')[1];
                }

                await postToTelegramApi(botToken, 'copyMessage', {
                    chat_id: parseInt(senderUid),
                    from_chat_id: message.chat.id,
                    message_id: message.message_id
                });
            }
            return new Response('OK');
        }

        // ========== 3. 普通用户消息 → 转发给所有管理员 ==========
        const sender = message.chat;
        const senderUid = sender.id.toString();
        const senderName = sender.username ? `@${sender.username}` : [sender.first_name, sender.last_name].filter(Boolean).join(' ');

        // ---- 构建管理员列表（去重） ----
        const adminIdSet = new Set();
        adminIdSet.add(ownerUid); // 注册时的主管理员
        if (Array.isArray(adminIds)) {
            adminIds.forEach(id => {
                const idStr = id.toString().trim();
                if (idStr) {
                    adminIdSet.add(idStr);
                }
            });
        }
        const adminList = Array.from(adminIdSet);

        // ---- 发送给每位管理员 ----
        for (const adminId of adminList) {
            // 复制消息，并附带可点击的回复按钮（包含发送者 UID）
            const copyMessage = async function (withUrl = false) {
                const ik = [[{
                    text: `🔏 From: ${senderName} (${senderUid})`,
                    callback_data: senderUid,
                }]];

                if (withUrl) {
                    ik[0][0].text = `🔓 From: ${senderName} (${senderUid})`
                    ik[0][0].url = `tg://user?id=${senderUid}`;
                }

                return await postToTelegramApi(botToken, 'copyMessage', {
                    chat_id: parseInt(adminId),
                    from_chat_id: message.chat.id,
                    message_id: message.message_id,
                    reply_markup: {inline_keyboard: ik}
                });
            };

            // 优先尝试带 URL 的方式，失败则回退到 callback_data 方式
            const response = await copyMessage(true);
            if (!response.ok) {
                await copyMessage();
            }
        }

        return new Response('OK');

    } catch (error) {
        console.error('Error handling webhook:', error);
        return new Response('Internal Server Error', {status: 500});
    }
}

/**
 * 主请求处理器
 * @param {Request} request 
 * @param {Object} config - 包含 prefix, secretToken, adminIds（可选）
 */
export async function handleRequest(request, config) {
    const {prefix, secretToken, adminIds = []} = config;

    const url = new URL(request.url);
    const path = url.pathname;

    const INSTALL_PATTERN = new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`);
    const UNINSTALL_PATTERN = new RegExp(`^/${prefix}/uninstall/([^/]+)$`);
    const WEBHOOK_PATTERN = new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`);

    let match;

    if (match = path.match(INSTALL_PATTERN)) {
        return handleInstall(request, match[1], match[2], prefix, secretToken);
    }

    if (match = path.match(UNINSTALL_PATTERN)) {
        return handleUninstall(match[1], secretToken);
    }

    if (match = path.match(WEBHOOK_PATTERN)) {
        // 将额外的管理员列表传递给 handleWebhook
        return handleWebhook(request, match[1], match[2], secretToken, adminIds);
    }

    return new Response('Not Found', {status: 404});
}
