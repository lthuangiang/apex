/**
 * Configuration models for the modular architecture
 * 
 * This file defines all configuration interfaces and types used throughout
 * the system, including SystemConfig, AdapterConfig, StrategyConfig, and RunnerConfig.
 */

import { RiskLimits, FilterConfig, BotState } from './core.js';

// ============================================================================
// SYSTEM CONFIGURATION
// ============================================================================

/**
 * Top-level system configuration
 */
export interface SystemConfig {
  /** Exchange adapter configurations */
  adapters: Record<string, AdapterConfig>;
  
  /** Strategy configurations */
  strategies: Record<string, StrategyConfig>;
  
  /** Bot runner configurations */
  runners: RunnerConfig[];
  
  /** API server configuration */
  api: ApiConfig;
  
  /** Monitoring and observability configuration */
  monitoring: MonitoringConfig;
  
  /** Event bus configuration */
  eventBus?: EventBusConfig;
  
  /** Global risk management settings */
  globalRiskLimits?: RiskLimits;
  
  /** System-wide feature flags */
  features?: FeatureFlags;
}

// ============================================================================
// ADAPTER CONFIGURATION
// ============================================================================

/**
 * Exchange adapter configuration
 */
export interface AdapterConfig {
  /** Adapter type (e.g., 'decibel', 'sodex', 'dango') */
  type: string;
  
  /** Exchange credentials */
  credentials: AdapterCredentials;
  
  /** API endpoints */
  endpoints: AdapterEndpoints;
  
  /** Rate limiting configuration */
  limits: RateLimits;
  
  /** Supported features */
  features: string[];
  
  /** Connection settings */
  connection?: ConnectionConfig;
  
  /** Adapter-specific parameters */
  parameters?: Record<string, any>;
  
  /** Whether adapter is enabled */
  enabled: boolean;
}

/**
 * Adapter credentials
 */
export interface AdapterCredentials {
  /** API key */
  apiKey?: string;
  
  /** API secret */
  apiSecret?: string;
  
  /** Private key for blockchain-based exchanges */
  privateKey?: string;
  
  /** Subaccount identifier */
  subaccount?: string;
  
  /** Builder address for DEX protocols */
  builderAddress?: string;
  
  /** Gas station API key */
  gasStationApiKey?: string;
  
  /** Additional credential fields */
  [key: string]: string | undefined;
}

/**
 * Adapter API endpoints
 */
export interface AdapterEndpoints {
  /** REST API base URL */
  rest?: string;
  
  /** WebSocket API URL */
  websocket?: string;
  
  /** Testnet REST API URL */
  testnetRest?: string;
  
  /** Testnet WebSocket API URL */
  testnetWebsocket?: string;
  
  /** Additional endpoint URLs */
  [key: string]: string | undefined;
}

/**
 * Rate limiting configuration
 */
export interface RateLimits {
  /** Requests per second */
  requestsPerSecond: number;
  
  /** Requests per minute */
  requestsPerMinute: number;
  
  /** Requests per hour */
  requestsPerHour?: number;
  
  /** Burst limit */
  burstLimit?: number;
  
  /** Order-specific rate limits */
  orders?: {
    perSecond: number;
    perMinute: number;
  };
}

/**
 * Connection configuration
 */
export interface ConnectionConfig {
  /** Connection timeout in milliseconds */
  timeout: number;
  
  /** Retry configuration */
  retry: RetryConfig;
  
  /** Keep-alive settings */
  keepAlive?: {
    enabled: boolean;
    intervalMs: number;
  };
  
  /** Connection pool settings */
  pool?: {
    maxConnections: number;
    idleTimeoutMs: number;
  };
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum number of retries */
  maxRetries: number;
  
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  
  /** Backoff multiplier */
  backoffMultiplier: number;
  
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  
  /** Jitter factor (0-1) */
  jitter?: number;
}

// ============================================================================
// STRATEGY CONFIGURATION
// ============================================================================

/**
 * Strategy configuration (extended from core.ts)
 */
export interface StrategyConfig {
  /** Strategy type identifier */
  type: string;
  
  /** Strategy name */
  name: string;
  
