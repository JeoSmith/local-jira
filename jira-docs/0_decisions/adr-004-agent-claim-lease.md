# ADR-004 — 런타임 claim/lease와 사람 우선권

- 상태: accepted
- 일자: 2026-07-27
- 결정: PRD §6.1, D7·D10, R16
- 관련: [ADR-001](adr-001-file-sot-sqlite-index.md) · [ADR-002](adr-002-single-writer-daemon.md) · [ADR-006](adr-006-shared-board-data-branch.md)

## Context

두 에이전트가 같은 TODO 이슈를 조회한 뒤 각각 `IN_PROGRESS`로 바꾸는 방식은 중복 실행을 막지 못한다.
단순 assignee는 계획상 책임자일 뿐 현재 실행 소유권이 아니며, 영구 잠금은 죽은 에이전트가 이슈를
무기한 점유하게 만든다.

claim을 git 추적 파일로 공유하면 클론 간 동기화 지연 때문에 이미 만료되거나 존재하지 않는 프로세스의
점유가 전파된다. 반대로 런타임 상태를 잃더라도 취득·해제 사실은 협업 이력에 남아야 한다.

## Decision

### 1. claim은 로컬 런타임 상태다

claim은 `.localjira/.local/runtime.sqlite`에 저장하며 파일 SoT·git 동기화·인덱스 재빌드 대상이 아니다.
`claims.issue_uid` primary key가 원자적 선점 장치다. 같은 이슈에 대한 동시 INSERT 중 정확히 하나만
성공한다.

claim은 `owner_id`, `run_id`, `acquired_at`, `last_heartbeat_at`, `lease_expires_at`을 가진다.
취득·heartbeat·해제·만료 회수·강제 해제라는 사실은 파일 SoT 이벤트에 기록한다.

### 2. 취득 조건과 전이를 결합한다

- 에이전트는 `POST /issues/{id}/claim`으로 먼저 선점한다.
- 기본 대상은 `TODO`; 중단된 자기 작업 재개에 한해 `IN_PROGRESS`를 허용한다.
- `BACKLOG`, 미완료 `blocked_by`, 미해결 question/review_request, 타인의 유효 claim은 거부한다.
- 에이전트가 `IN_PROGRESS`, `IN_REVIEW`, `DONE`으로 전이하려면 scope뿐 아니라 본인의 유효 claim이
  필요하다. claim은 상태 전이표를 확장하지 않는다.
- 동일 owner·run의 유효 claim 재요청은 200 멱등 응답이며 lease를 갱신한다.
- 타인의 유효 claim 충돌은 409다.

AgentRun과 claim의 생성 순서는 M3 API 상세 설계에서 확정하되, claim 저장 시점에는 유효한 `run_id`가
반드시 존재해야 한다. 임시·NULL run으로 소유권을 만들지 않는다.

### 3. STALE 경고와 lease 만료를 분리한다

- heartbeat 기대 주기: 60초
- 마지막 heartbeat +3분: `STALE` 표시. 경고일 뿐 claim은 유효
- heartbeat 성공: `lease_expires_at = now + 15분`
- 마지막 heartbeat +15분: lease 만료, 다른 에이전트가 원자적으로 회수·취득 가능

`STALE`은 저장 상태가 아니라 조회 시각과 `last_heartbeat_at`으로 계산한다. 만료·강제 해제 시 이슈
상태를 자동으로 TODO로 되돌리지 않는다. claim만 제거하고, 상태 변경은 사람이 명시적으로 수행한다.
회수된 이전 run의 뒤늦은 상태 전이·코멘트·결과 제출은 409로 거부한다.

### 4. 사람에게 최종 통제권을 둔다

`member` 이상인 사람은 lease 만료 전에도 타인의 claim을 사유와 함께 강제 해제할 수 있다. 사람은
claim 없이 상태를 전이할 수 있지만 타인의 유효 claim이 있으면 경고와 명시적 강제 확인을 거친다.
agent 역할은 타인의 claim을 강제 해제할 수 없다.

## Alternatives

- **조회 후 상태 전이** — 두 에이전트가 동시에 통과할 수 있다. 기각.
- **assignee를 실행 잠금으로 사용** — 계획 책임과 현재 실행 주체를 혼동하고 lease가 없다. 기각.
- **claim을 git 추적 파일로 저장** — 클론 간 지연·머지가 유령 점유를 만든다. 기각.
- **영구 claim + 수동 해제만** — 죽은 세션이 이슈를 무기한 막는다. 기각.
- **3분 STALE 즉시 회수** — 긴 빌드나 일시적 heartbeat 지연 중 정상 작업을 빼앗을 수 있다. 기각.
- **lease 만료 시 자동 TODO 전환** — 진행 흔적과 사람의 판단을 지우고 상태·소유권을 다시 결합한다. 기각.

## Consequences

- (+) 동일 이슈의 에이전트 중복 실행을 원자적으로 막는다.
- (+) 죽은 세션은 자동 회수되고 사람은 언제든 개입할 수 있다.
- (+) claim 유실이 도메인 데이터 복구를 방해하지 않는다.
- (−) 서로 다른 클론의 독립 서버 사이에는 실시간 claim 상호배제가 없다. 팀은 ADR-006의 단일 보드
  worktree와 해당 머신의 서버 URL을 사용해야 한다.
- (−) `runtime.sqlite`가 유실되면 claim은 복구 대상이 아니며 에이전트가 다시 선점해야 한다.
  정상 서버 재기동에서는 아직 유효한 claim을 유지하고 만료된 claim만 회수한다.
- (−) heartbeat, run 취소와 모든 쓰기 API가 같은 claim 검증 규칙을 공유해야 한다.

## References

- PRD §5.1·§5.4 · §6.1 · §13 D7·D10 · §10 AC19·AC20
- 스토리 R16a·R16b, 관련 R13b·R17a·R19b
- SQLite claim 스키마 `../3_designs/database/index-schema.md`
