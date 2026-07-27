# ADR-001 — 파일 SoT + SQLite 파생 인덱스 + outbox

- 상태: accepted
- 일자: 2026-07-27
- 결정: PRD §5.3~§5.6, G4, R8·R9·R11·R21
- 관련: [저장 계층 상세 설계](../3_designs/detailed/storage-layer.design.md) · [SQLite 스키마](../3_designs/database/index-schema.md) · [ADR-006](adr-006-shared-board-data-branch.md)

## Context

보드 데이터는 사람이 git으로 읽고 고치며 공유할 수 있어야 하지만, 5,000건 규모의 필터·검색을
파일 순회만으로 처리할 수는 없다. 파일과 DB를 둘 다 정본으로 취급하면 둘이 어긋났을 때 어느 쪽을
복구 기준으로 삼을지 결정할 수 없고, SQLite만 정본으로 두면 git diff·merge와 사람이 직접 편집하는
제품 성질을 잃는다.

파일 교체, 인덱스 갱신, 이벤트 append는 하나의 원자적 트랜잭션으로 묶을 수 없다. 프로세스가 중간에
종료되어도 부분 YAML, 과거 payload에 의한 외부 변경 덮어쓰기, 중복 이벤트 없이 다시 수렴해야 한다.

## Decision

### 1. 도메인 파일이 유일한 SoT다

이슈·코멘트·스프린트·run·제안·이벤트의 정본은 `.localjira/`의 파일이다. `index.sqlite`를 삭제한
뒤 파일만으로 다시 만들었을 때 정규화 API 응답이 같아야 한다. claim·lease와 자격증명처럼 기기별
런타임 상태는 이 보장 대상이 아니다.

`.localjira/.local/`에는 성격이 다른 DB를 분리한다.

| DB | 역할 | 유실 시 |
|---|---|---|
| `index.sqlite` | 조회·필터·FTS용 파생 인덱스 | 파일에서 전체 재빌드 |
| `outbox.sqlite` | 미완료 쓰기 저널과 멱등성 키 | 진행 중 쓰기 복구 근거 일부 유실, 파일은 정본으로 보존 |
| `runtime.sqlite` | claim·lease·SSE 버퍼 | 런타임 상태 초기화 |
| `credentials.sqlite` | 비밀번호·PAT 해시 | 기기에서 자격증명 재발급 |

파생 인덱스는 깨진 파일 세계도 표현해야 한다. 중복 표시 키나 ACTIVE 스프린트 충돌처럼 git merge로
생길 수 있는 도메인 위반을 `UNIQUE`/FK 삽입 오류로 버리지 않고, 양쪽 레코드를 보존한 뒤 검증·격리
또는 재키잉한다. 열거값·음수 금지 같은 구문 불변조건만 `CHECK`로 강제한다.

### 2. 읽기는 인덱스, 쓰기는 파일을 거친다

- 일반 API 조회는 `index.sqlite`만 사용한다.
- 외부 파일 변경은 watcher 이벤트를 힌트로 삼아 재스캔·해시·파싱·검증 후 인덱스에 반영한다.
- watcher overflow, git 대량 변경, 기동 복구는 전체 조정으로 승격한다.
- 전체 조정은 모든 파일의 원본 바이트 해시를 다시 계산한다. `(mtime, size)` fast-path는 증분 후보
  축소에만 쓴다.
- 파싱과 도메인 검증을 분리한다. 오류 파일은 삭제하지 않고 path 또는 uid 기준 `INVALID`로 격리한다.

전체 재빌드는 `index.new.sqlite`에 FTS까지 완성하고 검증한 뒤 connection generation을 전환한다.
기존 DB를 먼저 삭제해 열린 reader와 새 reader가 서로 다른 세상을 보는 방식은 금지한다.

### 3. WriteTxn은 outbox CAS로 롤포워드한다

쓰기 순서는 다음과 같다.

1. `before_hash`, `result_hash`, 최종 payload, `event_payload`, stage를 outbox에 durable 기록
2. 같은 디렉터리의 temp 파일을 `fsync`하고 rename한 뒤 부모 디렉터리 `fsync`
3. 인덱스를 멱등 upsert
4. 이벤트 파일에서 `event_id`를 확인하고 없을 때만 append + `fsync`
5. 단계마다 outbox stage를 durable 갱신하고 최종 `DONE`

재생 시 현재 파일 해시가 `before_hash`면 파일 단계부터 진행하고, `result_hash`면 완료된 파일 단계를
건너뛴다. 둘 다 아니면 크래시 뒤 외부에서 바뀐 것이므로 **과거 payload를 덮어쓰지 않고** `ABORTED`
처리한 뒤 현재 파일을 인덱싱한다.

이벤트 append와 SQLite stage 갱신은 원자적이지 않다. `EVENT_DONE` 전 재생은 알려진 대상 JSONL
파일에서 `event_id`를 확인해 중복 append를 막는다. 미완료 outbox 재생이 끝나기 전 도메인 쓰기 API는
503으로 거부한다.

## Alternatives

- **SQLite만 SoT** — 조회와 트랜잭션은 단순하지만 git diff·merge·직접 편집을 잃는다. 기각.
- **파일만 사용하고 매 요청 스캔** — 구조는 단순하지만 검색·필터 NFR과 실시간 보드 갱신을 만족하지 못한다. 기각.
- **파일과 DB를 공동 정본으로 사용** — 불일치 시 승자를 정할 수 없고 복구 계약이 모호하다. 기각.
- **파일 쓰기 후 best-effort 인덱싱** — 크래시 구간의 복구 순서와 이벤트 중복을 증명할 수 없다. 기각.
- **하나의 SQLite에 인덱스·저널·런타임을 모두 저장** — durability 비용과 유실 의미가 다른 데이터를
  결합해 재빌드·백업 경계를 흐린다. 기각.

## Consequences

- (+) `.local/` 전체를 잃어도 도메인 파일에서 보드를 복구할 수 있다.
- (+) git merge가 만든 깨진 상태를 숨기지 않고 격리·복구할 수 있다.
- (+) 읽기 성능과 사람이 읽는 파일 형식을 함께 유지한다.
- (−) 파일·DB·이벤트 사이에 분산 트랜잭션 수준의 복구 코드와 fault-injection 테스트가 필요하다.
- (−) 인덱스 generation 전환, watcher, tombstone 등 운영 복잡도가 증가한다.
- (−) 미커밋 파일은 디스크 장애에서 보호되지 않는다. 백업은 사람이 commit·push한 데이터까지다(D5).

## References

- PRD §3 G4 · §5.3~§5.6 · §9 N1·N2·N5 · §10 AC2·AC3·AC10·AC11·AC15
- 스토리 R8a·R8b·R8c·R9·R11a·R11b·R21
- 상세 계약은 `../3_designs/detailed/storage-layer.design.md`와
  `../3_designs/database/index-schema.md`
