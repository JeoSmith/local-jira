---
title: "보드 드래그 — 전이표 준수와 board_rank 유지"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R7
milestone: M2
priority: P0
---

# 보드 드래그 — 전이표 준수와 `board_rank` 유지

> **R7 분할 사유**: `r07a`가 보드 읽기라면 본 스토리는 쓰기다. §5.2 전이표 준수(400·원위치 복귀)와
> 정렬 영역 `(sprint_id, status)` 기준 `board_rank` 유지는 검증이 상태 기계·정렬 쪽이라 분리한다.

## 사용자 스토리 (User Story)

> **As a** 개발자,
> **I want** 보드에서 카드를 끌어 상태를 바꾸되 허용되지 않은 이동은 즉시 되돌아가고 컬럼 안에서의 내 정렬은 유지되기를,
> **so that** 워크플로에 없는 상태 점프로 보드가 실제와 어긋나지 않고, 순서 조정이 백로그 우선순위를 망가뜨리지 않는다.

## 인수 조건 (Acceptance Criteria)

### 전이표 준수 (§5.2)

- [ ] Given `TODO` 컬럼의 카드, When `IN_PROGRESS` 컬럼으로 끌어 놓으면, Then 200이고 `status: IN_PROGRESS`로 파일이 갱신되며 카드가 새 컬럼에 남는다. — §5.2
- [ ] Given `TODO` 컬럼의 카드, When `DONE` 컬럼으로 끌어 놓으면, Then **400**이고 카드가 **원위치(`TODO`)로 되돌아가며** 허용된 전이 목록이 오류 메시지로 표시된다. `TODO → DONE`은 표에 없다. — AC14
- [ ] Given `BACKLOG` 상태 카드, When `IN_PROGRESS`로 끌어 놓으면, Then **400**이고 원위치로 복귀한다. `BACKLOG`에서 허용되는 전이는 `TODO`·`BLOCKED`·`CANCELLED`뿐이다. — §5.2, AC14
- [ ] Given `IN_PROGRESS` 카드, When `DONE`으로 끌어 놓으면, Then **400**이다. `DONE`으로는 `IN_REVIEW`에서만 들어갈 수 있다. — §5.2
- [ ] Given `DONE` 카드, When `IN_PROGRESS`로 끌어 놓으면 200이고, `TODO`·`BACKLOG`·`IN_REVIEW`·`BLOCKED`·`CANCELLED`로 끌어 놓으면 **400**이다. `DONE`에서 나가는 유일한 전이는 `IN_PROGRESS`다. — §5.2
- [ ] Given `IN_PROGRESS` 카드, When `BLOCKED`로 전이하면, Then 200이고 **진입 직전 상태(`IN_PROGRESS`)가 `blocked_from`으로 보존**된다. — §5.2
- [ ] Given 위 `BLOCKED` 카드, When 해제하면, Then `blocked_from`이 가리키는 `IN_PROGRESS`로만 복귀하며, 다른 상태로 끌어 놓으면(단 `CANCELLED` 제외) **400**이다. — §5.2
- [ ] Given `CANCELLED` 카드, When `member` 계정이 `BACKLOG`로 되돌리려 하면 **403**이고, `admin` 계정이 같은 조작을 하면 **200**이다. `CANCELLED`에서 나가는 전이는 `BACKLOG`뿐이며 `admin` 전용이다. — §5.2, AC7
- [ ] Given 전이 실패(400/403/409/412) 어느 경우든, When 응답이 돌아오면, Then 이슈 파일은 **전혀 변경되지 않고** 카드가 원위치로 되돌아간다. — AC14

### 권한 · 동시성 · 게이팅

- [ ] Given `issue:transition` scope가 없는 토큰, When 전이를 요청하면, Then **403**이고 거부가 `token_id`와 함께 감사된다. — §6.4, AC16
- [ ] Given `actor_kind=agent`이고 본인 claim이 없는 토큰, When `IN_PROGRESS`·`IN_REVIEW`·`DONE`으로 전이하면, Then `issue:transition` scope가 있어도 **403**이다. — §6.1, AC19
- [ ] Given 타인의 유효한 claim이 걸린 이슈, When **사람**이 보드에서 전이를 시도하면, Then 경고와 함께 강제 여부 확인을 받고, 확인하면 전이가 성공한다(사람 우선권). — §6.1
- [ ] Given ETag `E1`으로 렌더된 보드, When 다른 클라이언트가 먼저 그 이슈를 바꾼 뒤 `If-Match: E1`로 전이를 보내면, Then **412**와 함께 현재 문서 전문·최신 ETag·거부된 값이 반환되고 카드가 서버 상태로 다시 그려진다. — AC8
- [ ] Given 전이 성공, When 이벤트를 확인하면, Then `before`/`after` 상태와 `actor_kind`, (에이전트면) `run_id`·`initiated_by`가 함께 기록된다. — AC6, N7

