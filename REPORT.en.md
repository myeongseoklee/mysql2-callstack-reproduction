# dd-trace + mysql2 Maximum Call Stack Size Exceeded Bug Analysis Report

> **한글 버전**: [REPORT.md](./REPORT.md)

## Summary

We discovered and analyzed a bug that causes `Maximum call stack size exceeded` error when calling `execute()` with a large params array using `dd-trace@5.28.0` and `mysql2@3.x`.

**Conclusion**: This is a **bug** in dd-trace's mysql2 instrumentation code where the `onResult` callback is re-wrapped on every packet, causing synchronous recursion when the callback is invoked.

---

## 1. Error Conditions

| Item | Value |
|------|-------|
| Threshold | **~3,300-3,400 params** |
| Example | 33 rows × 102 columns = 3,366 params |
| dd-trace version | 5.28.0 |
| mysql2 version | 3.x |
| Node.js | 18+ |

### Reproduction Conditions
- dd-trace is enabled
- Using `connection.execute(query, params, callback)`
- params array size exceeds ~3,300

---

## 2. Stack Trace

```
RangeError: Maximum call stack size exceeded
    at AsyncResource.runInAsyncScope (node:async_hooks:197:18)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    ... (repeating)
```

Pattern: `runInAsyncScope` ↔ `Prepare.bound` alternating

---

## 3. Root Cause Analysis

### 3.1 MySQL2's Prepared Statement Handling

When `connection.execute(sql, params, callback)` is called:

1. mysql2 creates a `Prepare` command
2. Sends PREPARE request to MySQL server
3. **Server sends a definition packet for each parameter** (as many as params count!)
4. mysql2 calls `Prepare.execute()` for each packet (state machine pattern)

```
Params count: 3,366
Prepare.execute() call count: 3,369 (params + 3)
```

### 3.2 The Problematic Code in dd-trace

**File**: `dd-trace/packages/datadog-instrumentations/src/mysql2.js`

```javascript
// Line 106-114
function bindExecute (cmd, execute, asyncResource) {
  return shimmer.wrapFunction(execute, execute => asyncResource.bind(function executeWithTrace (packet, connection) {
    if (this.onResult) {
      this.onResult = asyncResource.bind(this.onResult)  // 🔥 BUG: Re-wraps every time!
    }

    return execute.apply(this, arguments)
  }, cmd))
}
```

### 3.3 Bug Mechanism

```
[Packet 1] execute() → onResult = bind(callback)
[Packet 2] execute() → onResult = bind(bind(callback))
[Packet 3] execute() → onResult = bind(bind(bind(callback)))
...
[Packet 3369] execute() → onResult = bind(bind(...bind(callback)...))  // 3,369 layers!
```

When callback is invoked:
```
runInAsyncScope()
  → bound callback
    → runInAsyncScope()
      → bound callback
        → ... (3,369 repetitions)
          → Stack Overflow!
```

### 3.4 Experimental Results

| Rows | Params | execute() calls | Result |
|------|--------|-----------------|--------|
| 10   | 1,020  | 1,023           | ✅ Success |
| 20   | 2,040  | 2,043           | ✅ Success |
| 30   | 3,060  | 3,063           | ✅ Success |
| 33   | 3,366  | 3,369           | ❌ Stack Overflow |

---

## 4. Why Stack Overflow with Low Async Depth?

```
Measured Async Depth: max 12
Call Stack Overflow: Occurs
```

Reason: **Synchronous callback nesting, not asynchronous depth**

- `asyncResource.bind(fn)` returns a function that wraps `fn` with `runInAsyncScope()`
- When executing the 3,369-layer nested callback, each `runInAsyncScope()` **synchronously** calls the next layer
- Since it's synchronous, the call stack accumulates without being released → Stack Overflow

---

## 5. Solutions

### 5.1 Application Level (Workaround)

```typescript
// ❌ Causes error
connection.execute(
  `INSERT INTO table (col1, col2, ...) VALUES (?, ?, ...), (?, ?, ...), ...`,
  params.flat(),  // 3,000+ params
  callback
);

// ✅ Solution: Inline values directly and pass empty params array
const values = rows
  .map(r => `(${Object.values(r).map(v => escape(v)).join(',')})`)
  .join(',');

connection.execute(
  `INSERT INTO table (col1, col2, ...) VALUES ${values}`,
  [],  // Empty array → Minimizes Prepare packets
  callback
);
```

### 5.2 Proposed dd-trace Fix

**Option 1: Check if already wrapped**
```javascript
function bindExecute (cmd, execute, asyncResource) {
  return shimmer.wrapFunction(execute, execute => asyncResource.bind(function executeWithTrace (packet, connection) {
    // Skip if already wrapped
    if (this.onResult && !this.onResult.__ddBound) {
      this.onResult = asyncResource.bind(this.onResult)
      this.onResult.__ddBound = true
    }

    return execute.apply(this, arguments)
  }, cmd))
}
```

**Option 2: Wrap only once in addCommand**
```javascript
shimmer.wrap(Connection.prototype, 'addCommand', addCommand => function (cmd) {
  // ...

  // Wrap only once here, not inside execute
  if (cmd.onResult) {
    cmd.onResult = asyncResource.bind(cmd.onResult)
  }

  cmd.execute = isQuery
    ? wrapExecute(cmd, cmd.execute, asyncResource, this.config)
    : bindExecuteWithoutCallbackWrap(cmd, cmd.execute, asyncResource)  // Remove callback wrapping

  return asyncResource.bind(addCommand, this).apply(this, arguments)
})
```

---

## 6. Impact Scope

### Affected Cases
- Node.js applications using dd-trace for APM monitoring
- Using mysql2's `execute()` (prepared statement)
- Large bulk inserts (params > ~3,300)

### Unaffected Cases
- Not using dd-trace
- Using mysql2's `query()` (not prepared statement)
- Small number of params

---

## 7. Reproduction Project

GitHub: https://github.com/myeongseoklee/mysql2-callstack-reproduction

```bash
git clone https://github.com/myeongseoklee/mysql2-callstack-reproduction.git
cd mysql2-callstack-reproduction
npm install
npm run docker:up
npm run reproduce      # Reproduce error
npm run docker:down
```

---

## 8. References

- [dd-trace-js GitHub](https://github.com/DataDog/dd-trace-js)
- [mysql2 GitHub](https://github.com/sidorares/node-mysql2)
- [Node.js AsyncResource Documentation](https://nodejs.org/api/async_hooks.html#class-asyncresource)

---

## 9. Conclusion

This bug is a design flaw in dd-trace's mysql2 instrumentation where the `onResult` callback is **re-wrapped on every packet**.

Due to MySQL's prepared statement protocol characteristics, the server sends separate packets for each parameter, and dd-trace's failure to account for this causes callback nesting with large params.

**Recommended Actions**:
1. Apply workaround in application (inline values directly)
2. Submit bug report to dd-trace GitHub
3. Update after dd-trace bug fix
