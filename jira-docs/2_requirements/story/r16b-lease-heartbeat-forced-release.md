---
title: "claim lease·heartbeat 만료와 사람의 강제 해제"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-30
related_prd: ../prd/backlog-sprint.md
requirement: R16
milestone: M3
priority: P0
---

# claim lease·heartbeat 만료와 사람의 강제 해제

> R16 분할 두 번째 스토리. `r16a`가 선점의 **취득**을 다룬다면 본 스토리는 선점의 **수명과 회수**를 다룬다 — 시간 경과·heartbeat 중단·사람의 개입이라는 서로 다른 트리거로 발동하고, claim이 파일이 아니라 `.local/runtime.sqlite` 런타임 상태라는 성질도 여기서 검증된다.

## 사용자 스토리 (User Story)

> **As a** 에이전트를 감독하는 개발자,
> **I want** 죽은 에이전트의 선점이 시간이 지나면 자동 회수되고 필요하면 내가 즉시 강제 해제할 수 있기를,
> **so that** 이슈가 유령 세션에 영구 점유되지 않고, 회수 이후의 뒤늦은 쓰기가 보드를 오염시키지 않는다.

## 인수 조건 (Acceptance Criteria)

- [x] Given claim 취득 직후, When `lease_expires_at`을 확인하면, Then `acquired_at`으로부터 **15분** 뒤이며 RFC 3339로 저장된다(D7, §5.2).
- [x] Given 진행 중인 claim, When 에이전트가 heartbeat를 보내면, Then 기대 주기는 **60초**이고 `last_heartbeat_at`이 갱신된다(D7).
- [x] Given heartbeat가 **3회 연속 누락(= 3분)** 된 claim, When 상태를 조회하면, Then 연결된 run이 **`STALE`로 표시**된다(D7, AC20).
- [x] Given `STALE` 표시된 run, When 보드 카드를 보면, Then run 상태 배지로 그 사실이 드러나 사람이 회수·재할당 대상을 눈으로 찾을 수 있다(S5, §8).
- [x] Given lease가 **만료된** claim, When 다른 에이전트가 같은 이슈에 claim을 호출하면, Then **200**으로 취득된다(만료 claim은 회수 가능 상태다, §6.1, AC20).
- [x] Given `member` 이상 역할의 사람, When 타인의 유효 claim을 강제 해제하면, Then 성공한다(D7 — 강제 해제는 `member` 이상).
- [x] Given `agent` 역할의 토큰, When 타인의 claim 강제 해제를 시도하면, Then **403**이다(사람 우선권, D7).
- [x] Given 사람이 claim을 강제 해제하거나 run을 취소한 상태, When **그 run**이 이후 쓰기 요청(상태 전이·코멘트·결과 제출)을 보내면, Then **409**로 거부된다(§6.1, AC20).
- [x] Given 위 거부, When 이벤트를 확인하면, Then 강제 해제·취소의 **사유와 수행자**가 이벤트로 기록되어 있다(AC20, N7).
- [x] Given claim 취득·자연 해제·강제 회수, When `.localjira/events/`를 확인하면, Then **세 가지 사실 모두** 이벤트로 파일에 남아 이력이 보존된다(§5.4).
- [x] Given 유효한 claim이 존재하는 상태, When 저장 위치를 확인하면, Then claim/lease는 `.localjira/` 파일이 아니라 **`.local/runtime.sqlite`** 에만 있다(§5.3, §5.4).
- [x] Given 만료된 claim이 남아 있는 상태에서 **서버를 재기동**, When 기동 후 claim 목록을 조회하면, Then 만료 claim은 **전량 회수**되어 존재하지 않는다(§5.4).
- [x] Given 서버 주도 회수, When 이벤트를 확인하면, Then `actor_kind=system`으로 기록된다(§5.1, `r14a` 참조).
- [x] Given 클론 A에서 claim을 취득한 뒤 `git -C .localjira push`, When 클론 B가 pull하고 서버를 기동하면, Then B에는 그 claim이 **존재하지 않는다**(런타임 상태는 클론 간 공유되지 않는다, §5.4). 다만 취득 **사실** 이벤트는 B에서도 보인다.
- [x] Given 5,000건 fixture로 `.local/index.sqlite` 삭제·재기동 비교(AC2), When 응답을 정규화 비교하면, Then **claim/lease 등 런타임 상태는 비교 대상에서 제외**된다(AC2 명시 제외 항목, G4).

> 결정됨(D10, ADR-004): heartbeat 성공 시 lease를 `now + 15분`으로 갱신한다. 3분 `STALE`은
> 경고일 뿐 15분 만료 전까지 claim은 유효하며, 만료·강제 해제 시 이슈 상태는 자동으로 되돌리지 않는다.

## 범위 밖 (Out of Scope)

- claim 취득 조건·409 판정·claim↔전이 강제 결합 — `r16a-issue-claim.md`.
- AgentRun 생명주기와 `state` 값 체계, heartbeat API의 run 측 처리 — `r17a-agent-run-lifecycle.md`.
- 사람이 회수한 이슈의 **재할당**(assignee 변경·다음 에이전트 배정) 자동화 — PRD는 사람의 수동 행위로만 서술한다(S5).
- 유령 점유 지표 측정·리포팅 — §11 성공 지표이며 기능 요구가 아니다.
- 이벤트 append 경로·`actor_kind` 판정 구현 — `r14a-event-recording.md`.

## 선행 의존 (Depends on)

- `r16a-issue-claim.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §3 G4, §4 S4·S5, §5.3(`.local/runtime.sqlite`), §5.4(런타임 상태 분리), §6.1, §7 R16, §8, §9 N7, §12 M3, §13 D7
- 검증: PRD AC20, 보조 AC2·AC19
