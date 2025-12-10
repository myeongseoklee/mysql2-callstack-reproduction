# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Proof-of-concept repository demonstrating a `Maximum call stack size exceeded` error when using MySQL2 with dd-trace. The error occurs when executing bulk inserts with large parameter arrays (~3,366+ params).

## Commands

```bash
npm run docker:up    # Start MySQL 8.0 container (port 13306)
npm run docker:down  # Stop and remove container
npm run reproduce    # Run the error reproduction script
```

## Architecture

- **ESM with CommonJS dd-trace init**: dd-trace must be loaded via `--require ./init-tracer.cjs` before ESM modules
- **Entry point**: `src/reproduce.ts` - streams test data through batching and insert transforms
- **Utils**: `src/utils/db.ts` (connection pool, table creation), `src/utils/data-generator.ts` (test row generation)

## Bug Details

- **Trigger**: Passing large flattened parameter arrays to `connection.execute(query, params.flat(), callback)`
- **Root cause**: dd-trace wraps callbacks with `AsyncResource.runInAsyncScope`, causing recursive call stack growth with many parameters
- **Threshold**: ~33 rows × 102 columns = 3,366 params
- **Workaround**: Escape values directly into SQL string and pass empty params array
