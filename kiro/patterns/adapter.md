# Adapter Pattern

All exchanges must implement IExchangeAdapter.

Do:
- Isolate API logic
- Handle signing internally

Don't:
- Leak exchange-specific fields
- Call adapter directly from strategy
