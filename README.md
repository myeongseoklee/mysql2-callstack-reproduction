# MySQL2 + dd-trace Call Stack Overflow PoC

MySQL2와 dd-trace를 함께 사용할 때 대량의 params로 `execute()`를 호출하면 발생하는 `Maximum Call Stack Size Exceeded` 에러 재현.

## 🔥 재현된 에러

```
RangeError: Maximum call stack size exceeded
    at AsyncResource.runInAsyncScope (node:async_hooks:197:18)
    at Prepare.bound (node:async_hooks:235:16)
    at AsyncResource.runInAsyncScope (node:async_hooks:203:9)
    at Prepare.bound (node:async_hooks:235:16)
    ...
```

## 📊 에러 조건

- **임계점**: 33 rows × 102 columns = **3,366 params**
- **dd-trace**: 5.28.0
- **mysql2**: 3.x

## 🔍 원인

dd-trace가 mysql2의 `execute()`를 계측할 때 `AsyncResource`로 콜백을 래핑하고, 대량 params 처리 시 `Prepare.bound` ↔ `runInAsyncScope` 재귀 호출 발생.

## ✅ 해결책

```typescript
// ❌ 에러 발생
connection.execute(query, params.flat(), callback);

// ✅ 해결: 값을 직접 치환하고 빈 배열 전달
const values = rows.map(r => `(${Object.values(r).map(v => escape(v)).join(',')})`).join(',');
connection.execute(`INSERT ... VALUES ${values}`, [], callback);
```

## 🚀 실행

```bash
npm install
npm run docker:up   # MySQL 시작
npm run reproduce   # 에러 재현
npm run docker:down # 정리
```

## 📁 구조

```
├── src/
│   ├── reproduce.ts           # 에러 재현 스크립트
│   └── utils/
│       ├── db.ts              # DB 연결
│       └── data-generator.ts  # 테스트 데이터
├── init-tracer.cjs            # dd-trace 초기화
└── docker-compose.yml         # MySQL 8.0
```

## License

MIT
