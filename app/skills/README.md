# Skills

This folder is the stable home for Sanya's skills.

## Migration rule

The Telegram route stays the current source of truth until a skill is migrated deliberately.

- `legacy`: the capability already works, but its logic still lives outside the Skills runtime.
- `planned`: agreed roadmap item, not connected to production behavior yet.
- `native`: implemented through the Skills registry with its own handler.

## Safety rule

Adding metadata to the catalog must not change bot behavior.

A skill can become `native` only after:
1. its current behavior is documented;
2. its trigger/match rules are explicit;
3. its dependencies and cost profile are known;
4. preview deployment succeeds;
5. production behavior is checked after merge.

## Current native skill

`research` is the first native skill. It has its own trigger matching, mode selection, web search, source verification and synthesis.

## Next migration

After Research is stable in production, migrate existing capabilities one by one instead of rewriting the Telegram route wholesale.


## Product from photo

The product-from-photo skill reuses the proven Telegram photo analysis path before running shopping search and match filtering.
