/**
 * Property-based tests for EventBus message ordering
 * 
 * **Validates: Requirements 7.1, 7.2, 7.4, 7.5**
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { EventBus } from '../EventBus.js';
import { EventData } from '../../types/core.js';

describe('EventBus Property Tests', () => {
  describe('Property 7: Event-Driven Communication', () => {
    it('should deliver events in chronological order with causal consistency', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              type: fc.constantFrom('order', 'position', 'price'),
              payload: fc.record({
                id: fc.nat(20),
                value: fc.nat(100)
              })
            }),
            { minLength: 2, maxLength: 4 }
          ),
          async (eventSpecs) => {
            const eventBus = new EventBus({
              ordering: { enabled: true, strategy: 'timestamp' }
            });

            try {
              const receivedEvents: Array<{ 
                type: string; 
                payload: any; 
                timestamp: Date; 
              }> = [];
              
              const handler = vi.fn((data: EventData) => {
                receivedEvents.push({
                  type: data.type,
                  payload: data.payload,
                  timestamp: data.timestamp
                });
              });

              // Subscribe to all event types
              eventBus.subscribe('order', handler);
              eventBus.subscribe('position', handler);
              eventBus.subscribe('price', handler);

              // Emit events sequentially
              for (const spec of eventSpecs) {
                await eventBus.emit(spec.type, spec.payload);
                await new Promise(resolve => setTimeout(resolve, 1));
              }

              // Wait for processing
              await new Promise(resolve => setTimeout(resolve, 50));

              // Verify all events delivered
              expect(receivedEvents).toHaveLength(eventSpecs.length);

              // Verify chronological ordering
              for (let i = 1; i < receivedEvents.length; i++) {
                expect(receivedEvents[i - 1].timestamp.getTime()).toBeLessThanOrEqual(
                  receivedEvents[i].timestamp.getTime()
                );
              }

            } finally {
              await eventBus.shutdown();
            }
          }
        ),
        { numRuns: 3, timeout: 5000 }
      );
    }, 8000);

    it('should support multiple subscribers per event type without interference', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            subscriberCount: fc.integer({ min: 2, max: 3 }),
            eventCount: fc.integer({ min: 1, max: 2 })
          }),
          async ({ subscriberCount, eventCount }) => {
            const eventBus = new EventBus();

            try {
              const handlerCalls: number[] = new Array(subscriberCount).fill(0);
              
              // Create subscribers
              for (let i = 0; i < subscriberCount; i++) {
                const handler = vi.fn(() => {
                  handlerCalls[i]++;
                });
                eventBus.subscribe('test-event', handler);
              }

              // Emit events
              for (let i = 0; i < eventCount; i++) {
                await eventBus.emit('test-event', { id: i });
              }

              // Wait for processing
              await new Promise(resolve => setTimeout(resolve, 50));

              // Verify each subscriber received all events
              for (let i = 0; i < subscriberCount; i++) {
                expect(handlerCalls[i]).toBe(eventCount);
              }

            } finally {
              await eventBus.shutdown();
            }
          }
        ),
        { numRuns: 3, timeout: 3000 }
      );
    }, 6000);

    it('should handle subscriber priority ordering correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 2, maxLength: 3 }),
          async (priorities) => {
            const eventBus = new EventBus();

            try {
              const executionOrder: number[] = [];
              const uniquePriorities = [...new Set(priorities)].sort((a, b) => b - a);
              
              // Create subscribers with different priorities
              uniquePriorities.forEach(priority => {
                const handler = vi.fn(() => {
                  executionOrder.push(priority);
                });
                eventBus.subscribe('priority-test', handler, { priority });
              });

              // Emit event
              await eventBus.emit('priority-test', { test: 'data' });
              await new Promise(resolve => setTimeout(resolve, 30));

              // Verify priority ordering (highest first)
              expect(executionOrder).toHaveLength(uniquePriorities.length);
              for (let i = 0; i < executionOrder.length; i++) {
                expect(executionOrder[i]).toBe(uniquePriorities[i]);
              }

            } finally {
              await eventBus.shutdown();
            }
          }
        ),
        { numRuns: 3, timeout: 3000 }
      );
    }, 6000);

    it('should provide delivery guarantees with error resilience', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 4 }),
          async (totalEvents) => {
            // Ensure totalEvents is positive
            const safeEventCount = Math.max(2, Math.abs(totalEvents));
            
            const eventBus = new EventBus();

            try {
              const successfulDeliveries: number[] = [];
              
              // Reliable subscriber
              const reliableHandler = vi.fn((data: EventData) => {
                successfulDeliveries.push(data.payload.id);
              });
              eventBus.subscribe('resilience-test', reliableHandler);
              
              // Faulty subscriber
              const faultyHandler = vi.fn((data: EventData) => {
                if (data.payload.id % 2 === 0) {
                  throw new Error('Faulty subscriber error');
                }
              });
              eventBus.subscribe('resilience-test', faultyHandler);

              // Emit events
              for (let i = 0; i < safeEventCount; i++) {
                await eventBus.emit('resilience-test', { id: i });
              }

              await new Promise(resolve => setTimeout(resolve, 100));

              // Verify reliable subscriber received all events
              expect(successfulDeliveries).toHaveLength(safeEventCount);
              expect(successfulDeliveries.sort((a, b) => a - b)).toEqual(
                Array.from({ length: safeEventCount }, (_, i) => i)
              );

            } finally {
              await eventBus.shutdown();
            }
          }
        ),
        { numRuns: 3, timeout: 3000 }
      );
    }, 6000);

    it('should maintain event ordering under concurrent emissions', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            emissionGroups: fc.integer({ min: 2, max: 3 }),
            eventsPerGroup: fc.integer({ min: 1, max: 2 })
          }),
          async ({ emissionGroups, eventsPerGroup }) => {
            const eventBus = new EventBus({
              ordering: { enabled: true, strategy: 'timestamp' }
            });

            try {
              const receivedEvents: Array<{
                id: number;
                timestamp: Date;
              }> = [];
              
              const handler = vi.fn((data: EventData) => {
                receivedEvents.push({
                  id: data.payload.id,
                  timestamp: data.timestamp
                });
              });

              eventBus.subscribe('concurrent-test', handler);

              // Emit events concurrently
              const promises: Promise<void>[] = [];
              
              for (let group = 0; group < emissionGroups; group++) {
                const promise = (async () => {
                  for (let i = 0; i < eventsPerGroup; i++) {
                    await eventBus.emit('concurrent-test', {
                      id: group * eventsPerGroup + i
                    });
                    await new Promise(resolve => setTimeout(resolve, 1));
                  }
                })();
                promises.push(promise);
              }

              await Promise.all(promises);
              await new Promise(resolve => setTimeout(resolve, 100));

              const totalExpected = emissionGroups * eventsPerGroup;
              expect(receivedEvents).toHaveLength(totalExpected);

              // Verify chronological ordering
              for (let i = 1; i < receivedEvents.length; i++) {
                expect(receivedEvents[i - 1].timestamp.getTime()).toBeLessThanOrEqual(
                  receivedEvents[i].timestamp.getTime()
                );
              }

            } finally {
              await eventBus.shutdown();
            }
          }
        ),
        { numRuns: 2, timeout: 4000 }
      );
    }, 8000);
  });
});