export type BotSession = {
    isRunning: boolean;
    startTime: number | null;
    maxLoss: number;
    currentPnL: number;
};

export class SessionManager {
    private session: BotSession;
    private _maxLossTriggered = false;

    constructor() {
        this.session = {
            isRunning: false,
            startTime: null,
            maxLoss: 5, // Default $5 max loss
            currentPnL: 0,
        };
    }

    startSession() {
        if (this.session.isRunning) return false;
        this.session.isRunning = true;
        this.session.startTime = Date.now();
        this.session.currentPnL = 0;
        this._maxLossTriggered = false; // reset on new session
        return true;
    }

    stopSession() {
        this.session.isRunning = false;
        // Keep stats for post-session reporting
    }

    /** Reset max-loss flag so the bot can be restarted after an emergency stop */
    resetMaxLoss() {
        this._maxLossTriggered = false;
    }

    setMaxLoss(amount: number) {
        this.session.maxLoss = Math.abs(amount);
    }

    updatePnL(pnl: number) {
        this.session.currentPnL = pnl;
        if (this.session.isRunning && !this._maxLossTriggered && this.session.currentPnL <= -this.session.maxLoss) {
            this._maxLossTriggered = true; // fire only once per session
            console.log(`⚠️ [SessionManager] Max loss reached: ${this.session.currentPnL.toFixed(2)} <= -${this.session.maxLoss}`);
            return true; // Trigger emergency stop
        }
        return false;
    }

    getState(): BotSession {
        return { ...this.session };
    }
}
