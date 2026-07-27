# ADR-003 — JCS API 표현 기반 강한 ETag 낙관적 동시성

- 상태: accepted
- 일자: 2026-07-27
- 결정: PRD §5.4, R10
- 관련: [ADR-001](adr-001-file-sot-sqlite-index.md) · [ADR-002](adr-002-single-writer-daemon.md)

## Context

사람, 에이전트와 외부 에디터가 같은 이슈를 바꿀 수 있다. 마지막 쓰기 승리를 허용하면 먼저 저장된
변경이 조용히 사라진다. 정수 `rev`는 서로 연결되지 않은 두 클론이 같은 다음 숫자를 만들 수 있어
분산 동시성 토큰이 되지 못한다.

원본 파일 바이트 해시는 watcher 변경 감지에는 적합하지만 API의 강한 ETag와 목적이 다르다. YAML 키
순서나 개행만 다른 두 파일이 같은 API 리소스를 표현할 수 있고, 반대로 실제 HTTP 응답 바이트와 다른
정규화 대상을 해시하면 강한 validator 계약을 위반한다.

## Decision

### 1. ETag는 실제 API 표현 바이트의 해시다

v1 API의 파일 SoT 리소스 응답은 `application/json` 한 종류이며 RFC 8785 JCS 바이트 그대로 전송한다.
강한 ETag는 그 바이트의 SHA-256 전체값을 소문자 hex 64자로 계산해 HTTP 따옴표로 감싼다.

```http
ETag: "7e2f...64-hex-characters"
```

약한 `W/` ETag를 쓰지 않는다. 전송 압축은 content coding으로만 적용한다. 향후 표현 종류를 추가하면
표현별 ETag와 `Vary` 계약을 별도로 정의한다.

원본 파일 바이트의 SHA-256인 `file_hash`는 watcher·outbox CAS용이다. API 표현의 `etag`와 같은 값일
필요가 없으며 서로 대신 사용하지 않는다.

### 2. 수정은 `If-Match`를 필수로 한다

파일 SoT 리소스의 `PUT`, `PATCH`, 상태 전이와 삭제는 현재 ETag를 `If-Match`로 요구한다.

- 헤더 없음: `428 Precondition Required`
- 현재 ETag와 불일치: `412 Precondition Failed`
- 일치: mutex 안에서 조건을 다시 확인하고 WriteTxn 수행
- no-op 요청: 파일·ETag를 바꾸지 않고 이벤트도 만들지 않음

412 응답에는 현재 ETag, 현재 문서 전문, 거부된 요청 값을 필드 단위로 포함한다. 서버는 클라이언트의
base 스냅샷을 보관하지 않으므로 3-way diff와 재시도 결정은 base를 가진 클라이언트 책임이다.
격리·권한·상태 전이 위반은 ETag가 맞아도 각각의 도메인 규칙으로 거부된다.

### 3. ETag 입력은 보존적 파싱으로 만든다

YAML 1.2 core schema의 허용 subset만 JSON 리소스로 변환하고 anchor·alias·merge key·명시 tag·중복 키를
거부한다. 미지 키, `null`과 키 부재의 차이, 본문 후행 공백과 Unicode code point를 보존한다. 본문은
CRLF/CR만 LF로 정규화한다. 이 규칙으로 얻은 resource JSON을 JCS로 직렬화한다.

정수 `rev`가 존재하더라도 동시성 판정에는 쓰지 않는다. 표시·이력 용도로만 사용할 수 있다.

## Alternatives

- **마지막 쓰기 승리** — 조용한 데이터 손실을 허용한다. 기각.
- **정수 `rev`** — 오프라인 클론이 같은 다음 값을 만들 수 있다. 기각.
- **원본 파일 바이트 해시를 ETag로 사용** — 의미 없는 YAML 서식 변경마다 API 충돌이 나고 API 표현
  validator와 파일 변경 감지 역할이 섞인다. `file_hash`로 분리.
- **정규화 의미 해시를 만들되 임의 JSON으로 응답** — 해시 대상과 wire representation이 달라 강한
  ETag가 아니다. 기각.
- **서버 측 자동 3-way merge** — 서버가 클라이언트 base를 갖지 않고 충돌 의미도 도메인별로 달라
  잘못된 자동 병합 위험이 크다. 기각.
- **CRDT** — 파일 SoT와 현재 범위에 비해 과도하며 PRD 비목표다. 기각.

## Consequences

- (+) 사람과 에이전트의 동시 수정이 덮어쓰기로 사라지지 않는다.
- (+) 다른 클론에서도 같은 리소스 상태는 같은 ETag를 만든다.
- (+) 파일 서식 변경 감지와 API 동시성 역할이 명확히 분리된다.
- (−) 모든 수정 클라이언트가 ETag 조회·보관·412 병합 UX를 구현해야 한다.
- (−) JCS 응답과 제한된 YAML 파싱 규칙을 엄격히 지켜야 한다.
- (−) Unicode 정규화를 하지 않으므로 시각적으로 같은 NFC/NFD 문자열은 다른 ETag일 수 있다.

## References

- PRD §5.4 · §6.2 · §10 AC8
- 스토리 R10
- RFC 9110 conditional requests · RFC 8785 JSON Canonicalization Scheme
- 저장 설계 §3.2
