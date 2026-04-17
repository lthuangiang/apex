/**
 * Base adapter factory implementation
 * 
 * Provides common functionality for all adapter factories including
 * configuration validation, feature detection, and default configurations.
 */

import { IExchangeAdapter } from '../../types/core.js';
import { AdapterConfig } from '../../types/config.js';
import { AdapterFactory } from '../../types/utils.js';

/**
 * Base adapter factory with common functionality
 */
export abstract class BaseAdapterFactory implements AdapterFactory {
  protected readonly adapterType: string;
  protected readonly supportedFeatures: string[];
  protected readonly requiredCredentials: string[];
  protected readonly optionalCredentials: string[];

  constructor(
    adapterType: string,
    supportedFeatures: string[] = [],
    requiredCredentials: string[] = [],
    optionalCredentials: string[] = []
  ) {
    this.adapterType = adapterType;
    this.supportedFeatures = supportedFeatures;
    this.requiredCredentials = requiredCredentials;
    this.optionalCredentials = optionalCredentials;
  }

  /**
   * Create adapter instance - must be implemented by subclasses
   */
  abstract create(config: AdapterConfig): IExchangeAdapter;

  /**
   * Validate adapter configuration
   */
  validate(config: AdapterConfig): boolean {
    try {
      // Check adapter type
      if (config.type !== this.adapterType) {
        throw new Error(`Invalid adapter type. Expected '${this.adapterType}', got '${config.type}'`);
      }

      // Check if adapter is enabled
      if (!config.enabled) {
        throw new Error('Adapter is disabled');
      }

      // Validate credentials
      this.validateCredentials(config);

      // Validate endpoints
      this.validateEndpoints(config);

      // Validate rate limits
      this.validateRateLimits(config);

      // Validate features
      this.validateFeatures(config);

      // Custom validation
      this.validateCustom(config);

      return true;
    } catch (error) {
      console.error(`Adapter validation failed for ${this.adapterType}:`, error);
      return false;
    }
  }

  /**
   * Get supported features
   */
  getSupportedFeatures(): string[] {
    return [...this.supportedFeatures];
  }

  /**
   * Get default configuration template
   */
  getDefaultConfig(): Partial<AdapterConfig> {
    return {
      type: this.adapterType,
      enabled: true,
      features: this.getSupportedFeatures(),
      limits: {
        requestsPerSecond: 10,
        requestsPerMinute: 600,
        burstLimit: 20,
        orders: {
          perSecond: 5,
          perMinute: 300
        }
      },
      connection: {
        timeout: 30000,
        retry: {
          maxRetries: 3,
          initialDelayMs: 1000,
          backoffMultiplier: 2,
          maxDelayMs: 10000,
          jitter: 0.1
        },
        keepAlive: {
          enabled: true,
          intervalMs: 30000
        }
      },
      credentials: this.getDefaultCredentials(),
      endpoints: this.getDefaultEndpoints(),
      parameters: this.getDefaultParameters()
    };
  }

  /**
   * Get default credentials template
   */
  protected getDefaultCredentials(): Record<string, string> {
    const credentials: Record<string, string> = {};
    
    for (const key of this.requiredCredentials) {
      credentials[key] = '';
    }
    
    for (const key of this.optionalCredentials) {
      credentials[key] = '';
    }
    
    return credentials;
  }

  /**
   * Get default endpoints - should be overridden by subclasses
   */
  protected getDefaultEndpoints(): Record<string, string> {
    return {
      rest: '',
      websocket: ''
    };
  }

  /**
   * Get default parameters - should be overridden by subclasses
   */
  protected getDefaultParameters(): Record<string, any> {
    return {};
  }

  /**
   * Validate credentials
   */
  protected validateCredentials(config: AdapterConfig): void {
    if (!config.credentials) {
      throw new Error('Credentials are required');
    }

    // Check required credentials
    for (const key of this.requiredCredentials) {
      if (!config.credentials[key] || config.credentials[key].trim() === '') {
        throw new Error(`Required credential '${key}' is missing or empty`);
      }
    }

    // Validate credential formats
    this.validateCredentialFormats(config.credentials);
  }

  /**
   * Validate credential formats - can be overridden by subclasses
   */
  protected validateCredentialFormats(credentials: Record<string, string | undefined>): void {
    // Base implementation - subclasses can add specific validation
    
    // Validate API key format if present
    if (credentials.apiKey && credentials.apiKey.length < 10) {
      throw new Error('API key appears to be too short');
    }

    // Validate private key format if present
    if (credentials.privateKey) {
      if (!credentials.privateKey.startsWith('0x') && credentials.privateKey.length !== 64) {
        throw new Error('Private key must be a valid hex string');
      }
    }
  }

