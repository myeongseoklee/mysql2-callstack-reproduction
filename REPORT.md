# dd-trace + mysql2 Maximum Call Stack Size Exceeded 버그 분석 리포트

> **English version**: [REPORT.en.md](./REPORT.en.md)

## 요약

`dd-trace@5.28.0`과 `mysql2@3.x` 조합에서 대량의 params로 `execute()`를 호출할 때 `Maximum call stack size exceeded` 에러가 발생하는 버그를 발견하고 근본 원인을 분석했습니다.

**결론**: dd-trace의 mysql2 instrumentation 코드에서 `onResult` 콜백이 매 패킷마다 재래핑되어 콜백 호출 시 동기적 재귀가 발생하는 **버그**입니다.

---

## 1. 에러 조건

| 항목 | 값 |
|------|-----|
| 임계점 | **~3,300-3,400 params** |
| 예시 | 33 rows × 102 columns = 3,366 params |
| dd-trace 버전 | 5.28.0 |
| mysql2 버전 | 3.x |
| Node.js | 18+ |

### 재현 조건
- dd-trace가 활성화된 상태
- `connection.execute(query, params, callback)` 사용
- params 배열 크기가 ~3,300 이상

---

## 2. 스택 트레이스

```
RangeError: Maximum call stack size exceeded
    at AsyncResource.runInAsyncScope (node:async_hooks:197:18)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    ... (반복)
```

특징: `runInAsyncScope` ↔ `Prepare.bound` 가 교차 반복됨

---

## 3. 근본 원인 분석

### 3.1 MySQL2의 Prepared Statement 처리 방식

`connection.execute(sql, params, callback)` 호출 시:

1. mysql2가 `Prepare` 명령 생성
2. MySQL 서버로 PREPARE 요청 전송
3. **서버가 각 parameter에 대한 definition 패킷 전송** (params 개수만큼!)
4. mysql2가 각 패킷마다 `Prepare.execute()` 호출 (state machine 패턴)

```
Params 개수: 3,366개
Prepare.execute() 호출 횟수: 3,369회 (params + 3)
```

### 3.2 dd-trace의 문제 코드

**파일**: `dd-trace/packages/datadog-instrumentations/src/mysql2.js`

```javascript
// Line 106-114
function bindExecute (cmd, execute, asyncResource) {
  return shimmer.wrapFunction(execute, execute => asyncResource.bind(function executeWithTrace (packet, connection) {
    if (this.onResult) {
      this.onResult = asyncResource.bind(this.onResult)  // 🔥 BUG: 매번 재래핑!
    }

    return execute.apply(this, arguments)
  }, cmd))
}
```

### 3.3 버그 메커니즘

```
[패킷 1] execute() → onResult = bind(callback)
[패킷 2] execute() → onResult = bind(bind(callback))
[패킷 3] execute() → onResult = bind(bind(bind(callback)))
...
[패킷 3369] execute() → onResult = bind(bind(...bind(callback)...))  // 3,369층!
```

콜백 호출 시:
```
runInAsyncScope()
  → bound callback
    → runInAsyncScope()
      → bound callback
        → ... (3,369번 반복)
          → Stack Overflow!
```

### 3.4 실험 결과

| Rows | Params | execute() 호출 | 결과 |
|------|--------|----------------|------|
| 10   | 1,020  | 1,023회        | ✅ 성공 |
| 20   | 2,040  | 2,043회        | ✅ 성공 |
| 30   | 3,060  | 3,063회        | ✅ 성공 |
| 33   | 3,366  | 3,369회        | ❌ Stack Overflow |

---

## 4. 왜 Async Depth는 낮은데 Stack Overflow?

```
실측 Async Depth: 최대 12
Call Stack Overflow: 발생
```

이유: **비동기 깊이가 아닌 동기적 콜백 중첩**

