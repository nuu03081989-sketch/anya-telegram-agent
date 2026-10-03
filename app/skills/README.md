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

## Next migration

The next new native skill is planned to be `research`.
