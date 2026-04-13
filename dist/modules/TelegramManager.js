"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramManager = void 0;
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
class TelegramManager {
    bot = null;
    chatId;
    enabled;
    constructor(botToken, chatId) {
        this.chatId = chatId || '';
        this.enabled = !!(botToken && this.chatId);
        if (this.enabled) {
            try {
                this.bot = new node_telegram_bot_api_1.default(botToken, { polling: true });
                console.log('✅ [Telegram] Service initialized with Polling.');
            }
            catch (err) {
                console.error('❌ [Telegram] Failed to initialize Polling:', err);
                this.enabled = false;
            }
        }
        else {
            console.log('⚠️ [Telegram] Missing credentials. Notifications disabled.');
        }
    }
    /**
     * Registers bot commands for the "/" menu in Telegram
     */
    async setupMenu() {
        if (!this.bot || !this.enabled)
            return;
        try {
            await this.bot.setMyCommands([
                { command: 'start_bot', description: 'Start the bot' },
                { command: 'stop_bot', description: 'Stop the bot' },
                { command: 'set_mode', description: 'Switch mode: farm or trade' },
                { command: 'status', description: 'Show bot status & PnL' },
                { command: 'check', description: 'Check active position' },
                { command: 'long', description: 'Manual LONG limit order (bot must be stopped)' },
                { command: 'short', description: 'Manual SHORT limit order (bot must be stopped)' },
                { command: 'set_max_loss', description: 'Set max loss for session (USD)' },
            ]);
            console.log('✅ [Telegram] Command menu registered.');
        }
        catch (error) {
            console.error('[Telegram] Error setting up menu:', error.message);
        }
    }
    /**
     * Sends a message with an optional interactive keyboard
     */
    async sendMessage(text, showMenu = false) {
        if (!this.bot || !this.enabled)
            return;
        const options = {
            parse_mode: 'Markdown',
        };
        if (showMenu) {
            options.reply_markup = {
                keyboard: [
                    [{ text: '🟢 Start Bot' }, { text: '🔴 Stop Bot' }],
                    [{ text: '📊 Status' }, { text: '🔍 Check' }],
                ],
                resize_keyboard: true,
                one_time_keyboard: false,
            };
        }
        try {
            await this.bot.sendMessage(this.chatId, text, options);
        }
        catch (error) {
            console.error('[Telegram] Error sending message:', error.message);
        }
    }
    /**
     * Sends a message with Inline Buttons (callback buttons)
     */
    async sendMessageWithInlineButtons(text, buttons) {
        if (!this.bot || !this.enabled)
            return;
        try {
            await this.bot.sendMessage(this.chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: buttons
                }
            });
        }
        catch (error) {
            console.error('[Telegram] Error sending message with inline buttons:', error.message);
        }
    }
    /**
     * Handles callback queries (inline button clicks)
     */
    onCallback(action, callback) {
        if (!this.bot || !this.enabled)
            return;
        this.bot.on('callback_query', (query) => {
            // SECURITY CHECK: Ensure the callback comes from the authorized chat
            if (query.message?.chat.id.toString() !== this.chatId) {
                console.warn(`🛡️ [Telegram] Unauthorized callback attempt from chat ID: ${query.message?.chat.id}`);
                return;
            }
            if (query.data === action) {
                // Answer the callback query to remove the loading state on the button
                this.bot?.answerCallbackQuery(query.id);
                callback();
            }
        });
    }
    onCommand(command, callback) {
        if (!this.bot || !this.enabled)
            return;
        // Support /command and /command@botname
        const regex = new RegExp(`^\\/${command}(?:@\\w+)?(?:\\s+(.+))?$`);
        // Also support plain text buttons from the keyboard
        const buttonTextMapping = {
            '🟢 Start Bot': 'start_bot',
            '🔴 Stop Bot': 'stop_bot',
            '📊 Status': 'status',
            '🔍 Check': 'check'
        };
        this.bot.on('message', (msg) => {
            if (msg.chat.id.toString() !== this.chatId)
                return;
            if (!msg.text)
                return;
            // Check if it's a command
            const match = msg.text.match(regex);
            if (match) {
                const args = match && match[1] ? match[1].split(/\s+/) : [];
                callback(args);
                return;
            }
            // Check if it's a button click
            const mappedCommand = buttonTextMapping[msg.text];
            if (mappedCommand === command) {
                callback([]);
            }
        });
    }
    isEnabled() {
        return this.enabled;
    }
}
exports.TelegramManager = TelegramManager;