  /**
   * Validate endpoints
   */
  protected validateEndpoints(config: AdapterConfig): void {
    if (!config.endpoints) {
      throw new Error('Endpoints configuration is required');
    }

    // Validate REST endpoint
    if (config.endpoints.rest && !this.isValidUrl(config.endpoints.rest)) {
      throw new Error('Invalid REST endpoint URL');
    }

    // Validate WebSocket endpoint
    if (config.endpoints.websocket && !this.isValidWebSocketUrl(config.endpoints.websocket)) {
      throw new Error('Invalid WebSocket endpoint URL');
    }
  }

  /**
   * Validate rate limits
   */
  protected validateRateLimits(config: AdapterConfig): void {
    if (!config.limits) {
      throw new Error('Rate limits configuration is required');
    }

    const { limits } = config;

    if (limits.requestsPerSecond <= 0) {
      throw new Error('Requests per second must be positive');
    }

    if (limits.requestsPerMinute <= 0) {
      throw new Error('Requests per minute must be positive');
    }

    if (limits.requestsPerMinute < limits.requestsPerSecond * 60) {
      throw new Error('Requests per minute should be at least 60x requests per second');
    }

    if (limits.orders) {
      if (limits.orders.perSecond <= 0) {
        throw new Error('Order requests per second must be positive');
      }

      if (limits.orders.perMinute <= 0) {
        throw new Error('Order requests per minute must be positive');
      }
    }
  }

  /**
   * Validate features
   */
  protected validateFeatures(config: AdapterConfig): void {
    if (!config.features || !Array.isArray(config.features)) {
      throw new Error('Features must be an array');
    }

    // Check if all requested features are supported
    for (const feature of config.features) {
      if (!this.supportedFeatures.includes(feature)) {
        throw new Error(`Unsupported feature: ${feature}`);
      }
    }
  }

  /**
   * Custom validation - can be overridden by subclasses
   */
  protected validateCustom(config: AdapterConfig): void {
    // Base implementation does nothing
    // Subclasses can override for adapter-specific validation
  }

  /**
   * Validate URL format
   */
  protected isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Validate WebSocket URL format
   */
  protected isValidWebSocketUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    } catch {
      return false;
    }
  }

  /**
   * Get adapter type
   */
  getAdapterType(): string {
    return this.adapterType;
  }

  /**
   * Get required credentials
   */
  getRequiredCredentials(): string[] {
    return [...this.requiredCredentials];
  }

  /**
   * Get optional credentials
   */
  getOptionalCredentials(): string[] {
    return [...this.optionalCredentials];
  }

  /**
   * Check if feature is supported
   */
  isFeatureSupported(feature: string): boolean {
    return this.supportedFeatures.includes(feature);
  }

  /**
   * Get configuration schema for validation
   */
  getConfigSchema(): any {
    return {
      type: 'object',
      required: ['type', 'enabled', 'credentials', 'endpoints', 'limits'],
      properties: {
        type: {
          type: 'string',
          enum: [this.adapterType]
        },
        enabled: {
          type: 'boolean'
        },
        credentials: {
          type: 'object',
          required: this.requiredCredentials,
          properties: this.getCredentialSchema()
        },
        endpoints: {
          type: 'object',
          properties: {
            rest: { type: 'string', format: 'uri' },
            websocket: { type: 'string', format: 'uri' }
          }
        },
        limits: {
          type: 'object',
          required: ['requestsPerSecond', 'requestsPerMinute'],
          properties: {
            requestsPerSecond: { type: 'number', minimum: 1 },
            requestsPerMinute: { type: 'number', minimum: 1 },
            requestsPerHour: { type: 'number', minimum: 1 },
            burstLimit: { type: 'number', minimum: 1 },
            orders: {
              type: 'object',
              properties: {
                perSecond: { type: 'number', minimum: 1 },
                perMinute: { type: 'number', minimum: 1 }
              }
            }
          }
        },
        features: {
          type: 'array',
          items: {
            type: 'string',
            enum: this.supportedFeatures
          }
        }
      }
    };
  }

  /**
   * Get credential schema - can be overridden by subclasses
   */
  protected getCredentialSchema(): Record<string, any> {
    const schema: Record<string, any> = {};
    
    for (const key of this.requiredCredentials) {
      schema[key] = { type: 'string', minLength: 1 };
    }
    
    for (const key of this.optionalCredentials) {
      schema[key] = { type: 'string' };
    }
    
    return schema;
  }
}