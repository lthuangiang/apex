/**
 * EventBus implementation for modular architecture
 * 
 * Provides event-driven communication between components with ordering guarantees,
 * multiple subscribers support, and delivery reliability.
 */

import { EventEmitter } from 'events';
import { 
  EventData, 
  EventHandler, 
  EventSubscription 
} from '../types/core.js';
import { 
  EventBusConfig 
} from '../types/config.js';
import { 
  EventBusError, 
  EventDeliveryError, 
  EventTimeoutError 
} from '../types/errors.js';

/**
 * Event queue item for ordered processing
 */
interface QueuedEvent {
  id: string;
  data: EventData;
  timestamp: number;
  priority: number;
  retryCount: number;
}

/**
 * Subscriber information
 */
interface Subscriber {
  id: string;
  handler: EventHandler;
  options: {
    once?: boolean;
    priority?: number;
    timeout?: number;
  };
  createdAt: Date;
  callCount: number;
  lastCalled?: Date;
  errors: number;
}

/**
 * EventBus class implementing pub/sub with ordering guarantees
 */
export class EventBus {
  private emitter: EventEmitter;
  private subscribers: Map<string, Map<string, Subscriber>>;
  private eventQueue: QueuedEvent[];
  private processing: boolean;
  private config: EventBusConfig;
  private eventIdCounter: number;
  private metrics: EventBusMetrics;

  constructor(config?: Partial<EventBusConfig>) {
    this.emitter = new EventEmitter();
    this.subscribers = new Map();
    this.eventQueue = [];
    this.processing = false;
    this.eventIdCounter = 0;
    this.metrics = {
      eventsEmitted: 0,
      eventsProcessed: 0,
      eventsQueued: 0,
      deliveryFailures: 0,
      timeouts: 0,
      subscriberCount: 0
    };

    // Default configuration
    this.config = {
      maxListeners: 100,
      queueSize: 10000,
      timeoutMs: 5000,
      ordering: {
        enabled: true,
        strategy: 'timestamp'
      },
      ...config
    };

    // Set max listeners to prevent memory leak warnings
    this.emitter.setMaxListeners(this.config.maxListeners);

    // Start event processing
    this.startProcessing();
  }

  /**
   * Emit an event to all subscribers
   */
  async emit(eventType: string, payload: any, source: string = 'unknown'): Promise<void> {
    const eventData: EventData = {
      type: eventType,
      payload,
      timestamp: new Date(),
      source,
      metadata: {
        id: this.generateEventId(),
        version: '1.0'
      }
    };

    this.metrics.eventsEmitted++;

    // If ordering is disabled, emit immediately
    if (!this.config.ordering?.enabled) {
      await this.processEventImmediate(eventData);
      return;
    }

    // Queue event for ordered processing
    const queuedEvent: QueuedEvent = {
      id: eventData.metadata!.id,
      data: eventData,
      timestamp: eventData.timestamp.getTime(),
      priority: 0, // Default priority
      retryCount: 0
    };

    await this.queueEvent(queuedEvent);
  }