### `board_rank` 유지

- [ ] Given `IN_PROGRESS` 컬럼 안의 카드, When 같은 컬럼 안에서 위치만 바꾸면, Then `board_rank`만 갱신되고 `status`와 `backlog_rank`는 변하지 않으며 변경 파일은 **1개**다. — §5.1, AC4 규격 재사용
- [ ] Given 카드를 다른 컬럼으로 끌어 놓으면서 드롭 위치를 지정, When 처리되면, Then 상태 전이와 함께 **새 정렬 영역 `(sprint_id, status)` 기준으로 `board_rank`가 재산출**되고, 지정한 위치에 카드가 놓인다. — §5.1
- [ ] Given 컬럼 간 이동, When 이슈 값을 확인하면, Then `backlog_rank`는 **보존**된다. 정렬 필드는 2개이며 서로 독립이다. — §5.1
- [ ] Given 같은 컬럼에 `board_rank`가 동일한 이슈 2건이 머지로 생긴 상태, When 보드를 조회하면, Then 오류가 아니라 `(rank, uid)`로 결정적으로 정렬되고 재균형 대상으로 표시된다. — §5.6, §5.7
- [ ] Given 한 컬럼에서 인접 두 카드 사이 삽입이 반복되어 rank 공간이 소진, When 삽입이 발생하면, Then 구간 재균형이 수행되고 그 사실이 로그/이벤트에 남는다(알고리즘은 R3). — §5.7
- [ ] Given `issue:rank` scope가 없는 에이전트 토큰, When 컬럼 내 순서 변경을 요청하면, Then **403**이다. 우선순위 변경은 사람 전용이다. — D9, AC16

> ⚠ 미정: 컬럼 이동과 컬럼 내 순서 지정이 **하나의 요청**인지 두 요청(전이 + rank)인지 PRD가 정하지 않았다. 두 요청이면 중간에 실패했을 때의 처리(상태만 바뀌고 위치는 미반영)가 정의되어야 한다.
> ⚠ 미정: 미해결 `question`/`review_request`로 인한 `DONE` 전환 차단(§6.3, R19)은 M4다. M2 시점의 보드에서 이 게이팅이 어떻게 보이는지(그때는 아예 없는지)가 PRD에 명시되지 않았다.
> ⚠ 미정: 이슈를 컬럼이 아닌 **보드 밖**(백로그)으로 끌어 스프린트에서 빼는 조작을 보드에서 지원하는지가 §8에 없다.

- [ ] Given 마우스를 쓰지 않는 사용자, When 카드에 포커스를 두고 키보드로 조작하면, Then 컬럼 간 이동과 같은 컬럼 내 순서 변경이 모두 가능하며, 드래그와 **동일한 전이 규칙·동일한 거부 사유**가 적용된다. *(S2-D1 — 바닐라 스택을 택했으므로 접근성을 라이브러리가 대신 주지 않는다)*
- [ ] Given 키보드로 이동 중, When 이동이 거부되면, Then 포커스가 원래 카드에 남고 사유가 스크린리더에 전달된다(`aria-live`).

## 범위 밖 (Out of Scope)

- 보드 컬럼 구성·카드 배지 렌더 → `r07a-board-columns-cards.md`
- LexoRank 생성·재균형 알고리즘 자체 → `r03-backlog-rank-lexorank.md`
- 백로그↔스프린트 이동 → `r06-sprint-planning-capacity.md`
- claim 취득·강제 해제·lease 만료 판정 → R16
- 코멘트 게이팅(미해결 `question` 시 `DONE` 차단) → R19
- 412 응답 본문 규격 → `r10-etag-optimistic-concurrency.md`
- 상태 전이 규칙 편집 UI — §3 비목표(1차에서 전이표는 고정·편집 불가)

## 선행 의존 (Depends on)

- `r07a-board-columns-cards.md`
- `r01b-issue-update-delete.md`
- `r03-backlog-rank-lexorank.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(정렬 영역·정렬 필드 2종) · §5.2(이슈 상태 전이표·`blocked_from`) · §5.6·§5.7(중복 rank·재균형) · §6.1(claim 결합·사람 우선권) · §6.4(scope) · §7 R7 · §13 D9
- 검증: PRD AC14 (보조: AC4, AC6, AC7, AC8, AC16, AC19)
