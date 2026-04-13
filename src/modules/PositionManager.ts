import { Position } from '../adapters/ExchangeAdapter.js';
import { config } from '../config.js';

export type TraderProfile = 'SCALP' | 'NORMAL' | 'RUNNER' | 'DEGEN';

export class PositionManager {
    private openTimestamp: number | null = null;
    private dynamicMaxHold = 0;
    
    // Memory and Volatility
    private recentPrices: number[] = [];
    private maxVolWindow = 60; // 60 ticks
    private currentVolatility = 0;

    // Trailing Stop state
    private trailingActive = false;
    private peakPrice = 0;
    private trailingDistancePercent = 0;

    constructor() {}

    /**
     * Called constantly to update rolling metrics (even outside positions)
     */
    updateTick(currentPrice: number) {
        this.recentPrices.push(currentPrice);
        if (this.recentPrices.length > this.maxVolWindow) {
            this.recentPrices.shift();
        }
        
        // Rolling range volatility: (max - min) / mid
        if (this.recentPrices.length > 10) {
            const maxP = Math.max(...this.recentPrices);
            const minP = Math.min(...this.recentPrices);
            const midP = (maxP + minP) / 2;
            this.currentVolatility = (maxP - minP) / midP;
        }
    }

    getVolatility() { return this.currentVolatility; }

    onPositionOpened(position: Position, profile: TraderProfile) {
        if (!this.openTimestamp) {
            this.openTimestamp = Date.now();
            this.trailingActive = false;
            this.peakPrice = position.entryPrice;
            this.trailingDistancePercent = 0;
            
            // Baseline from config (converted to ms)
            const baseMs = config.TIME_EXIT_SECONDS * 1000;
            let minD = baseMs * 0.5;
            let maxD = baseMs * 1.5;
            
            // Profile-based scaling
            if (profile === 'SCALP') {
                minD = baseMs * 0.2; maxD = baseMs * 0.8;
            } else if (profile === 'NORMAL') {
                minD = baseMs * 0.8; maxD = baseMs * 1.2;
            } else if (profile === 'RUNNER') {
                minD = baseMs * 1.2; maxD = baseMs * 2.5;
            } else if (profile === 'DEGEN') {
                minD = baseMs * 0.1; maxD = baseMs * 5.0; // Very wide for DEGEN
            }

            // Market-aware adjustments
            if (this.currentVolatility > 0.005) { // High vol -> shorter hold
                maxD *= 0.7;
            }

            // 10% Noise Layer - Fat-fingered exit
            if (Math.random() < 0.10) {
                console.log(`🧠 [Behavior] Fat-fingered exit planned!`);
                minD = 5000; maxD = 15000;
            }

            this.dynamicMaxHold = Math.floor(Math.random() * (maxD - minD + 1)) + minD;

            // ABSOLUTE HARD CAP: Never exceed 3x the config baseline
            const absoluteCap = baseMs * 3;
            if (this.dynamicMaxHold > absoluteCap) this.dynamicMaxHold = absoluteCap;

            console.log(`⏱️ Position opened. Profile: [${profile}]. Dynamic Hold Target: ${Math.floor(this.dynamicMaxHold/1000)}s (Config base: ${config.TIME_EXIT_SECONDS}s)`);
        }
    }

    onPositionClosed() {
        this.openTimestamp = null;
        this.trailingActive = false;
    }

    /**
     * Checks if behavior engine dictates an exit
     */
    shouldBehaviorExit(position: Position, currentPrice: number, profile: TraderProfile): string | null {
        if (!this.openTimestamp) return null;
        const duration = Date.now() - this.openTimestamp;
        const pnlPercent = position.side === 'long' 
            ? (currentPrice - position.entryPrice) / position.entryPrice 
            : (position.entryPrice - currentPrice) / position.entryPrice;

        const baseMs = config.TIME_EXIT_SECONDS * 1000;

        // 1. Update Trailing Peak
        if (position.side === 'long' && currentPrice > this.peakPrice) this.peakPrice = currentPrice;
        if (position.side === 'short' && currentPrice < this.peakPrice) this.peakPrice = currentPrice;

        // 2. Trailing Stop Execution
        if (this.trailingActive) {
            const dropAllowed = this.peakPrice * this.trailingDistancePercent;
            const threshold = position.side === 'long' ? this.peakPrice - dropAllowed : this.peakPrice + dropAllowed;
            const stopHit = position.side === 'long' ? currentPrice <= threshold : currentPrice >= threshold;
            if (stopHit) return `Trailing Stop Hit (${(this.trailingDistancePercent*100).toFixed(2)}%)`;
        }

        // 3. Profit-based Extension Logic (ONE-TIME Activation)
        if (pnlPercent > 0.015 && !this.trailingActive) {
            let roll = Math.random();
            if (roll < 0.3) {
                return "Took Profit Early (Human Panic Setup)";
            } else {
                // Activate Trailing Stop + Small Extension
                this.trailingActive = true;
                const extension = Math.min(baseMs * 0.5, 300000); // Max 5 min extension or 0.5x base
                this.dynamicMaxHold += extension;
                
                let tBase = Math.random() * (0.025 - 0.008) + 0.008;
                if (profile === 'DEGEN') tBase = Math.random() * (0.05 - 0.02) + 0.02;
                this.trailingDistancePercent = tBase * (1 + (this.currentVolatility * 10));
                
                console.log(`🧠 [Behavior] Profit Hit. Trailing Activated. Target extended +${(extension/1000).toFixed(0)}s.`);
            }
        }

        // 4. Time Expiration (with absolute hard cap check)
        const absoluteCap = baseMs * 3;
        const finalLimit = Math.min(this.dynamicMaxHold, absoluteCap);

        if (duration >= finalLimit) {
            return `Dynamic Time-based Exit (${Math.floor(duration/1000)}s)`;
        }

        return null;
    }

    getDurationSeconds(): number {
        if (!this.openTimestamp) return 0;
        return Math.floor((Date.now() - this.openTimestamp) / 1000);
    }
}