  /** Strategy parameters */
  parameters: StrategyParameters;
  
  /** Risk limits for this strategy */
  riskLimits: RiskLimits;
  
  /** Strategy-specific filters */
  filters?: FilterConfig[];
  
  /** Cache settings */
  cache?: CacheConfig;
  
  /** Whether strategy is enabled */
  enabled: boolean;
  
  /** Strategy priority (higher = more important) */
  priority?: number;
}

/**
 * Strategy parameters
 */
export interface StrategyParameters {
  /** Minimum confidence threshold */
  minConfidence?: number;
  
  /** Signal generation interval in milliseconds */
  signalIntervalMs?: number;
  
  /** Lookback period for analysis */
  lookbackPeriod?: number;
  
  /** Technical indicator settings */
  indicators?: Record<string, any>;
  
  /** Strategy-specific thresholds */
  thresholds?: Record<string, number>;
  
  /** Additional parameters */
  [key: string]: any;
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  /** Whether caching is enabled */
  enabled: boolean;
  
  /** Cache TTL in milliseconds */
  ttlMs: number;
  
  /** Maximum cache size */
  maxSize?: number;
  
  /** Cache eviction policy */
  evictionPolicy?: 'LRU' | 'LFU' | 'TTL';
}

// ============================================================================
// RUNNER CONFIGURATION
// ============================================================================

/**
 * Bot runner configuration
 */
export interface RunnerConfig {
  /** Unique runner identifier */
  id?: string;
  
  /** Trading symbol */
  symbol: string;
  
  /** Exchange name */
  exchange: string;
  
  /** Strategy type to use */
  strategyType: string;
  
  /** Risk management limits */
  riskLimits: RiskLimits;
  
  /** Execution parameters */
  executionParams: ExecutionParams;
  
  /** Runner-specific settings */
  settings?: RunnerSettings;
  
  /** Whether runner is enabled */
  enabled: boolean;
  
  /** Runner priority */
  priority?: number;
}

/**
 * Execution parameters
 */
export interface ExecutionParams {
  /** Default order type */
  orderType: 'market' | 'limit';
  
  /** Default time in force */
  timeInForce: 'GTC' | 'IOC' | 'FOK' | 'post-only';
  
  /** Position sizing parameters */
  sizing: PositionSizingParams;
  
  /** Take profit settings */
  takeProfit?: TakeProfitParams;
  
  /** Stop loss settings */
  stopLoss?: StopLossParams;
  
  /** Execution timing settings */
  timing?: ExecutionTimingParams;
}

/**
 * Position sizing parameters
 */
export interface PositionSizingParams {
  /** Base position size */
  baseSize: number;
  
  /** Minimum position size */
  minSize: number;
  
  /** Maximum position size */
  maxSize: number;
  
  /** Size multiplier based on confidence */
  confidenceMultiplier?: number;
  
  /** Size multiplier based on volatility */
  volatilityMultiplier?: number;
  
  /** Maximum percentage of balance to use */
  maxBalancePercent: number;
}

/**
 * Take profit parameters
 */
export interface TakeProfitParams {
  /** Whether take profit is enabled */
  enabled: boolean;
  
  /** Take profit percentage */
  percentage?: number;
  
  /** Fixed take profit amount */
  fixedAmount?: number;
  
  /** Trailing take profit settings */
  trailing?: {
    enabled: boolean;
    percentage: number;
    activationThreshold: number;
  };
}

/**
 * Stop loss parameters
 */
export interface StopLossParams {
  /** Whether stop loss is enabled */
  enabled: boolean;
  
  /** Stop loss percentage */
  percentage?: number;
  
  /** Fixed stop loss amount */
  fixedAmount?: number;
  
  /** Trailing stop loss settings */
  trailing?: {
    enabled: boolean;
    percentage: number;
    activationThreshold: number;
  };
}

/**
 * Execution timing parameters
 */
export interface ExecutionTimingParams {
  /** Minimum hold time in milliseconds */
  minHoldTimeMs?: number;
  
  /** Maximum hold time in milliseconds */
  maxHoldTimeMs?: number;
  
