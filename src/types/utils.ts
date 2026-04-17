/**
 * Utility types and helper interfaces for the modular architecture
 * 
 * This file contains utility types, factory interfaces, and helper types
 * that support the core modular architecture components.
 */

import { 
  IStrategy, 
  IExecutionEngine, 
  IExchangeAdapter, 
  IStateMachine,
  BotState,
  TradingSignal,
  Position,
  Order
} from './core.js';
import { 
  AdapterConfig, 
  StrategyConfig, 
  RunnerConfig,
  SystemConfig 
} from './config.js';

// ============================================================================
// FACTORY INTERFACES
// ============================================================================

/**
 * Factory interface for creating exchange adapters
 */
export interface AdapterFactory {
  /**
   * Create a new adapter instance
   */
  create(config: AdapterConfig): IExchangeAdapter;
  
  /**
   * Validate adapter configuration
   */
  validate(config: AdapterConfig): boolean;
  
  /**
   * Get supported features for this adapter type
   */
  getSupportedFeatures(): string[];
  
  /**
   * Get default configuration template
   */
  getDefaultConfig(): Partial<AdapterConfig>;
}

/**
 * Factory interface for creating strategies
 */
export interface StrategyFactory {
  /**
   * Create a new strategy instance
   */
  create(config: StrategyConfig): IStrategy;
  
  /**
   * Validate strategy configuration
   */
  validate(config: StrategyConfig): boolean;
  
  /**
   * Get strategy metadata
   */
  getMetadata(): StrategyMetadata;
  
  /**
   * Get default configuration template
   */
  getDefaultConfig(): Partial<StrategyConfig>;
}

/**
 * Factory interface for creating execution engines
 */
export interface ExecutionEngineFactory {
  /**
   * Create a new execution engine instance
   */
  create(adapter: IExchangeAdapter): IExecutionEngine;
  
  /**
   * Get supported execution features
   */
  getSupportedFeatures(): string[];
}

/**
 * Factory interface for creating state machines
 */
export interface StateMachineFactory {
  /**
   * Create a new state machine instance
   */
  create(initialState?: BotState): IStateMachine;
  
  /**
   * Get valid state transitions
   */
  getValidTransitions(): Record<BotState, BotState[]>;
}

// ============================================================================
// REGISTRY INTERFACES
// ============================================================================

/**
 * Registry interface for managing component factories
 */
export interface ComponentRegistry<T, F> {
  /**
   * Register a factory
   */
  register(name: string, factory: F): void;
  
  /**
   * Unregister a factory
   */
  unregister(name: string): void;
  
  /**
   * Get a factory by name
   */
  getFactory(name: string): F | undefined;
  
  /**
   * Create an instance using registered factory
   */
  create(name: string, config: any): T;
  
  /**
   * List all registered factory names
   */
  list(): string[];
  
  /**
   * Check if a factory is registered
   */
  has(name: string): boolean;
}

/**
 * Adapter registry interface
 */
export interface AdapterRegistry extends ComponentRegistry<IExchangeAdapter, AdapterFactory> {
  /**
   * Get adapter by exchange name (creates if not exists)
   */
  getAdapter(exchangeName: string): IExchangeAdapter;
  
  /**
   * Check if exchange and symbol are supported
   */
  isSupported(exchange: string, symbol: string): boolean;
  
  /**
   * Get all active adapters
   */
  getActiveAdapters(): Map<string, IExchangeAdapter>;
  
  /**
   * Health check all adapters
   */
  healthCheck(): Promise<Map<string, boolean>>;
}

/**
 * Strategy registry interface
 */
export interface StrategyRegistry extends ComponentRegistry<IStrategy, StrategyFactory> {
  /**
   * Get strategy metadata by name
   */
  getMetadata(name: string): StrategyMetadata | undefined;
  
  /**
   * List strategies by category
   */
  listByCategory(category: string): string[];
}

// ============================================================================
// METADATA INTERFACES
// ============================================================================

/**
 * Strategy metadata
 */
export interface StrategyMetadata {
  /** Strategy name */
  name: string;
  
  /** Strategy version */
  version: string;
  
  /** Strategy description */
  description: string;
  
  /** Strategy author */
  author: string;
  
  /** Strategy category */
  category: string;
  
  /** Supported markets */
  supportedMarkets: string[];
  
  /** Required parameters */
  requiredParameters: string[];
  
