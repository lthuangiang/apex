/**
 * AdapterRegistry - Factory pattern implementation for exchange adapter management
 * 
 * This class manages the lifecycle of all exchange adapters, providing:
 * - Adapter registration and discovery
 * - Factory pattern for adapter creation
 * - Hot-swapping without system restart
 * - Connection health monitoring
 * - Configuration validation
 * 
 * Requirements: 5.1, 5.2, 1.2
 */

import { EventEmitter } from 'events';
import { 
  IExchangeAdapter, 
  ConnectionHealth,
  EventData 
} from '../types/core.js';
import { 
  AdapterConfig,
  RetryConfig 
} from '../types/config.js';
import { 
  AdapterFactory,
  AdapterRegistry as IAdapterRegistry,
  ComponentStatus,
  Lifecycle 
} from '../types/utils.js';

/**
 * Adapter registry events
 */
export interface AdapterRegistryEvents {
  'adapter:registered': { name: string; factory: AdapterFactory };
  'adapter:unregistered': { name: string };
  'adapter:created': { name: string; adapter: IExchangeAdapter };
  'adapter:connected': { name: string; adapter: IExchangeAdapter };
  'adapter:disconnected': { name: string; adapter: IExchangeAdapter; error?: Error };
  'adapter:health_changed': { name: string; health: ConnectionHealth };
  'adapter:error': { name: string; error: Error };
  'registry:health_check': { results: Map<string, boolean> };
}

/**
 * Adapter instance metadata
 */
interface AdapterInstance {
  adapter: IExchangeAdapter;
  config: AdapterConfig;
  createdAt: Date;
  lastHealthCheck?: Date;
  healthStatus: ConnectionHealth;
  reconnectAttempts: number;
  isReconnecting: boolean;
}

/**
 * AdapterRegistry implementation with factory pattern and lifecycle management
 */
export class AdapterRegistry extends EventEmitter implements IAdapterRegistry, Lifecycle {
  private factories = new Map<string, AdapterFactory>();
  private adapters = new Map<string, AdapterInstance>();
  private configs = new Map<string, AdapterConfig>();
  private healthCheckInterval?: NodeJS.Timeout;
  private reconnectTimeouts = new Map<string, NodeJS.Timeout>();
  
  private readonly healthCheckIntervalMs: number = 30000; // 30 seconds
  private readonly maxReconnectAttempts: number = 5;
  private readonly reconnectDelayMs: number = 5000; // 5 seconds
  
  private isInitialized = false;
  private isRunning = false;

  constructor() {
    super();
    this.setMaxListeners(50); // Allow many listeners for monitoring
  }