- `asyncResource.bind(fn)` 은 `fn`을 `runInAsyncScope()`로 감싼 함수 반환
- 3,369층 중첩된 콜백 실행 시, 각 `runInAsyncScope()`가 **동기적으로** 다음 층 호출
- 동기 호출이므로 call stack이 해제되지 않고 누적 → Stack Overflow

---

## 5. 해결 방법

### 5.1 애플리케이션 레벨 (Workaround)

```typescript
// ❌ 문제 발생
connection.execute(
  `INSERT INTO table (col1, col2, ...) VALUES (?, ?, ...), (?, ?, ...), ...`,
  params.flat(),  // 3,000+ params
  callback
);

// ✅ 해결: 값을 직접 치환하고 빈 params 배열 전달
const values = rows
  .map(r => `(${Object.values(r).map(v => escape(v)).join(',')})`)
  .join(',');

connection.execute(
  `INSERT INTO table (col1, col2, ...) VALUES ${values}`,
  [],  // 빈 배열 → Prepare 패킷 최소화
  callback
);
```

### 5.2 dd-trace 수정 제안

**수정안 1: 래핑 여부 체크**
```javascript
function bindExecute (cmd, execute, asyncResource) {
  return shimmer.wrapFunction(execute, execute => asyncResource.bind(function executeWithTrace (packet, connection) {
    // 이미 래핑됐으면 skip
    if (this.onResult && !this.onResult.__ddBound) {
      this.onResult = asyncResource.bind(this.onResult)
      this.onResult.__ddBound = true
    }

    return execute.apply(this, arguments)
  }, cmd))
}
```

**수정안 2: addCommand에서 한 번만 래핑**
```javascript
shimmer.wrap(Connection.prototype, 'addCommand', addCommand => function (cmd) {
  // ...

  // execute 내부가 아닌 여기서 한 번만 래핑
  if (cmd.onResult) {
    cmd.onResult = asyncResource.bind(cmd.onResult)
  }

  cmd.execute = isQuery
    ? wrapExecute(cmd, cmd.execute, asyncResource, this.config)
    : bindExecuteWithoutCallbackWrap(cmd, cmd.execute, asyncResource)  // 콜백 래핑 제거

  return asyncResource.bind(addCommand, this).apply(this, arguments)
})
```

---

## 6. 영향 범위

### 영향받는 경우
- dd-trace로 APM 모니터링 중인 Node.js 애플리케이션
- mysql2의 `execute()` (prepared statement) 사용
- 대량 bulk insert (params > ~3,300개)

### 영향받지 않는 경우
- dd-trace 미사용
- mysql2의 `query()` 사용 (prepared statement 아님)
- params 개수가 적은 경우

---

## 7. 재현 프로젝트

GitHub: https://github.com/myeongseoklee/mysql2-callstack-reproduction

```bash
git clone https://github.com/myeongseoklee/mysql2-callstack-reproduction.git
cd mysql2-callstack-reproduction
npm install
npm run docker:up
npm run reproduce      # 에러 재현
npm run debug:wrap     # execute() 호출 횟수 확인
npm run docker:down
```

---

## 8. 참고 자료

- [dd-trace-js GitHub](https://github.com/DataDog/dd-trace-js)
- [mysql2 GitHub](https://github.com/sidorares/node-mysql2)
- [Node.js AsyncResource 문서](https://nodejs.org/api/async_hooks.html#class-asyncresource)

---

## 9. 결론

이 버그는 dd-trace의 mysql2 instrumentation에서 `onResult` 콜백을 **매 패킷마다 재래핑**하는 설계 결함입니다.

MySQL의 prepared statement 프로토콜 특성상, 서버가 각 parameter에 대해 별도 패킷을 전송하며, dd-trace가 이를 고려하지 않아 대량 params 시 콜백 중첩이 발생합니다.

**권장 조치**:
1. 애플리케이션에서 workaround 적용 (값 직접 치환)
2. dd-trace GitHub에 버그 리포트 제출
3. dd-trace 버그 수정 후 업데이트
