# MySQL2 + dd-trace Call Stack Overflow 재현 프로젝트

`mysql2`와 `dd-trace`를 함께 사용할 때 발생하는 `Maximum call stack size exceeded` 에러 재현 프로젝트입니다.

> **English version**: [README.en.md](./README.en.md)

## 버그 요약

dd-trace가 활성화된 상태에서 `connection.execute()`에 대량의 params (~3,300개 이상)를 전달하면 스택 오버플로우가 발생합니다.

```
RangeError: Maximum call stack size exceeded
    at AsyncResource.runInAsyncScope (node:async_hooks:197:18)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    ...
```

## 근본 원인

**dd-trace의 mysql2 instrumentation 버그** (`dd-trace/packages/datadog-instrumentations/src/mysql2.js`):

```javascript
// Line 108-109 - 매 패킷마다 호출됨!
if (this.onResult) {
  this.onResult = asyncResource.bind(this.onResult)  // 콜백을 매번 재래핑
}
```

MySQL의 prepared statement 프로토콜은 각 parameter마다 별도 패킷을 전송합니다. 3,366개 params의 경우 `execute()`가 3,369번 호출되어 콜백이 3,369층으로 중첩됩니다. 콜백 실행 시 3,369개의 동기적 `runInAsyncScope()` 호출이 발생하여 스택 오버플로우가 발생합니다.

**상세 분석은 [REPORT.md](./REPORT.md) 참조**

## 임계점

| Rows | Params | `execute()` 호출 | 결과 |
|------|--------|------------------|------|
| 30   | 3,060  | 3,063회          | ✅ 성공 |
| 33   | 3,366  | 3,369회          | ❌ Stack Overflow |

## 환경

- **dd-trace**: 5.28.0
- **mysql2**: 3.x
- **Node.js**: 18+

## 빠른 시작

```bash
# 클론 및 설치
git clone https://github.com/myeongseoklee/mysql2-callstack-reproduction.git
cd mysql2-callstack-reproduction
npm install

# MySQL 시작
npm run docker:up

# 에러 재현
npm run reproduce

# 정리
npm run docker:down
```

## 해결 방법 (Workaround)

```typescript
// ❌ 대량 params로 스택 오버플로우 발생
connection.execute(query, params.flat(), callback);

// ✅ 해결: 값을 직접 삽입하고 빈 params 배열 전달
const values = rows
  .map(r => `(${Object.values(r).map(v => escape(v)).join(',')})`)
  .join(',');
connection.execute(`INSERT ... VALUES ${values}`, [], callback);
```

## 프로젝트 구조

```
├── src/
│   ├── reproduce.ts           # 메인 재현 스크립트
│   ├── debug-wrap-count.ts    # execute() 호출 횟수 추적 (버그 증명)
│   └── utils/
│       ├── db.ts              # DB 유틸리티
│       └── data-generator.ts  # 테스트 데이터 생성
├── init-tracer.cjs            # dd-trace 초기화
├── docker-compose.yml         # MySQL 8.0
├── REPORT.md                  # 상세 분석 리포트 (한글)
└── REPORT.en.md               # 상세 분석 리포트 (영문)
```

## 스크립트

| 스크립트 | 설명 |
|----------|------|
| `npm run reproduce` | 스택 오버플로우 에러 재현 |
| `npm run debug:wrap` | `execute()` 호출 횟수 확인 (버그 증명) |
| `npm run docker:up` | MySQL 컨테이너 시작 |
| `npm run docker:down` | MySQL 컨테이너 중지 |

## 라이선스

MIT