  /** Optional parameters */
  optionalParameters: string[];
  
  /** Performance characteristics */
  characteristics: {
    timeframe: string;
    riskLevel: 'low' | 'medium' | 'high';
    complexity: 'simple' | 'moderate' | 'complex';
  };
}

/**
 * Runner status information
 */
export interface RunnerStatus {
  /** Runner ID */
  id: string;
  
  /** Current state */
  state: BotState;
  
  /** Whether runner is active */
  isActive: boolean;
  
  /** Start time */
  startTime?: Date;
  
  /** Last activity time */
  lastActivity?: Date;
  
  /** Uptime in milliseconds */
  uptime: number;
  
  /** Current position */
  position?: Position;
  
  /** Open orders */
  openOrders: Order[];
  
  /** Performance metrics */
  performance: RunnerPerformance;
  
  /** Health status */
  health: RunnerHealth;
  
  /** Configuration */
  config: RunnerConfig;
}

/**
 * Runner performance metrics
 */
export interface RunnerPerformance {
  /** Total trades executed */
  totalTrades: number;
  
  /** Winning trades */
  winningTrades: number;
  
  /** Losing trades */
  losingTrades: number;
  
  /** Win rate percentage */
  winRate: number;
  
  /** Total PnL */
  totalPnL: number;
  
  /** Total volume traded */
  totalVolume: number;
  
  /** Average trade duration in milliseconds */
  avgTradeDuration: number;
  
  /** Maximum drawdown */
  maxDrawdown: number;
  
  /** Sharpe ratio */
  sharpeRatio?: number;
}

/**
 * Runner health status
 */
export interface RunnerHealth {
  /** Overall health status */
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  
  /** Health score (0-100) */
  score: number;
  
  /** Last health check time */
  lastCheck: Date;
  
  /** Health issues */
  issues: HealthIssue[];
  
  /** Component health */
  components: {
    strategy: ComponentHealth;
    executionEngine: ComponentHealth;
    adapter: ComponentHealth;
    stateMachine: ComponentHealth;
  };
}

/**
 * Component health status
 */
export interface ComponentHealth {
  /** Component status */
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  
  /** Last successful operation */
  lastSuccess?: Date;
  
  /** Last error */
  lastError?: Date;
  
  /** Error count in current window */
  errorCount: number;
  
  /** Response time metrics */
  responseTime?: {
    avg: number;
    min: number;
    max: number;
  };
}

/**
 * Health issue
 */
export interface HealthIssue {
  /** Issue severity */
  severity: 'low' | 'medium' | 'high' | 'critical';
  
  /** Issue category */
  category: string;
  
  /** Issue description */
  description: string;
  
  /** Issue timestamp */
  timestamp: Date;
  
  /** Suggested resolution */
  resolution?: string;
}

// ============================================================================
// LIFECYCLE INTERFACES
// ============================================================================

/**
 * Component lifecycle interface
 */
export interface Lifecycle {
  /**
   * Initialize the component
   */
  initialize(): Promise<void>;
  
  /**
   * Start the component
   */
  start(): Promise<void>;
  
  /**
   * Stop the component
   */
  stop(): Promise<void>;
  
  /**
   * Cleanup resources
   */
  cleanup(): Promise<void>;
  
  /**
   * Get component status
   */
  getStatus(): ComponentStatus;
}

/**
 * Component status
 */
export interface ComponentStatus {
  /** Component name */
  name: string;
  
  /** Current state */
  state: 'initializing' | 'running' | 'stopping' | 'stopped' | 'error';
  
  /** Whether component is healthy */
  isHealthy: boolean;
  
  /** Last error */
  lastError?: Error;
  
  /** Uptime in milliseconds */
  uptime: number;
  
  /** Additional metadata */
  metadata: Record<string, any>;
}

// ============================================================================
// OBSERVER INTERFACES
// ============================================================================

/**
 * Observer interface for component events
 */
export interface Observer<T> {
  /**
   * Handle notification
   */
  notify(data: T): void | Promise<void>;
}

/**
 * Observable interface for components that emit events
 */
export interface Observable<T> {
  /**
   * Add observer
   */
  addObserver(observer: Observer<T>): void;
  
  /**
   * Remove observer
   */
  removeObserver(observer: Observer<T>): void;
  
  /**
   * Notify all observers
   */
  notifyObservers(data: T): Promise<void>;
}