  /** Cooldown period between trades in milliseconds */
  cooldownMs?: number;
  
  /** Entry timeout in milliseconds */
  entryTimeoutMs?: number;
  
  /** Exit timeout in milliseconds */
  exitTimeoutMs?: number;
}

/**
 * Runner-specific settings
 */
export interface RunnerSettings {
  /** Auto-restart on error */
  autoRestart?: boolean;
  
  /** Maximum restart attempts */
  maxRestarts?: number;
  
  /** Health check interval in milliseconds */
  healthCheckIntervalMs?: number;
  
  /** State persistence settings */
  persistence?: {
    enabled: boolean;
    intervalMs: number;
    path?: string;
  };
  
  /** Logging settings */
  logging?: {
    level: 'debug' | 'info' | 'warn' | 'error';
    includeMetadata: boolean;
  };
}

// ============================================================================
// API CONFIGURATION
// ============================================================================

/**
 * API server configuration
 */
export interface ApiConfig {
  /** Server port */
  port: number;
  
  /** Server host */
  host: string;
  
  /** Whether HTTPS is enabled */
  https?: boolean;
  
  /** SSL certificate configuration */
  ssl?: {
    certPath: string;
    keyPath: string;
  };
  
  /** CORS configuration */
  cors?: {
    enabled: boolean;
    origins: string[];
    methods: string[];
  };
  
  /** Authentication configuration */
  auth?: AuthConfig;
  
  /** Rate limiting for API endpoints */
  rateLimiting?: {
    enabled: boolean;
    windowMs: number;
    maxRequests: number;
  };
}

/**
 * Authentication configuration
 */
export interface AuthConfig {
  /** Whether authentication is enabled */
  enabled: boolean;
  
  /** JWT configuration */
  jwt?: {
    secret: string;
    expiresIn: string;
  };
  
  /** API key configuration */
  apiKey?: {
    enabled: boolean;
    keys: string[];
  };
  
  /** Basic auth configuration */
  basic?: {
    enabled: boolean;
    username: string;
    password: string;
  };
}

// ============================================================================
// MONITORING CONFIGURATION
// ============================================================================

/**
 * Monitoring and observability configuration
 */
export interface MonitoringConfig {
  /** Logging configuration */
  logging: LoggingConfig;
  
  /** Metrics configuration */
  metrics?: MetricsConfig;
  
  /** Alerting configuration */
  alerting?: AlertingConfig;
  
  /** Health check configuration */
  healthChecks?: HealthCheckConfig;
  
  /** Tracing configuration */
  tracing?: TracingConfig;
}

/**
 * Logging configuration
 */
export interface LoggingConfig {
  /** Log level */
  level: 'debug' | 'info' | 'warn' | 'error';
  
  /** Log format */
  format: 'json' | 'text';
  
  /** Log outputs */
  outputs: LogOutput[];
  
  /** Whether to include stack traces */
  includeStackTrace: boolean;
  
  /** Log rotation settings */
  rotation?: {
    enabled: boolean;
    maxSize: string;
    maxFiles: number;
  };
}

/**
 * Log output configuration
 */
export interface LogOutput {
  /** Output type */
  type: 'console' | 'file' | 'http';
  
  /** Output-specific configuration */
  config: Record<string, any>;
  
  /** Minimum log level for this output */
  minLevel?: string;
}

/**
 * Metrics configuration
 */
export interface MetricsConfig {
  /** Whether metrics collection is enabled */
  enabled: boolean;
  
  /** Metrics collection interval in milliseconds */
  intervalMs: number;
  
  /** Metrics storage backend */
  backend: 'memory' | 'prometheus' | 'influxdb';
  
  /** Backend-specific configuration */
  backendConfig?: Record<string, any>;
  
  /** Custom metrics definitions */
  customMetrics?: MetricDefinition[];
}

/**
 * Metric definition
 */
export interface MetricDefinition {
  /** Metric name */
  name: string;
  
  /** Metric type */
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  
  /** Metric description */
  description: string;
  
  /** Metric labels */
  labels?: string[];
}

/**
 * Alerting configuration
 */
export interface AlertingConfig {
  /** Whether alerting is enabled */
  enabled: boolean;
  