  /**
   * Subscribe to an event type
   */
  subscribe(
    eventType: string, 
    handler: EventHandler, 
    options: { once?: boolean; priority?: number; timeout?: number } = {}
  ): EventSubscription {
    const subscriberId = this.generateSubscriberId();
    
    const subscriber: Subscriber = {
      id: subscriberId,
      handler,
      options,
      createdAt: new Date(),
      callCount: 0,
      errors: 0
    };

    // Initialize event type map if it doesn't exist
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Map());
    }

    // Add subscriber
    this.subscribers.get(eventType)!.set(subscriberId, subscriber);
    this.metrics.subscriberCount++;

    const subscription: EventSubscription = {
      id: subscriberId,
      eventType,
      handler,
      options
    };

    return subscription;
  }

  /**
   * Unsubscribe from an event type
   */
  unsubscribe(subscription: EventSubscription): boolean {
    const eventSubscribers = this.subscribers.get(subscription.eventType);
    if (!eventSubscribers) {
      return false;
    }

    const removed = eventSubscribers.delete(subscription.id);
    if (removed) {
      this.metrics.subscriberCount--;
      
      // Clean up empty event type maps
      if (eventSubscribers.size === 0) {
        this.subscribers.delete(subscription.eventType);
      }
    }

    return removed;
  }

  /**
   * Unsubscribe all handlers for an event type
   */
  unsubscribeAll(eventType: string): number {
    const eventSubscribers = this.subscribers.get(eventType);
    if (!eventSubscribers) {
      return 0;
    }

    const count = eventSubscribers.size;
    this.metrics.subscriberCount -= count;
    this.subscribers.delete(eventType);

    return count;
  }

  /**
   * Get all subscribers for an event type
   */
  getSubscribers(eventType: string): EventSubscription[] {
    const eventSubscribers = this.subscribers.get(eventType);
    if (!eventSubscribers) {
      return [];
    }

    return Array.from(eventSubscribers.values()).map(subscriber => ({
      id: subscriber.id,
      eventType,
      handler: subscriber.handler,
      options: subscriber.options
    }));
  }

  /**
   * Get event bus metrics
   */
  getMetrics(): EventBusMetrics {
    return {
      ...this.metrics,
      queueLength: this.eventQueue.length,
      subscribersByType: this.getSubscribersByType()
    };
  }

  /**
   * Clear all subscribers and queued events
   */
  clear(): void {
    this.subscribers.clear();
    this.eventQueue = [];
    this.metrics = {
      eventsEmitted: 0,
      eventsProcessed: 0,
      eventsQueued: 0,
      deliveryFailures: 0,
      timeouts: 0,
      subscriberCount: 0
    };
  }

  /**
   * Shutdown the event bus
   */
  async shutdown(): Promise<void> {
    this.processing = false;
    
    // Wait for current processing to complete with timeout
    const maxWaitTime = 1000; // 1 second max wait
    const startTime = Date.now();
    
    while (this.eventQueue.length > 0 && (Date.now() - startTime) < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this.clear();
    this.emitter.removeAllListeners();
  }

  /**
   * Queue an event for ordered processing
   */
  private async queueEvent(event: QueuedEvent): Promise<void> {
    // Check queue size limit
    if (this.eventQueue.length >= this.config.queueSize) {
      throw new EventBusError(
        `Event queue full (${this.config.queueSize} events)`,
        { eventType: event.data.type, queueSize: this.eventQueue.length }
      );
    }

    // Insert event in correct position based on ordering strategy
    this.insertEventOrdered(event);
    this.metrics.eventsQueued++;
  }

  /**
   * Insert event in queue maintaining order
   */
  private insertEventOrdered(event: QueuedEvent): void {
    const strategy = this.config.ordering?.strategy || 'timestamp';
    
    switch (strategy) {
      case 'fifo':
        this.eventQueue.push(event);
        break;
        
      case 'priority':
        // Insert based on priority (higher priority first)
        let insertIndex = this.eventQueue.length;
        for (let i = 0; i < this.eventQueue.length; i++) {
          if (this.eventQueue[i].priority < event.priority) {
            insertIndex = i;
            break;
          }
        }
        this.eventQueue.splice(insertIndex, 0, event);
        break;
        
      case 'timestamp':
      default:
        // Insert based on timestamp (chronological order)
        let timestampIndex = this.eventQueue.length;
        for (let i = 0; i < this.eventQueue.length; i++) {
          if (this.eventQueue[i].timestamp > event.timestamp) {
            timestampIndex = i;
            break;
          }
        }
        this.eventQueue.splice(timestampIndex, 0, event);
        break;
    }
  }

  /**
   * Start event processing loop
   */
  private startProcessing(): void {
    this.processing = true;
    this.processEventQueue();
  }

  /**
   * Process events from the queue
   */
  private async processEventQueue(): Promise<void> {
    while (this.processing) {
      if (this.eventQueue.length === 0) {
        // Wait a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 10));
        continue;
      }

      const event = this.eventQueue.shift()!;
      try {
        await this.processEvent(event);
        this.metrics.eventsProcessed++;
      } catch (error) {
        // Handle processing error
        await this.handleProcessingError(event, error as Error);
      }
    }
  }

  /**
   * Process a single event
   */
  private async processEvent(queuedEvent: QueuedEvent): Promise<void> {
    const { data } = queuedEvent;
    const eventSubscribers = this.subscribers.get(data.type);
    
    if (!eventSubscribers || eventSubscribers.size === 0) {
      // No subscribers for this event type
      return;
    }

    // Sort subscribers by priority (higher priority first)
    const sortedSubscribers = Array.from(eventSubscribers.values())
      .sort((a, b) => (b.options.priority || 0) - (a.options.priority || 0));

    // Deliver to all subscribers
    const deliveryPromises = sortedSubscribers.map(subscriber => 
      this.deliverToSubscriber(subscriber, data)
    );

    await Promise.allSettled(deliveryPromises);
  }

  /**
   * Process event immediately (bypass queue)
   */
  private async processEventImmediate(data: EventData): Promise<void> {
    const eventSubscribers = this.subscribers.get(data.type);
    
    if (!eventSubscribers || eventSubscribers.size === 0) {
      return;
    }

    const sortedSubscribers = Array.from(eventSubscribers.values())
      .sort((a, b) => (b.options.priority || 0) - (a.options.priority || 0));

    const deliveryPromises = sortedSubscribers.map(subscriber => 
      this.deliverToSubscriber(subscriber, data)
    );

    await Promise.allSettled(deliveryPromises);
    this.metrics.eventsProcessed++;
  }

  /**
   * Deliver event to a specific subscriber
   */
  private async deliverToSubscriber(subscriber: Subscriber, data: EventData): Promise<void> {
    const timeout = subscriber.options.timeout || this.config.timeoutMs;
    
    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new EventTimeoutError(data.type, timeout));
        }, timeout);
      });

      // Execute handler with timeout
      const handlerPromise = Promise.resolve(subscriber.handler(data));
      await Promise.race([handlerPromise, timeoutPromise]);

      // Update subscriber stats
      subscriber.callCount++;
      subscriber.lastCalled = new Date();

      // Remove one-time subscribers
      if (subscriber.options.once) {
        const eventSubscribers = this.subscribers.get(data.type);
        if (eventSubscribers) {
          eventSubscribers.delete(subscriber.id);
          this.metrics.subscriberCount--;
        }
      }

    } catch (error) {
      subscriber.errors++;
      this.metrics.deliveryFailures++;

      if (error instanceof EventTimeoutError) {
        this.metrics.timeouts++;
      }

      throw new EventDeliveryError(
        data.type,
        subscriber.id,
        error instanceof Error ? error.message : 'Unknown error',
        { 
          subscriberId: subscriber.id,
          eventId: data.metadata?.id,
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  /**
   * Handle event processing errors
   */
  private async handleProcessingError(event: QueuedEvent, error: Error): Promise<void> {
    event.retryCount++;
    
    // Retry logic (simple exponential backoff)
    const maxRetries = 3;
    if (event.retryCount <= maxRetries && this.processing) {
      // Add back to queue with delay
      setTimeout(() => {
        if (this.processing) {
          this.eventQueue.unshift(event);
        }
      }, Math.pow(2, event.retryCount) * 100);
    } else {
      // Max retries exceeded, log error and drop event
      console.error(`Event processing failed after ${maxRetries} retries:`, {
        eventType: event.data.type,
        eventId: event.id,
        error: error.message
      });
    }
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    return `evt_${Date.now()}_${++this.eventIdCounter}`;
  }

  /**
   * Generate unique subscriber ID
   */
  private generateSubscriberId(): string {
    return `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get subscriber count by event type
   */
  private getSubscribersByType(): Record<string, number> {
    const result: Record<string, number> = {};
    
    for (const [eventType, subscribers] of this.subscribers.entries()) {
      result[eventType] = subscribers.size;
    }
    
    return result;
  }
}

/**
 * EventBus metrics interface
 */
export interface EventBusMetrics {
  eventsEmitted: number;
  eventsProcessed: number;
  eventsQueued: number;
  deliveryFailures: number;
  timeouts: number;
  subscriberCount: number;
  queueLength?: number;
  subscribersByType?: Record<string, number>;
}

/**
 * Default EventBus instance
 */
export const defaultEventBus = new EventBus();