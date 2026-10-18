# 동작을 검증한다

```sh
node --experimental-strip-types --test tests/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

`domain.test.ts`는 접수 상태, 가격 사본, 상담 금액 확정, 순번과 일별 통계의 동작을 검증합니다.
`api.integration.test.ts`는 실제 API 핸들러와 생성된 SQL 마이그레이션을 사용합니다.
Node SQLite의 D1 호환 어댑터로 동시 접수, CAS 재시도, 재전송 중복 방지와 매장 간 권한을 검증합니다.
이 어댑터는 Cloudflare D1 배포, 엣지 인증 또는 브라우저 검증을 대신하지 않습니다.

화면 검증은 별도입니다. 현재 자동 브라우저 드라이버가 없어 실제 클릭·반응형 화면 검증을 수행하지 않았습니다.
첫 버전은 소유자 전용 비공개 테스트입니다. 실제 고객의 익명 QR 접속과 실기기 호출 알림은 아직 검증하지 않았습니다.

세 모드 추가 후 마스터 권한, 동시 배정, 기간 집계와 머리 길이 접수 사본도 검증합니다. 테스트용 계정은 fixture에서 준비하며 운영 환경의 마스터 ID를 소스에 넣지 않습니다.