// ============================================================================
// PLUGIN INTERFACES
// ============================================================================

/**
 * Plugin interface for extending system functionality
 */
export interface Plugin {
  /** Plugin name */
  readonly name: string;
  
  /** Plugin version */
  readonly version: string;
  
  /** Plugin dependencies */
  readonly dependencies: string[];
  
  /**
   * Initialize plugin
   */
  initialize(system: SystemContext): Promise<void>;
  
  /**
   * Cleanup plugin
   */
  cleanup(): Promise<void>;
  
  /**
   * Get plugin metadata
   */
  getMetadata(): PluginMetadata;
}

/**
 * Plugin metadata
 */
export interface PluginMetadata {
  /** Plugin name */
  name: string;
  
  /** Plugin version */
  version: string;
  
  /** Plugin description */
  description: string;
  
  /** Plugin author */
  author: string;
  
  /** Plugin dependencies */
  dependencies: string[];
  
  /** Plugin configuration schema */
  configSchema?: any;
}

/**
 * System context for plugins
 */
export interface SystemContext {
  /** System configuration */
  config: SystemConfig;
  
  /** Adapter registry */
  adapters: AdapterRegistry;
  
  /** Strategy registry */
  strategies: StrategyRegistry;
  
  /** Event bus */
  eventBus: any; // Will be defined when EventBus is implemented
  
  /** Logger */
  logger: any; // Will be defined when Logger is implemented
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/**
 * Make all properties optional recursively
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Make specific properties required
 */
export type RequireFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Omit properties recursively
 */
export type DeepOmit<T, K extends keyof any> = {
  [P in keyof T as P extends K ? never : P]: T[P] extends object 
    ? DeepOmit<T[P], K> 
    : T[P];
};

/**
 * Extract function return type
 */
export type ReturnTypeOf<T> = T extends (...args: any[]) => infer R ? R : never;

/**
 * Extract promise type
 */
export type PromiseType<T> = T extends Promise<infer U> ? U : T;

/**
 * Create a type with all properties as functions
 */
export type Functionalize<T> = {
  [K in keyof T]: () => T[K];
};

/**
 * Create a type with all properties as promises
 */
export type Promisify<T> = {
  [K in keyof T]: Promise<T[K]>;
};

/**
 * Union to intersection type
 */
export type UnionToIntersection<U> = 
  (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

/**
 * Branded type for type safety
 */
export type Brand<T, B> = T & { __brand: B };

/**
 * ID types for type safety
 */
export type RunnerId = Brand<string, 'RunnerId'>;
export type AdapterId = Brand<string, 'AdapterId'>;
export type StrategyId = Brand<string, 'StrategyId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type SymbolId = Brand<string, 'SymbolId'>;

/**
 * Timestamp type
 */
export type Timestamp = Brand<number, 'Timestamp'>;

/**
 * Price type
 */
export type Price = Brand<number, 'Price'>;

/**
 * Size type
 */
export type Size = Brand<number, 'Size'>;

/**
 * Percentage type (0-1)
 */
export type Percentage = Brand<number, 'Percentage'>;

// ============================================================================
// CONFIGURATION HELPERS
// ============================================================================

/**
 * Configuration builder interface
 */
export interface ConfigBuilder<T> {
  /**
   * Set a configuration value
   */
  set<K extends keyof T>(key: K, value: T[K]): ConfigBuilder<T>;
  
  /**
   * Merge configuration
   */
  merge(config: Partial<T>): ConfigBuilder<T>;
  
  /**
   * Build final configuration
   */
  build(): T;
  
  /**
   * Validate configuration
   */
  validate(): boolean;
  
  /**
   * Get validation errors
   */
  getErrors(): string[];
}

/**
 * Environment variable resolver
 */
export interface EnvResolver {
  /**
   * Resolve environment variable
   */
  resolve(key: string, defaultValue?: string): string | undefined;
  
  /**
   * Resolve required environment variable
   */
  resolveRequired(key: string): string;
  
  /**
   * Resolve boolean environment variable
   */
  resolveBoolean(key: string, defaultValue?: boolean): boolean;
  
  /**
   * Resolve number environment variable
   */
  resolveNumber(key: string, defaultValue?: number): number;
  
  /**
   * Resolve JSON environment variable
   */
  resolveJSON<T>(key: string, defaultValue?: T): T;
}