# dd-trace-js Pull Request Template

> PR 제출 시 아래 내용 사용

---

## Title (제목)
```
fix(mysql2): prevent onResult callback from being re-wrapped on every packet
```

---

## Body (본문)

### What does this PR do?

Fixes a bug in mysql2 instrumentation where `onResult` callback is re-wrapped with `asyncResource.bind()` on every `execute()` call, causing stack overflow with large prepared statement params.

**The Problem:**
```javascript
// packages/datadog-instrumentations/src/mysql2.js (Line 108-109)
function bindExecute (cmd, execute, asyncResource) {
  return shimmer.wrapFunction(execute, execute => asyncResource.bind(function executeWithTrace (packet, connection) {
    if (this.onResult) {
      this.onResult = asyncResource.bind(this.onResult)  // BUG: Re-wraps every time!
    }
    return execute.apply(this, arguments)
  }, cmd))
}
```

MySQL's prepared statement protocol sends one packet per parameter definition. For queries with 3,366+ params, `execute()` is called 3,369 times, nesting the callback 3,369 layers deep → Stack Overflow.

**The Fix:**
```javascript
function bindExecute (cmd, execute, asyncResource) {
  return shimmer.wrapFunction(execute, execute => asyncResource.bind(function executeWithTrace (packet, connection) {
    if (this.onResult && !this.onResult._ddBound) {
      this.onResult = asyncResource.bind(this.onResult)
      this.onResult._ddBound = true
    }
    return execute.apply(this, arguments)
  }, cmd))
}
```

### Motivation

- Issue: #7074
- Production apps using bulk inserts with 3,300+ params crash with `Maximum call stack size exceeded`
- Similar pattern to #6985 (aws-sdk infinite recursion fix)

**Reproduction Repository:** https://github.com/myeongseoklee/mysql2-callstack-reproduction

```bash
git clone https://github.com/myeongseoklee/mysql2-callstack-reproduction.git
cd mysql2-callstack-reproduction
npm install && npm run docker:up
npm run reproduce      # Before fix: crashes
npm run debug:wrap     # Shows 3,369 execute() calls for 3,366 params
```

### Plugin Checklist

- [x] Unit tests.
- [x] Integration tests.
- [ ] Benchmarks.
- [ ] TypeScript [definitions][1].
- [ ] TypeScript [tests][2].
- [ ] API [documentation][3].
- [ ] CI [jobs/workflows][4].

[1]: https://github.com/DataDog/dd-trace-js/blob/master/index.d.ts
[2]: https://github.com/DataDog/dd-trace-js/blob/master/docs/test.ts
[3]: https://github.com/DataDog/documentation/blob/master/content/en/tracing/trace_collection/library_config/nodejs.md
[4]: https://github.com/DataDog/dd-trace-js/blob/master/.github/workflows/plugins.yml

### Additional Notes

**Evidence:**
| Params | `execute()` calls | Before Fix | After Fix |
|--------|-------------------|------------|-----------|
| 3,060  | 3,063             | ✅ OK      | ✅ OK     |
| 3,366  | 3,369             | ❌ Crash   | ✅ OK     |
| 10,000 | 10,003            | ❌ Crash   | ✅ OK     |

**Alternative Fix Considered:**
Moving the `onResult` wrapping to `addCommand` instead of `bindExecute`, but the current approach is minimal and consistent with the existing code pattern.

---

## 수정할 파일

```
packages/datadog-instrumentations/src/mysql2.js
```

**변경 내용 (Line 108-110):**
```diff
  function bindExecute (cmd, execute, asyncResource) {
    return shimmer.wrapFunction(execute, execute => asyncResource.bind(function executeWithTrace (packet, connection) {
-     if (this.onResult) {
+     if (this.onResult && !this.onResult._ddBound) {
        this.onResult = asyncResource.bind(this.onResult)
+       this.onResult._ddBound = true
      }

      return execute.apply(this, arguments)
    }, cmd))
  }
```

---

## 참고

- 이슈: https://github.com/DataDog/dd-trace-js/issues/7074
- dd-trace-js fork 후 브랜치 생성하여 PR 제출
