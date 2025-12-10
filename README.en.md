# MySQL2 + dd-trace Call Stack Overflow Reproduction

Reproduction project for `Maximum call stack size exceeded` error when using `mysql2` with `dd-trace`.

> **한글 버전**: [README.md](./README.md)

## The Bug

When calling `connection.execute()` with a large params array (~3,300+) while dd-trace instruments mysql2, a stack overflow occurs.

```
RangeError: Maximum call stack size exceeded
    at AsyncResource.runInAsyncScope (node:async_hooks:197:18)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    ...
```

## Root Cause

**Bug in dd-trace's mysql2 instrumentation** (`dd-trace/packages/datadog-instrumentations/src/mysql2.js`):

```javascript
// Line 108-109 - Called on EVERY packet!
if (this.onResult) {
  this.onResult = asyncResource.bind(this.onResult)  // Re-wraps callback each time
}
```

MySQL's prepared statement protocol sends one packet per parameter. For 3,366 params, `execute()` is called 3,369 times, creating a callback nested 3,369 layers deep. When invoked, it triggers 3,369 synchronous `runInAsyncScope()` calls → Stack Overflow.

**See [REPORT.en.md](./REPORT.en.md) for detailed analysis.**

## Threshold

| Rows | Params | `execute()` calls | Result |
|------|--------|-------------------|--------|
| 30   | 3,060  | 3,063             | ✅ OK |
| 33   | 3,366  | 3,369             | ❌ Stack Overflow |

## Environment

- **dd-trace**: 5.28.0
- **mysql2**: 3.x
- **Node.js**: 18+

## Quick Start

```bash
# Clone and install
git clone https://github.com/myeongseoklee/mysql2-callstack-reproduction.git
cd mysql2-callstack-reproduction
npm install

# Start MySQL
npm run docker:up

# Reproduce the error
npm run reproduce

# Cleanup
npm run docker:down
```

## Fix Verification

Apply patch and test:
```bash
# Apply patch
patch -p1 -d node_modules/dd-trace < FIX.patch

# Test (should succeed without error)
npm run reproduce
```

## Workaround

```typescript
// ❌ Causes stack overflow with large params
connection.execute(query, params.flat(), callback);

// ✅ Solution: Inline values, pass empty params array
const values = rows
  .map(r => `(${Object.values(r).map(v => escape(v)).join(',')})`)
  .join(',');
connection.execute(`INSERT ... VALUES ${values}`, [], callback);
```

## Related Links

- **Issue**: https://github.com/DataDog/dd-trace-js/issues/7074
- **PR**: https://github.com/DataDog/dd-trace-js/pull/7075

## Project Structure

```
├── src/
│   ├── reproduce.ts           # Main reproduction script
│   ├── debug-wrap-count.ts    # execute() call count tracking (bug proof)
│   └── utils/
│       ├── db.ts              # Database utilities
│       └── data-generator.ts  # Test data generation
├── init-tracer.cjs            # dd-trace initialization
├── docker-compose.yml         # MySQL 8.0
├── FIX.patch                  # Patch file for fix verification
├── REPORT.md                  # Detailed analysis report (Korean)
└── REPORT.en.md               # Detailed analysis report (English)
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run reproduce` | Reproduce the stack overflow error |
| `npm run debug:wrap` | Check `execute()` call count (bug proof) |
| `npm run docker:up` | Start MySQL container |
| `npm run docker:down` | Stop MySQL container |

## License

MIT