  // ============================================================================
  // LIFECYCLE MANAGEMENT
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    this.emit('registry:initializing');
    this.isInitialized = true;
    this.emit('registry:initialized');
  }

  async start(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (this.isRunning) {
      return;
    }

    this.emit('registry:starting');
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    this.isRunning = true;
    this.emit('registry:started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.emit('registry:stopping');

    // Stop health monitoring
    this.stopHealthMonitoring();

    // Disconnect all adapters
    await this.disconnectAll();

    this.isRunning = false;
    this.emit('registry:stopped');
  }

  async cleanup(): Promise<void> {
    await this.stop();
    
    // Clear all data
    this.factories.clear();
    this.adapters.clear();
    this.configs.clear();
    this.reconnectTimeouts.clear();
    
    this.removeAllListeners();
    this.isInitialized = false;
  }

  getStatus(): ComponentStatus {
    return {
      name: 'AdapterRegistry',
      state: this.isRunning ? 'running' : this.isInitialized ? 'stopped' : 'initializing',
      isHealthy: this.isRunning && this.adapters.size > 0,
      uptime: this.isRunning ? Date.now() - (this.adapters.values().next().value?.createdAt?.getTime() || Date.now()) : 0,
      metadata: {
        factoryCount: this.factories.size,
        adapterCount: this.adapters.size,
        healthyAdapters: Array.from(this.adapters.values()).filter(a => a.healthStatus.isHealthy).length
      }
    };
  }

  // ============================================================================
  // FACTORY MANAGEMENT
  // ============================================================================

  register(name: string, factory: AdapterFactory): void {
    if (!name || typeof name !== 'string') {
      throw new Error('Adapter name must be a non-empty string');
    }

    if (!factory || typeof factory.create !== 'function') {
      throw new Error('Factory must implement AdapterFactory interface');
    }

    if (this.factories.has(name)) {
      throw new Error(`Adapter factory '${name}' is already registered`);
    }

    this.factories.set(name, factory);
    this.emit('adapter:registered', { name, factory });
  }

  unregister(name: string): void {
    if (!this.factories.has(name)) {
      throw new Error(`Adapter factory '${name}' is not registered`);
    }

    // Disconnect and remove any active adapter instances
    if (this.adapters.has(name)) {
      this.disconnectAdapter(name).catch(error => {
        this.emit('adapter:error', { name, error });
      });
    }

    this.factories.delete(name);
    this.configs.delete(name);
    this.emit('adapter:unregistered', { name });
  }

  getFactory(name: string): AdapterFactory | undefined {
    return this.factories.get(name);
  }

  list(): string[] {
    return Array.from(this.factories.keys());
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  // ============================================================================
  // ADAPTER CREATION AND MANAGEMENT
  // ============================================================================

  create(name: string, config: AdapterConfig): IExchangeAdapter {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`No factory registered for adapter '${name}'`);
    }

    // Validate configuration
    if (!factory.validate(config)) {
      throw new Error(`Invalid configuration for adapter '${name}'`);
    }

    // Create adapter instance
    const adapter = factory.create(config);
    
    // Store configuration for future use
    this.configs.set(name, { ...config });

    // Create adapter instance metadata
    const instance: AdapterInstance = {
      adapter,
      config: { ...config },
      createdAt: new Date(),
      healthStatus: {
        isHealthy: false,
        error: 'Not connected'
      },
      reconnectAttempts: 0,
      isReconnecting: false
    };

    this.adapters.set(name, instance);
    this.emit('adapter:created', { name, adapter });

    return adapter;
  }

  getAdapter(exchangeName: string): IExchangeAdapter {
    // Check if adapter already exists and is connected
    const instance = this.adapters.get(exchangeName);
    if (instance && instance.adapter.isConnected()) {
      return instance.adapter;
    }

    // If adapter exists but is disconnected, try to reconnect
    if (instance && !instance.isReconnecting) {
      this.reconnectAdapter(exchangeName).catch(error => {
        this.emit('adapter:error', { name: exchangeName, error });
      });
      return instance.adapter;
    }

    // Create new adapter if factory exists
    const config = this.configs.get(exchangeName);
    if (!config) {
      throw new Error(`No configuration found for exchange '${exchangeName}'`);
    }

    const adapter = this.create(exchangeName, config);
    
    // Connect the adapter
    this.connectAdapter(exchangeName).catch(error => {
      this.emit('adapter:error', { name: exchangeName, error });
    });

    return adapter;
  }

  // ============================================================================
  // ADAPTER DISCOVERY AND VALIDATION
  // ============================================================================

  isSupported(exchange: string, symbol: string): boolean {
    const instance = this.adapters.get(exchange);
    if (!instance) {
      return false;
    }

    return instance.adapter.supportedSymbols.includes(symbol);
  }

  getActiveAdapters(): Map<string, IExchangeAdapter> {
    const activeAdapters = new Map<string, IExchangeAdapter>();
    
    for (const [name, instance] of this.adapters) {
      if (instance.adapter.isConnected()) {
        activeAdapters.set(name, instance.adapter);
      }
    }

    return activeAdapters;
  }

  getSupportedExchanges(): string[] {
    return Array.from(this.factories.keys());
  }

  getSupportedSymbols(exchange?: string): string[] {
    if (exchange) {
      const instance = this.adapters.get(exchange);
      return instance ? instance.adapter.supportedSymbols : [];
    }

    // Return all supported symbols across all adapters
    const allSymbols = new Set<string>();
    for (const instance of this.adapters.values()) {
      for (const symbol of instance.adapter.supportedSymbols) {
        allSymbols.add(symbol);
      }
    }

    return Array.from(allSymbols);
  }

  // ============================================================================
  // CONNECTION MANAGEMENT
  // ============================================================================

  async connectAdapter(name: string): Promise<void> {
    const instance = this.adapters.get(name);
    if (!instance) {
      throw new Error(`No adapter instance found for '${name}'`);
    }

    try {
      await instance.adapter.connect();
      // Update health status from adapter's own health status
      instance.healthStatus = instance.adapter.getHealthStatus();
      instance.reconnectAttempts = 0;
      instance.isReconnecting = false;
      
      this.emit('adapter:connected', { name, adapter: instance.adapter });
    } catch (error) {
      instance.healthStatus = {
        isHealthy: false,
        error: error instanceof Error ? error.message : 'Connection failed'
      };
      
      this.emit('adapter:error', { name, error: error as Error });
      throw error;
    }
  }

  async disconnectAdapter(name: string): Promise<void> {
    const instance = this.adapters.get(name);
    if (!instance) {
      return;
    }

    // Clear any pending reconnect timeout
    const timeout = this.reconnectTimeouts.get(name);
    if (timeout) {
      clearTimeout(timeout);
      this.reconnectTimeouts.delete(name);
    }

    try {
      await instance.adapter.disconnect();
      // Update health status from adapter's own health status
      instance.healthStatus = instance.adapter.getHealthStatus();
      
      this.emit('adapter:disconnected', { name, adapter: instance.adapter });
    } catch (error) {
      this.emit('adapter:error', { name, error: error as Error });
    }
  }

  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.adapters.keys()).map(name => 
      this.disconnectAdapter(name)
    );

    await Promise.allSettled(disconnectPromises);
  }

  // ============================================================================
  // HOT-SWAPPING SUPPORT
  // ============================================================================

  async hotSwapAdapter(name: string, newConfig: AdapterConfig): Promise<void> {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`No factory registered for adapter '${name}'`);
    }

    // Validate new configuration
    if (!factory.validate(newConfig)) {
      throw new Error(`Invalid configuration for adapter '${name}'`);
    }

    const oldInstance = this.adapters.get(name);
    
    try {
      // Create new adapter with new configuration
      const newAdapter = factory.create(newConfig);
      
      // Connect new adapter
      await newAdapter.connect();
      
      // If we have an old instance, disconnect it
      if (oldInstance) {
        await oldInstance.adapter.disconnect();
      }
      
      // Replace the adapter instance
      const newInstance: AdapterInstance = {
        adapter: newAdapter,
        config: { ...newConfig },
        createdAt: new Date(),
        healthStatus: newAdapter.getHealthStatus(),
        reconnectAttempts: 0,
        isReconnecting: false
      };

      this.adapters.set(name, newInstance);
      this.configs.set(name, { ...newConfig });
      
      this.emit('adapter:hot_swapped', { 
        name, 
        oldAdapter: oldInstance?.adapter, 
        newAdapter 
      });
      
    } catch (error) {
      // If hot swap fails, keep the old adapter if it exists
      this.emit('adapter:error', { name, error: error as Error });
      throw error;
    }
  }

  updateAdapterConfig(name: string, configUpdates: Partial<AdapterConfig>): void {
    const currentConfig = this.configs.get(name);
    if (!currentConfig) {
      throw new Error(`No configuration found for adapter '${name}'`);
    }

    const newConfig = { ...currentConfig, ...configUpdates };
    this.configs.set(name, newConfig);
    
    // Update instance config if it exists
    const instance = this.adapters.get(name);
    if (instance) {
      instance.config = { ...newConfig };
    }
  }

  // ============================================================================
  // HEALTH MONITORING
  // ============================================================================

  async healthCheck(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    for (const [name, instance] of this.adapters) {
      try {
        const isHealthy = instance.adapter.isConnected() && 
                         instance.adapter.getHealthStatus().isHealthy;
        
        results.set(name, isHealthy);
        
        // Update instance health status
        instance.lastHealthCheck = new Date();
        instance.healthStatus = instance.adapter.getHealthStatus();
        
        // Emit health change event if status changed
        this.emit('adapter:health_changed', { 
          name, 
          health: instance.healthStatus 
        });
        
        // Trigger reconnection if unhealthy
        if (!isHealthy && !instance.isReconnecting) {
          this.scheduleReconnect(name);
        }
        
      } catch (error) {
        results.set(name, false);
        instance.healthStatus = {
          isHealthy: false,
          error: error instanceof Error ? error.message : 'Health check failed'
        };
        
        this.emit('adapter:error', { name, error: error as Error });
      }
    }

    this.emit('registry:health_check', { results });
    return results;
  }

  getAdapterHealth(name: string): ConnectionHealth | undefined {
    const instance = this.adapters.get(name);
    return instance?.healthStatus;
  }

  getAllAdapterHealth(): Map<string, ConnectionHealth> {
    const healthMap = new Map<string, ConnectionHealth>();
    
    for (const [name, instance] of this.adapters) {
      healthMap.set(name, instance.healthStatus);
    }

    return healthMap;
  }

  private startHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      return;
    }

    this.healthCheckInterval = setInterval(() => {
      this.healthCheck().catch(error => {
        this.emit('registry:error', error);
      });
    }, this.healthCheckIntervalMs);
  }

  private stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    // Clear all reconnect timeouts
    for (const timeout of this.reconnectTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.reconnectTimeouts.clear();
  }

  // ============================================================================
  // AUTOMATIC RECONNECTION
  // ============================================================================

  private async reconnectAdapter(name: string): Promise<void> {
    const instance = this.adapters.get(name);
    if (!instance || instance.isReconnecting) {
      return;
    }

    if (instance.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('adapter:error', { 
        name, 
        error: new Error(`Max reconnection attempts (${this.maxReconnectAttempts}) exceeded`) 
      });
      return;
    }

    instance.isReconnecting = true;
    instance.reconnectAttempts++;

    try {
      await instance.adapter.disconnect();
      await new Promise(resolve => setTimeout(resolve, this.reconnectDelayMs));
      await instance.adapter.connect();
      
      instance.healthStatus = instance.adapter.getHealthStatus();
      instance.isReconnecting = false;
      
      this.emit('adapter:connected', { name, adapter: instance.adapter });
      
    } catch (error) {
      instance.healthStatus = {
        isHealthy: false,
        error: error instanceof Error ? error.message : 'Reconnection failed'
      };
      instance.isReconnecting = false;
      
      this.emit('adapter:error', { name, error: error as Error });
      
      // Schedule another reconnection attempt
      this.scheduleReconnect(name);
    }
  }

  private scheduleReconnect(name: string): void {
    const instance = this.adapters.get(name);
    if (!instance || instance.isReconnecting) {
      return;
    }

    // Clear any existing timeout
    const existingTimeout = this.reconnectTimeouts.get(name);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Calculate delay with exponential backoff
    const baseDelay = this.reconnectDelayMs;
    const backoffMultiplier = 2;
    const delay = baseDelay * Math.pow(backoffMultiplier, instance.reconnectAttempts);
    const maxDelay = 300000; // 5 minutes
    const actualDelay = Math.min(delay, maxDelay);

    const timeout = setTimeout(() => {
      this.reconnectTimeouts.delete(name);
      this.reconnectAdapter(name).catch(error => {
        this.emit('adapter:error', { name, error });
      });
    }, actualDelay);

    this.reconnectTimeouts.set(name, timeout);
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  getAdapterCount(): number {
    return this.adapters.size;
  }

  getFactoryCount(): number {
    return this.factories.size;
  }

  getConnectedAdapterCount(): number {
    return Array.from(this.adapters.values())
      .filter(instance => instance.adapter.isConnected()).length;
  }

  getAdapterInfo(name: string): AdapterInstance | undefined {
    return this.adapters.get(name);
  }

  getAllAdapterInfo(): Map<string, AdapterInstance> {
    return new Map(this.adapters);
  }

  // ============================================================================
  // EVENT EMITTER OVERRIDES
  // ============================================================================

  emit(event: string | symbol, ...args: any[]): boolean {
    // Add timestamp to all events
    const eventData: EventData = {
      type: event.toString(),
      payload: args[0],
      timestamp: new Date(),
      source: 'AdapterRegistry'
    };

    return super.emit(event, eventData);
  }
}

// Export types for external use
export type { AdapterInstance };