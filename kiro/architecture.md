# DRIFT Architecture

Core Engine → Execution Layer → Exchange Adapter → Runner → UI

Principles:
- Strategy is isolated
- Execution handles order logic
- Adapter abstracts DEX
- Runner scales instances
- UI is decoupled

Modules:
- Strategy (signal generation)
- ExecutionEngine
- AdapterRegistry
- RunnerManager
- EventBus
