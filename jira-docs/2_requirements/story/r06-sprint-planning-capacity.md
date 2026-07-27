---
title: "스프린트 계획 — 백로그↔스프린트 이동과 capacity 경고"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R6
milestone: M2
priority: P0
---

# 스프린트 계획 — 백로그↔스프린트 이동과 capacity 경고

## 사용자 스토리 (User Story)

> **As a** 오너/PO,
> **I want** 백로그 화면에서 항목을 스프린트 후보 패널로 옮기며 포인트 합계와 capacity를 실시간으로 보기를,
> **so that** 스프린트에 얼마나 담았는지 감으로 판단하지 않고, 과적재는 경고로 알되 내 판단으로 밀어붙일 수 있다.

## 인수 조건 (Acceptance Criteria)

### 담기·빼기

- [ ] Given 백로그 화면(`/projects/LJ/backlog`)에 좌측 백로그 리스트와 우측 스프린트 후보 패널, When 백로그 이슈를 스프린트 패널로 끌어 놓으면, Then 200이고 그 이슈의 `sprint`가 대상 스프린트 id로 기록되며 좌측 목록에서 사라진다. — §8
- [ ] Given 스프린트에 담긴 이슈, When 백로그로 되돌리면, Then `sprint`가 비워지고 **`backlog_rank`는 담기 전 값 그대로 보존**되어 원래 자리로 돌아온다. — §5.1
- [ ] Given 스프린트에 담긴 이슈, When 값을 확인하면, Then `board_rank`는 정렬 영역 `(sprint_id, status)` 기준으로 산출되고 `backlog_rank`와 독립적으로 갱신된다. — §5.1
- [ ] Given 이슈 5건을 한 번에 선택, When 스프린트로 일괄 이동하면, Then 5건의 `sprint`가 갱신되고 각 이슈 파일이 1개씩 변경된다.
- [ ] Given `CLOSED` 스프린트, When 이슈를 담으려 하면, Then **400**이고 이슈의 `sprint`는 바뀌지 않는다.
- [ ] Given 존재하지 않는 스프린트 id, When 이슈의 `sprint`로 지정하면, Then **400**이다(API 경로). 파일을 직접 편집해 없는 스프린트를 참조한 경우는 격리 대상이다(R11). — §5.6
- [ ] Given ETag `E1`으로 읽은 이슈, When 다른 클라이언트가 먼저 그 이슈를 바꾼 뒤 `If-Match: E1`로 스프린트 이동을 보내면, Then **412**다(R10 규격).
- [ ] Given 기본 scope(`issue:read`, `issue:comment`, `issue:transition`, `run:write`)만 가진 에이전트 토큰, When 이슈의 `sprint`를 변경하려 하면, Then `issue:edit`가 없으므로 **403**이다. — §6.4, AC16

### 포인트 합계와 capacity 경고

- [ ] Given 백로그에서 항목을 선택, When 선택 상태가 바뀌면, Then 화면 하단에 **선택 항목의 포인트 합계**가 즉시 갱신된다. — §8
- [ ] Given capacity 24인 스프린트에 points `5+8+3`이 담긴 상태, When 계획 화면을 보면, Then `16 / 24`가 표시되고 경고는 뜨지 않는다.
- [ ] Given 같은 스프린트에 points 13짜리를 추가해 합계가 29가 된 상태, When 화면을 보면, Then "capacity 24 초과(+5)" **경고**가 표시되되 담기 동작 자체는 **200으로 성공**하고, 이후 시작 명령도 차단되지 않는다. — AC5, §7 R6
- [ ] Given 합계·capacity 표시, When 단위를 확인하면, Then 양쪽 모두 **스토리 포인트**다. 시간 단위 표기는 없다. — D8
- [ ] Given `capacity`가 설정되지 않은 스프린트, When 계획 화면을 보면, Then 합계만 표시되고 경고 판정은 수행되지 않는다.
- [ ] Given `points`가 없는(무추정) 이슈가 담긴 스프린트, When 합계를 보면, Then 무추정 이슈는 합계에 0으로 더해지지 않고 **무추정 N건**이 합계 옆에 별도로 표시되어 합계가 스코프 전부를 대표하지 않음을 드러낸다. — §7 R20(무추정 제외 원칙과 일관)
- [ ] Given ACTIVE 스프린트에 이슈를 추가·제거, When 처리되면, Then 성공하고 그 변화는 번다운의 **스코프 증감 선**에 반영된다(집계 자체는 R20). — AC23
- [ ] Given 스프린트 담기/빼기, When 처리되면, Then 이벤트가 변경 전후 `sprint` 값과 함께 기록된다. — N7
- [ ] Given 이슈 5,000건 데이터셋, When 백로그 계획 화면을 열고 필터를 적용하면, Then N1 기준(첫 콘텐츠 렌더 p95 ≤ 1s, 필터 API p95 ≤ 300ms)을 만족한다.

> ⚠ 미정: 계획 시 이슈에 **상태 제약**이 있는지가 PRD에 없다. `DONE`·`CANCELLED` 이슈를 PLANNED 스프린트에 담을 수 있는지 미확정이다.
> ⚠ 미정: 하위 이슈(`subtask`)를 부모와 다른 스프린트에 담을 수 있는지, 부모를 담으면 하위가 따라오는지가 PRD에 없다.
> ⚠ 미정: capacity 경고의 임계 방식(초과 시점만 경고인지, 90% 같은 근접 경고가 있는지)이 PRD에 없다.

## 범위 밖 (Out of Scope)

- 스프린트 레코드 생성·수정과 `capacity` 필드 저장 → `r05a-sprint-crud.md`
- 시작·종료 명령과 종료 시 이월 → `r05b-sprint-start-close-carryover.md`
- 백로그 내 순서 변경(LexoRank 알고리즘·재균형) → `r03-backlog-rank-lexorank.md`
- 보드에서의 `board_rank` 변경과 드래그 전이 → `r07b-board-drag-transition-rank.md`
- 번다운 차트·완료율 산출 → `r20-sprint-burndown.md`
- 필터·검색 UI 자체 → R4

## 선행 의존 (Depends on)

- `r05a-sprint-crud.md`
- `r03-backlog-rank-lexorank.md`
- `r04a-issue-filter.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(`backlog_rank`/`board_rank` 분리) · §5.6 · §6.4(scope) · §7 R6 · §8(백로그 화면 IA) · §9 N1·N7 · §13 D8
- 검증: PRD AC5 (보조: AC16 scope 거부, AC23 스코프 증감)
