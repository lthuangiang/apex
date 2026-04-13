"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaClient = void 0;
const axios_1 = __importDefault(require("axios"));
class OllamaClient {
    url;
    model;
    constructor(url = process.env['OLLAMA_URL'] ?? 'http://localhost:11434', model = 'llama3') {
        this.url = url;
        this.model = model;
    }
    async complete(prompt) {
        const response = await axios_1.default.post(`${this.url}/api/generate`, { model: this.model, prompt, stream: false }, { timeout: 30000 });
        return response.data.response ?? '';
    }
}
exports.OllamaClient = OllamaClient;
