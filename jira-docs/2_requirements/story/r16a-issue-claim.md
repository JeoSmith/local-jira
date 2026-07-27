---
title: "이슈 원자적 선점(claim)과 전이 강제 결합"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R16
milestone: M3
priority: P0
---

# 이슈 원자적 선점(claim)과 전이 강제 결합

> R16 분할 첫 번째 스토리. 본 스토리는 **선점의 취득 조건과 그 선점이 무엇을 허가하는가**(누가 언제 집을 수 있고, 집어야만 무슨 전이가 되는가)를 다루고, `r16b`가 **선점의 수명**(lease·heartbeat·STALE·강제 해제)을 다룬다. 취득 판정과 만료 판정은 트리거와 검증 방법이 다르다.

## 사용자 스토리 (User Story)

> **As a** 여러 에이전트를 동시에 돌리는 개발자,
> **I want** 에이전트가 이슈를 원자적으로 선점해야만 작업 상태로 옮길 수 있기를,
> **so that** 두 에이전트가 같은 이슈를 중복 수행하거나 정제되지 않은 백로그를 임의로 착수하는 일이 구조적으로 막힌다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given `TODO` 상태이고 유효 claim이 없는 이슈, When 에이전트가 `POST /issues/{id}/claim`을 호출하면, Then **200**과 함께 `owner_id`·`run_id`·`acquired_at`·`lease_expires_at`이 반환된다(§6.1, §5.1 Claim).
- [ ] Given 같은 이슈에 대해 **두 에이전트가 동시에** claim을 호출, When 두 요청이 처리되면, Then 정확히 하나만 **200**이고 나머지는 **409**다(AC19). 판정은 단일 원자 연산이며, **조회 후 상태 변경 2단계로 구현하지 않는다**(§6.1 — 그 방식은 동시 진입을 막지 못한다).
- [ ] Given 유효 claim을 이미 보유한 이슈, When 제3의 에이전트가 claim을 호출하면, Then **409**이며 응답에 현재 `owner_id`와 `lease_expires_at`이 포함된다.
- [ ] Given `BACKLOG` 상태의 이슈, When 에이전트가 claim을 호출하면, Then 사유와 함께 거부된다(**409**, 본문에 사유 코드). 정제되지 않은 백로그는 사람이 `TODO`로 올린 뒤에만 집힌다(§6.1, AC19).
- [ ] Given `IN_PROGRESS`이고 **claim owner가 본인이었던(중단된 자기 작업)** 이슈, When 같은 에이전트가 claim을 호출하면, Then **200**으로 재개가 허용된다(§6.1 예외).
- [ ] Given `IN_PROGRESS`이지만 **타인이 진행하던** 이슈, When 다른 에이전트가 claim을 호출하면, Then **409**다.
- [ ] Given 미완료 `blocked_by` 링크가 있는 이슈, When `GET /issues/{id}`를 호출하면, Then `claimable=false`와 **차단 사유(미완료 선행 이슈 키 목록)** 가 함께 반환된다(§5.2).
- [ ] Given 같은 이슈, When 에이전트가 claim을 호출하면, Then 사유와 함께 거부된다(**409**, AC19).
- [ ] Given `GET /issues?sprint=active&status=TODO&claimable=true`, When 응답을 확인하면, Then `BACKLOG` 항목·미완료 `blocked_by` 보유 이슈·이미 유효 claim이 걸린 이슈가 **모두 제외**된다(S3, §5.2).
- [ ] Given `issue:transition` scope는 있으나 해당 이슈에 **본인 claim이 없는** 에이전트, When `IN_PROGRESS`·`IN_REVIEW`·`DONE`으로 전이를 시도하면, Then **403**이다(§6.1 claim↔전이 강제 결합, AC19). scope 보유는 충분조건이 아니다.
- [ ] Given **타인의** 유효 claim이 걸린 이슈, When 에이전트가 위 세 상태로 전이를 시도하면, Then **403**이다.
- [ ] Given 본인 claim을 보유한 에이전트, When 같은 전이를 수행하면, Then 성공하고 이벤트에 `agent` 배지·`run_id`·`initiated_by`가 함께 남는다(AC6).
- [ ] Given 타인의 유효 claim이 걸린 이슈, When **사람**이 상태를 전이하면, Then claim 없이도 수행 가능하되 **경고와 강제 여부 확인**을 거친 뒤 진행된다(§6.1 사람 우선권).
- [ ] Given claim 취득·거부, When 이벤트를 확인하면, Then 취득 사실이 `.localjira/events/`에 이벤트로 남는다(N7 — claim은 감사 범위).
- [ ] Given §5.2 전이표에 없는 전이(예: `TODO` → `DONE`), When claim을 보유한 에이전트가 시도하면, Then claim 보유와 무관하게 **400**이다(AC14). claim은 전이표를 확장하지 않는다.

> ⚠ 미정: `BACKLOG`·미완료 `blocked_by`로 인한 거부의 **상태코드** — PRD는 "사유와 함께 거부"만 규정하고 코드를 고정하지 않는다(본 스토리는 유효 claim 충돌과 동일하게 409로 둔다).
> ⚠ 미정: claim에 기록되는 `run_id`를 **claim 요청이 함께 제출**하는지(선행 run 생성) 아니면 claim이 발급하는지 — S3의 순서(claim → AgentRun 시작)와 §6.1(claim에 `run_id` 기록)이 서로 순서를 확정하지 않는다.
> 결정됨: 동일 owner·run의 유효 claim 재요청은 200 멱등 응답이며 lease를 갱신한다(D10, ADR-004).

## 범위 밖 (Out of Scope)

- lease 만료·heartbeat·`STALE` 판정·사람 강제 해제·해제 후 쓰기 거부 — `r16b-lease-heartbeat-forced-release.md`.
- AgentRun의 생성·종료·구조화 결과 — R17.
- 미해결 `question`·`review_request`로 인한 **자동 claim 차단** — R19(`r19b-unresolved-comment-gating.md`).
- PAT scope 판정 자체(`issue:transition` 보유 여부) — `r13b-pat-scope-enforcement.md`.
- 상태 전이표(§5.2) 자체의 구현 — R7.
- `assignee` 지정·변경 — assignee는 계획상 책임자이며 claim owner(현재 실행 주체)와 독립이다(§5.1).

## 선행 의존 (Depends on)

- `r13b-pat-scope-enforcement.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §4 S3, §5.1(Claim 엔티티·assignee 독립), §5.2(전이표·`claimable=false`), §6.1, §6.4, §7 R16, §9 N7, §12 M3
- 검증: PRD AC19, 보조 AC6·AC14