  /** Alert channels */
  channels: AlertChannel[];
  
  /** Alert rules */
  rules: AlertRule[];
  
  /** Alert throttling settings */
  throttling?: {
    enabled: boolean;
    windowMs: number;
    maxAlerts: number;
  };
}

/**
 * Alert channel configuration
 */
export interface AlertChannel {
  /** Channel name */
  name: string;
  
  /** Channel type */
  type: 'email' | 'slack' | 'telegram' | 'webhook';
  
  /** Channel configuration */
  config: Record<string, any>;
  
  /** Whether channel is enabled */
  enabled: boolean;
}

/**
 * Alert rule configuration
 */
export interface AlertRule {
  /** Rule name */
  name: string;
  
  /** Rule condition */
  condition: string;
  
  /** Alert severity */
  severity: 'low' | 'medium' | 'high' | 'critical';
  
  /** Alert message template */
  message: string;
  
  /** Target channels */
  channels: string[];
  
  /** Whether rule is enabled */
  enabled: boolean;
}

/**
 * Health check configuration
 */
export interface HealthCheckConfig {
  /** Whether health checks are enabled */
  enabled: boolean;
  
  /** Health check interval in milliseconds */
  intervalMs: number;
  
  /** Health check timeout in milliseconds */
  timeoutMs: number;
  
  /** Health check endpoints */
  endpoints: HealthCheckEndpoint[];
}

/**
 * Health check endpoint
 */
export interface HealthCheckEndpoint {
  /** Endpoint name */
  name: string;
  
  /** Check function */
  check: () => Promise<boolean>;
  
  /** Check timeout in milliseconds */
  timeoutMs?: number;
  
  /** Whether check is critical */
  critical: boolean;
}

/**
 * Tracing configuration
 */
export interface TracingConfig {
  /** Whether tracing is enabled */
  enabled: boolean;
  
  /** Tracing backend */
  backend: 'jaeger' | 'zipkin' | 'datadog';
  
  /** Backend configuration */
  backendConfig: Record<string, any>;
  
  /** Sampling rate (0-1) */
  samplingRate: number;
}

// ============================================================================
// EVENT BUS CONFIGURATION
// ============================================================================

/**
 * Event bus configuration
 */
export interface EventBusConfig {
  /** Maximum number of listeners per event */
  maxListeners: number;
  
  /** Event queue size */
  queueSize: number;
  
  /** Event processing timeout in milliseconds */
  timeoutMs: number;
  
  /** Whether to persist events */
  persistence?: {
    enabled: boolean;
    backend: 'memory' | 'redis' | 'file';
    config: Record<string, any>;
  };
  
  /** Event ordering guarantees */
  ordering?: {
    enabled: boolean;
    strategy: 'fifo' | 'priority' | 'timestamp';
  };
}

// ============================================================================
// FEATURE FLAGS
// ============================================================================

/**
 * System feature flags
 */
export interface FeatureFlags {
  /** Enable multi-runner support */
  multiRunner?: boolean;
  
  /** Enable hot configuration reloading */
  hotReload?: boolean;
  
  /** Enable advanced risk management */
  advancedRisk?: boolean;
  
  /** Enable performance monitoring */
  performanceMonitoring?: boolean;
  
  /** Enable experimental features */
  experimental?: boolean;
  
  /** Custom feature flags */
  [key: string]: boolean | undefined;
}

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
  /** Whether configuration is valid */
  isValid: boolean;
  
  /** Validation errors */
  errors: ConfigValidationError[];
  
  /** Validation warnings */
  warnings: ConfigValidationWarning[];
}

/**
 * Configuration validation error
 */
export interface ConfigValidationError {
  /** Error path */
  path: string;
  
  /** Error message */
  message: string;
  
  /** Error code */
  code: string;
  
  /** Suggested fix */
  suggestion?: string;
}

/**
 * Configuration validation warning
 */
export interface ConfigValidationWarning {
  /** Warning path */
  path: string;
  
  /** Warning message */
  message: string;
  
  /** Warning code */
  code: string;
  
  /** Suggested improvement */
  suggestion?: string;
}