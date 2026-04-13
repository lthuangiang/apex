"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sharedState = void 0;
exports.addSseClient = addSseClient;
exports.removeSseClient = removeSseClient;
exports.logEvent = logEvent;
exports.addConsoleSseClient = addConsoleSseClient;
exports.removeConsoleSseClient = removeConsoleSseClient;
exports.interceptConsole = interceptConsole;
exports.sharedState = {
    sessionPnl: 0,
    sessionVolume: 0,
    updatedAt: new Date().toISOString(),
    botStatus: 'STOPPED',
    symbol: 'BTC-USD',
    walletAddress: '',
    pnlHistory: [],
    volumeHistory: [],
    eventLog: [],
    openPosition: null,
};
// SSE subscribers for realtime log streaming
const sseClients = new Set();
function addSseClient(send) {
    sseClients.add(send);
}
function removeSseClient(send) {
    sseClients.delete(send);
}
function logEvent(type, message) {
    const entry = {
        time: new Date().toISOString(),
        type,
        message,
    };
    exports.sharedState.eventLog.unshift(entry);
    if (exports.sharedState.eventLog.length > 200) {
        exports.sharedState.eventLog.length = 200;
    }
    // Push to SSE clients
    const payload = JSON.stringify(entry);
    sseClients.forEach(send => send(payload));
}
// SSE subscribers for raw console/stdout streaming
const consoleSseClients = new Set();
function addConsoleSseClient(send) {
    consoleSseClients.add(send);
}
function removeConsoleSseClient(send) {
    consoleSseClients.delete(send);
}
/** Intercept process stdout/stderr and forward to SSE clients */
function interceptConsole() {
    const forward = (chunk) => {
        if (consoleSseClients.size === 0)
            return;
        const lines = chunk.split('\n').filter(l => l.trim());
        const time = new Date().toISOString();
        lines.forEach(line => {
            const payload = JSON.stringify({ time, line });
            consoleSseClients.forEach(send => send(payload));
        });
    };
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk, ...args) => {
        if (typeof chunk === 'string')
            forward(chunk);
        else if (Buffer.isBuffer(chunk))
            forward(chunk.toString());
        return origStdoutWrite(chunk, ...args);
    };
    process.stderr.write = (chunk, ...args) => {
        if (typeof chunk === 'string')
            forward(chunk);
        else if (Buffer.isBuffer(chunk))
            forward(chunk.toString());
        return origStderrWrite(chunk, ...args);
    };
}
