# GitHub Issue Template

> 아래 내용을 https://github.com/DataDog/dd-trace-js/issues/new 에 복사해서 등록

---

## Title

```
[BUG]: mysql2 instrumentation causes stack overflow with large prepared statement params
```

---

## Body

### Tracer Version(s)

5.28.0 (also tested on latest)

### Node.js Version(s)

v18.19.1

### Bug Report

After calling `connection.execute()` with a large number of parameters (~3,300+), the application crashes with `Maximum call stack size exceeded`.

**Stack Trace:**
```
RangeError: Maximum call stack size exceeded
    at AsyncResource.runInAsyncScope (node:async_hooks:197:18)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    ... (repeating pattern)
```

**Root Cause:**

In `packages/datadog-instrumentations/src/mysql2.js`, the `bindExecute` function re-wraps `onResult` on every `execute()` call:

```javascript
// Line 108-109
function bindExecute (cmd, execute, asyncResource) {
  return shimmer.wrapFunction(execute, execute => asyncResource.bind(function executeWithTrace (packet, connection) {
    if (this.onResult) {
      this.onResult = asyncResource.bind(this.onResult)  // BUG: Re-wraps every time!
    }
    return execute.apply(this, arguments)
  }, cmd))
}
```

MySQL's prepared statement protocol sends one packet per parameter definition. For 3,366 params, `Prepare.execute()` is called 3,369 times, nesting the callback 3,369 layers deep. When invoked, it triggers 3,369 synchronous `runInAsyncScope()` calls → Stack Overflow.

**Evidence:**
| Params | `execute()` calls | Result |
|--------|-------------------|--------|
| 3,060  | 3,063             | ✅ OK |
| 3,366  | 3,369             | ❌ Stack Overflow |

**Workaround:**

Pass an empty params array and inline values directly:
```javascript
// Instead of: connection.execute(query, params.flat(), callback)
const values = rows.map(r => `(${escape(r.col1)}, ...)`).join(',');
connection.execute(`INSERT ... VALUES ${values}`, [], callback);
```

**Suggested Fix:**

Only wrap `onResult` once:
```javascript
if (this.onResult && !this.onResult.__ddBound) {
  this.onResult = asyncResource.bind(this.onResult)
  this.onResult.__ddBound = true
}
```

Or move the wrapping to `addCommand` (wrap once, not per packet).

### Reproduction Repository

https://github.com/myeongseoklee/mysql2-callstack-reproduction

```bash
git clone https://github.com/myeongseoklee/mysql2-callstack-reproduction.git
cd mysql2-callstack-reproduction
npm install
npm run docker:up
npm run reproduce      # Triggers the error
npm run debug:wrap     # Shows execute() call count
npm run docker:down
```

### Environment

- **dd-trace**: 5.28.0
- **mysql2**: 3.11.4
- **Node.js**: 18.19.1
- **OS**: macOS

---

## Labels

`bug`, `mysql2`
