# ADR-002 — 로컬 API 단일 writer와 OS 잠금

- 상태: accepted
- 일자: 2026-07-27
- 결정: PRD §5.4, R9
- 관련: [ADR-001](adr-001-file-sot-sqlite-index.md) · [ADR-006](adr-006-shared-board-data-branch.md)

## Context

웹 UI, CLI, 사람과 여러 에이전트가 같은 보드에 동시에 쓸 수 있다. 각 호출자가 파일을 직접 수정하면
ETag 검사, 권한, 상태 전이, outbox, 이벤트 기록을 우회할 수 있고 동일 표시 키나 잘린 파일이 생긴다.
프로세스 내부 mutex만으로는 같은 `.localjira/`에 서버 두 개가 뜨는 상황을 막지 못한다.

반대로 외부 에디터와 git은 제품이 의도적으로 허용하는 입력이다. 따라서 "모든 파일 변경을 막는
배타 잠금"이 아니라, **도메인 명령을 수행하는 서버 writer만 하나**로 제한하고 외부 변경은
reconciler가 받아들여야 한다.

## Decision

### 1. 도메인 쓰기는 로컬 API 서버 하나만 수행한다

웹 UI, CLI와 에이전트는 모두 HTTP API를 통해 도메인을 변경한다. API 서버만 다음 권한을 가진다.

- 권한·scope와 상태 전이 검증
- ETag `If-Match` 검사
- uid·표시 키 발급
- WriteTxn/outbox 실행
- 인덱스 갱신과 이벤트 기록

에디터·git이 만든 외부 파일 변경은 금지하지 않는다. reconciler가 `actor_kind=external`로 검증·반영하며,
API 명령과 동일한 권한 주체로 가장하지 않는다.

### 2. 동일 보드의 두 번째 서버는 OS advisory lock으로 거부한다

서버는 `.localjira/.local/server.lock`을 열고 프로세스 수명 동안 열린 FD에 비차단 배타
`flock(LOCK_EX|LOCK_NB)`을 유지한다. 획득 실패 시 기동을 중단하고 lock 파일에 기록된 pid·시작 시각·
서버 URL을 진단 정보로 출력한다.

lock 파일의 존재 자체는 소유권이 아니다. 프로세스가 죽으면 OS가 FD 잠금을 자동 해제하므로
PID 생존 확인 후 stale 파일을 삭제하는 TOCTOU 방식과 PID 재사용 판정은 사용하지 않는다.
파일은 진단 정보로 남아 있어도 다음 프로세스가 OS lock을 획득하면 정상 기동한다.

지원 배치는 로컬 파일시스템이며 NFS/SMB는 제외한다. 플랫폼별로 동등한 advisory file lock을 사용하고,
지원 여부를 확인할 수 없으면 잠금 없이 기동하지 않는다.

### 3. 프로세스 안에서도 충돌 범위를 직렬화한다

- 같은 target path의 WriteTxn은 path-keyed mutex로 직렬화한다.
- 표시 키 발급과 프로젝트 단위 LexoRank 재균형처럼 여러 엔티티에 걸친 연산은 project-keyed mutex를 쓴다.
- mutex를 잡은 뒤 최신 ETag·도메인 조건을 다시 검사한다. "조회 후 나중에 쓰기" 판정은 허용하지 않는다.
- 잠금 순서는 `project → path`로 고정해 교착을 방지한다.

### 4. 배치상 서버도 하나다

ADR-006에 따라 보드는 리포 루트의 `.localjira/` worktree 한 곳에만 존재한다. 다른 코드 worktree의
사람·에이전트는 그 파일을 각자 열지 않고 같은 서버 URL을 사용한다. OS lock은 잘못된 이중 기동에
대한 마지막 방어선이다.

## Alternatives

- **각 CLI/UI가 직접 파일 쓰기** — 권한·ETag·outbox·이벤트 계약을 우회한다. 기각.
- **서버 여러 개 + SQLite write lock에 의존** — 파일 rename과 이벤트 append는 SQLite lock의 보호를
  받지 않아 단일 트랜잭션이 되지 않는다. 기각.
- **PID 파일 존재 여부로 판정** — 비정상 종료 후 영구 차단되고 PID 재사용·TOCTOU 문제가 있다. 기각.
- **중앙 공유 서버** — 키 발급은 단순하지만 로컬 우선·오프라인 운용을 포기한다. ADR-006 D2에 따라 기각.
- **모든 외부 파일 편집 차단** — git 기반 SoT와 사람 편집이라는 제품 목표를 훼손한다. 기각.

## Consequences

- (+) 모든 API 쓰기가 같은 권한·동시성·감사 경로를 통과한다.
- (+) 프로세스 크래시 뒤 별도 stale lock 삭제 없이 안전하게 재기동한다.
- (+) 외부 편집과 git 동기화는 계속 지원한다.
- (−) 서버가 떠 있지 않으면 도메인 명령을 수행할 수 없다.
- (−) 네트워크 파일시스템과 advisory lock을 제공하지 않는 환경은 지원하지 않는다.
- (−) multi-process 수평 확장은 현재 구조에서 불가능하다. 필요해지면 저장·조정 프로토콜을 다시 설계해야 한다.

## References

- PRD §5.4(단일 writer·원자 저장·식별자 발급) · §5.7(external actor) · §13 D1·D2
- 스토리 R9
- 저장 설계 §3.4·§3.10
