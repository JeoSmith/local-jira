---
title: "백로그 순서 변경 — LexoRank와 (rank, uid) tie-break"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R3
milestone: M1
priority: P0
---

# 백로그 순서 변경 — LexoRank와 (rank, uid) tie-break

## 사용자 스토리 (User Story)

> **As a** 오너/PO,
> **I want** 백로그에서 카드를 끌어 순서를 바꿀 때 파일이 최소한으로만 변경되고, 여러 클론이 각자 순서를 바꾼 뒤 머지해도 목록 순서가 흔들리지 않기를,
> **so that** 우선순위 조정이 git diff를 오염시키지 않고, 팀원마다 다른 순서를 보는 일이 없다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 백로그에 정렬된 이슈 목록, When 카드 1개를 목록 **중간**으로 이동하면, Then 200이고 변경된 파일은 이동 대상 이슈 파일 **1개**다. — AC4
- [ ] Given 같은 목록, When 카드를 **최상단**으로, 그리고 **최하단**으로 각각 이동하면, Then 각 경우에도 변경 파일이 **1개**다. — AC4
- [ ] Given 인접한 두 카드 사이, When 1,000회 반복 삽입하면, Then 매 삽입 후 조회 순서가 요청한 순서와 일치하고 순서가 뒤집히지 않는다. — AC4
- [ ] Given 인접 rank 사이 문자열 공간이 소진되는 상황, When 삽입이 발생하면, Then 서버가 **구간 재균형**을 수행하고 그 구간의 여러 이슈 파일이 함께 변경되며, 재균형 발생 사실(구간·대상 건수)이 로그/이벤트에 남는다. — AC4, §5.7
- [ ] Given 서로 다른 클론이 같은 간격에 삽입해 **동일 `backlog_rank`** 를 가진 이슈 2건이 머지된 상태, When 백로그를 조회하면, Then 오류가 아니라 `(rank, uid)` 순으로 결정적으로 정렬되고 두 클라이언트가 같은 순서를 본다. 해당 항목은 재균형 대상으로 표시된다. — §5.6
- [ ] Given `backlog_rank`가 프로젝트 백로그 순서, `board_rank`가 `(sprint_id, status)` 정렬 영역 순서인 상태, When 이슈를 스프린트에서 제외하면, Then `backlog_rank`는 보존된다(두 값은 서로 독립적으로 갱신된다).
- [ ] Given ETag `E1`으로 읽은 이슈, When 다른 클라이언트가 먼저 순서를 바꿔 ETag가 바뀐 뒤 `If-Match: E1`로 rank 변경을 보내면, Then 412다(R10 규격).
- [ ] Given `issue:rank` scope가 없는 에이전트 토큰, When 순서 변경을 요청하면, Then 403이다. — D9, AC16
- [ ] Given 이슈 5,000건 데이터셋, When 백로그 화면을 열면, Then 정렬 결과 첫 콘텐츠 렌더가 N1 기준(p95 ≤ 1s)을 만족한다.

> ⚠ 미정: 재균형 트리거 기준(인접 rank 잔여 공간 임계치, 재균형 구간 폭, 전체 재균형 배치 명령 제공 여부)을 PRD가 수치로 정하지 않았다. §5.7은 "재균형 정책이 필요하다"까지만 말한다.

## 범위 밖 (Out of Scope)

- 보드 드래그로 인한 `board_rank` 갱신과 상태 전이 결합 — R7 / AC14
- 백로그↔스프린트 이동 시의 스코프 처리 — R6
- 중복 rank를 만든 근본 원인(머지) 감지·격리 배너 — R11
- 우선순위 필드(P0/P1 같은 별도 속성) — PRD에 없음. 순서는 rank로만 표현한다.

## 선행 의존 (Depends on)

- `r01a-issue-create-read.md`
- `r01b-issue-update-delete.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1, §5.6, §5.7, §7 R3, §9 N1, §13 D9, §14 `adr-005-lexorank-ordering.md`
- 검증: PRD AC4, AC16(scope 거부)
