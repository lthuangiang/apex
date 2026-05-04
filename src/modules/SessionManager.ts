export type BotSession = {
    isRunning: boolean;
    startTime: number | null;
    maxLoss: number;
    currentPnL: number;
    /** Target volume for the session (USD). 0 = disabled. */
    targetVolumeUsd: number;
    /** Current accumulated session volume (USD). Updated by Watcher. */
    currentVolumeUsd: number;
};

export class SessionManager {
    private session: BotSession;
    private _maxLossTriggered = false;
    private _volumeTargetTriggered = false;

    constructor() {
        this.session = {
            isRunning: false,
            startTime: null,
            maxLoss: 5, // Default $5 max loss
            currentPnL: 0,
            targetVolumeUsd: 0,   // 0 = disabled
            currentVolumeUsd: 0,
        };
    }

    startSession() {
        if (this.session.isRunning) return false;
        this.session.isRunning = true;
        this.session.startTime = Date.now();
        this.session.currentPnL = 0;
        this.session.currentVolumeUsd = 0;
        this._maxLossTriggered = false;
        this._volumeTargetTriggered = false;
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

    /** Reset volume-target flag so the bot can be restarted after a volume-target stop */
    resetVolumeTarget() {
        this._volumeTargetTriggered = false;
    }

    setMaxLoss(amount: number) {
        this.session.maxLoss = Math.abs(amount);
    }

    /** Set daily volume target (USD). Pass 0 to disable. */
    setTargetVolume(usd: number) {
        this.session.targetVolumeUsd = Math.max(0, usd);
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

    /**
     * Update current session volume and check against target.
     * @param volumeUsd - Total accumulated session volume in USD
     * @returns true if volume target is hit (trigger stop), false otherwise
     */
    updateVolume(volumeUsd: number): boolean {
        this.session.currentVolumeUsd = volumeUsd;
        if (
            this.session.isRunning &&
            !this._volumeTargetTriggered &&
            this.session.targetVolumeUsd > 0 &&
            this.session.currentVolumeUsd >= this.session.targetVolumeUsd
        ) {
            this._volumeTargetTriggered = true; // fire only once per session
            console.log(`🎯 [SessionManager] Volume target reached: ${this.session.currentVolumeUsd.toFixed(0)} >= ${this.session.targetVolumeUsd}`);
            return true; // Trigger stop
        }
        return false;
    }

    getState(): BotSession {
        return { ...this.session };
    }
}
