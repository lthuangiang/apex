/**
 * Core module exports
 * 
 * This file exports all core components including the AdapterRegistry,
 * EventBus, and factory implementations.
 */

// Core components
export { AdapterRegistry } from './AdapterRegistry.js';
export type { AdapterRegistryEvents, AdapterInstance } from './AdapterRegistry.js';

// EventBus (if it exists)
export { EventBus } from './EventBus.js';

// Factory exports
export * from './factories/index.js';

// Re-export core types
export * from '../types/core.js';
export * from '../types/config.js';
export * from '../types/utils.js';