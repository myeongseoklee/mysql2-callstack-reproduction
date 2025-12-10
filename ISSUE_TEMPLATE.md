# dd-trace-js Bug Report

> https://github.com/DataDog/dd-trace-js/issues/new?template=bug_report.yaml 에서 등록

---

## Title (제목)
```
[BUG]: mysql2 instrumentation causes stack overflow with large prepared statement params
```

---

## 폼 필드별 입력 내용

### 1. Tracer Version(s) *
```
5.28.0
```

### 2. Node.js Version(s) *
```
18.19.1
```

### 3. Bug Report *
```
After calling `connection.execute()` with a large number of parameters (~3,300+), the application crashes with `Maximum call stack size exceeded`.

**Stack Trace:**

RangeError: Maximum call stack size exceeded
    at AsyncResource.runInAsyncScope (node:async_hooks:197:18)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    ... (repeating pattern)

**Root Cause:**

In `packages/datadog-instrumentations/src/mysql2.js`, the `bindExecute` function re-wraps `onResult` on every `execute()` call (Line 108-109):

The `onResult` callback gets wrapped with `asyncResource.bind()` on every packet. MySQL's prepared statement protocol sends one packet per parameter definition. For 3,366 params, `Prepare.execute()` is called 3,369 times, nesting the callback 3,369 layers deep.

**Evidence:**
- 3,060 params → 3,063 execute() calls → ✅ OK
- 3,366 params → 3,369 execute() calls → ❌ Stack Overflow

**Suggested Fix:**
Only wrap `onResult` once by checking if already wrapped, or move wrapping to `addCommand`.

**Reproduction Repository:**
https://github.com/myeongseoklee/mysql2-callstack-reproduction
```

### 4. Reproduction Code (optional)
```javascript
// Problematic pattern
const params = []; // 3,366+ params
connection.execute(
  `INSERT INTO table (...) VALUES (?, ?, ...), (?, ?, ...), ...`,
  params,
  callback
);

// Workaround: inline values, pass empty array
const values = rows.map(r => `(${escape(r.col1)}, ...)`).join(',');
connection.execute(`INSERT ... VALUES ${values}`, [], callback);
```

### 5. Error Logs (optional)
```
RangeError: Maximum call stack size exceeded
    at AsyncResource.runInAsyncScope (node:async_hooks:197:18)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
```

### 6. Tracer Config (optional)
```javascript
// init-tracer.cjs
const tracer = require('dd-trace');
tracer.init({
  service: 'mysql2-test',
  env: 'test',
  enabled: true,
});
```

### 7. Operating System (optional)
```
macOS (Darwin)
```

### 8. Bundling *
```
No Bundling
```

---

## 등록 링크
👉 https://github.com/DataDog/dd-trace-js/issues/new?template=bug_report.yaml
