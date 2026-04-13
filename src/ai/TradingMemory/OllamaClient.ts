import axios from 'axios';

export class OllamaClient {
  private readonly url: string;
  private readonly model: string;
  private readonly enabled: boolean;

  constructor(
    url: string = process.env['OLLAMA_URL'] ?? '',
    model: string = 'llama3',
  ) {
    this.url = url;
    this.model = model;
    this.enabled = !!url;
    if (!this.enabled) {
      console.warn('[OllamaClient] OLLAMA_URL not set — local LLM memory disabled');
    }
  }

  async complete(prompt: string): Promise<string> {
    if (!this.enabled) throw new Error('OllamaClient disabled: no OLLAMA_URL');
    const response = await axios.post(
      `${this.url}/api/generate`,
      { model: this.model, prompt, stream: false },
      { timeout: 30000 },
    );
    return (response.data as { response: string }).response ?? '';
  }
}
