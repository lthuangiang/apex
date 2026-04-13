"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryRouter = void 0;
const express_1 = require("express");
const TradingMemoryService_js_1 = require("./TradingMemoryService.js");
const router = (0, express_1.Router)();
exports.memoryRouter = router;
const memoryService = new TradingMemoryService_js_1.TradingMemoryService();
router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
router.post('/save', async (req, res) => {
    const { signal, decision, pnlResult } = req.body;
    if (!signal || !decision || !pnlResult) {
        res.status(400).json({ error: 'Missing required fields: signal, decision, pnlResult' });
        return;
    }
    const requiredSignalFields = ['price', 'sma50', 'ls_ratio', 'orderbook_imbalance', 'buy_pressure', 'rsi'];
    for (const field of requiredSignalFields) {
        if (typeof signal[field] !== 'number') {
            res.status(400).json({ error: `signal.${field} must be a number` });
            return;
        }
    }
    try {
        const tradeId = await memoryService.saveTrade(signal, decision, pnlResult);
        res.json({ tradeId, status: 'saved' });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
    }
});
router.post('/predict', async (req, res) => {
    const { signal } = req.body;
    if (!signal) {
        res.status(400).json({ error: 'Missing required field: signal' });
        return;
    }
    const requiredSignalFields = ['price', 'sma50', 'ls_ratio', 'orderbook_imbalance', 'buy_pressure', 'rsi'];
    for (const field of requiredSignalFields) {
        if (typeof signal[field] !== 'number') {
            res.status(400).json({ error: `signal.${field} must be a number` });
            return;
        }
    }
    const result = await memoryService.predict(signal);
    res.json(result);
});
