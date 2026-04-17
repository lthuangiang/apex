Context:
You are working on DRIFT — a modular Web3 trading infrastructure.

You MUST follow:
- system.md (core principles)
- architecture.md (system design)
- patterns/* (implementation rules)
- lessons.md (accumulated knowledge)

Before coding:
- Read all provided files
- Apply lessons learned

---

Objective:
Refactor the system into a modular, scalable architecture that:

- Decouples strategy, execution, exchange
- Supports multi-DEX adapters (plug & play)
- Supports multi-runner scaling
- Prepares clean API for UI

---

Workflow (MANDATORY):

You must follow this loop:

1. Plan
   - Break down the task into modules
   - Identify risks and coupling points

2. Code
   - Implement using interface-based design
   - Follow adapter and runner patterns

3. Self-Review
   - Check against architecture.md and patterns
   - Identify violations or tight coupling

4. Fix
   - Refactor code to resolve issues
   - Improve modularity and extensibility

5. Lessons
   - Extract 2–5 key lessons from this task
   - Append them to lessons.md in this format:

   Example:
   ---
   Lesson:
   Avoid direct dependency between Strategy and Adapter.

   Reason:
   It breaks extensibility when adding new DEX.

   ---

---

Requirements:

## Core Refactor
- Extract:
  - IStrategy
  - IExecutionEngine
  - IExchangeAdapter
  - IStateMachine

- Enforce:
  - Strategy NEVER calls Adapter
  - ExecutionEngine is the only bridge

---

## Adapter System
- Implement AdapterRegistry
- Refactor existing DEX integrations into adapters

---

## Runner System
- Implement BotRunner
- Implement RunnerManager (multi-instance support)

---

## Event System (optional but preferred)
- Use EventBus for decoupling

---

## UI Preparation
- Provide REST + SSE/WebSocket layer
- Keep UI fully decoupled

---

Constraints:

- Do NOT break existing logic
- Maintain backward compatibility
- Code must be modular and extensible

---

Output:

1. Code structure (folders + modules)
2. Key interfaces
3. Example:
   - 1 Adapter
   - 1 Runner
4. Explanation:
   - What changed
   - Why it improves scalability

---

Self-Review Checklist (MANDATORY):

- Any direct coupling between strategy and exchange?
- Can a new DEX be added without touching core?
- Can system scale to multiple runners?
- Any shared mutable state?

If any answer is YES → refactor again.

---

Final Step:

Append new lessons to lessons.md.
Ensure lessons are concise, reusable, and improve future tasks.

---

Think like a system architect, not just a coder.