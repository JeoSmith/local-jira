---
title: "스프린트 계획 — 백로그↔스프린트 이동과 capacity 경고"
status: done
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
      **→ 이월: r07b(Wave 3) — 드래그가 거기서 생긴다. 이동 API와 규칙은 구현했다**
- [x] Given 스프린트에 담긴 이슈, When 백로그로 되돌리면, Then `sprint`가 비워지고 **`backlog_rank`는 담기 전 값 그대로 보존**되어 원래 자리로 돌아온다. — §5.1
- [x] Given 스프린트에 담긴 이슈, When 값을 확인하면, Then `board_rank`는 정렬 영역 `(sprint_id, status)` 기준으로 산출되고 `backlog_rank`와 독립적으로 갱신된다. — §5.1
- [x] Given 이슈 5건을 한 번에 선택, When 스프린트로 일괄 이동하면, Then 5건의 `sprint`가 갱신되고 각 이슈 파일이 1개씩 변경된다.
- [x] Given `CLOSED` 스프린트, When 이슈를 담으려 하면, Then **400**이고 이슈의 `sprint`는 바뀌지 않는다.
- [x] Given 존재하지 않는 스프린트 id, When 이슈의 `sprint`로 지정하면, Then **400**이다(API 경로). 파일을 직접 편집해 없는 스프린트를 참조한 경우는 격리 대상이다(R11). — §5.6
- [x] Given ETag `E1`으로 읽은 이슈, When 다른 클라이언트가 먼저 그 이슈를 바꾼 뒤 `If-Match: E1`로 스프린트 이동을 보내면, Then **412**다(R10 규격).
- [x] Given 기본 scope(`issue:read`, `issue:comment`, `issue:transition`, `run:write`)만 가진 에이전트 토큰, When 이슈의 `sprint`를 변경하려 하면, Then `issue:edit`가 없으므로 **403**이다. — §6.4, AC16

### 포인트 합계와 capacity 경고

- [ ] Given 백로그에서 항목을 선택, When 선택 상태가 바뀌면, Then 화면 하단에 **선택 항목의 포인트 합계**가 즉시 갱신된다. — §8  
      **→ 이월: r07a(Wave 3) — 다중 선택 UI가 화면 작업. `/sprints/{id}/plan`이 합계·무추정 건수를 반환한다**
- [ ] Given capacity 24인 스프린트에 points `5+8+3`이 담긴 상태, When 계획 화면을 보면, Then `16 / 24`가 표시되고 경고는 뜨지 않는다.  
      **→ 이월: r07a(Wave 3) — 표시가 화면 작업. 판정값(committed·capacity·over·unestimated)은 API가 낸다**
- [ ] Given 같은 스프린트에 points 13짜리를 추가해 합계가 29가 된 상태, When 화면을 보면, Then "capacity 24 초과(+5)" **경고**가 표시되되 담기 동작 자체는 **200으로 성공**하고, 이후 시작 명령도 차단되지 않는다. — AC5, §7 R6  
      **→ 이월: r07a(Wave 3) — 표시가 화면 작업. 판정값(committed·capacity·over·unestimated)은 API가 낸다**
- [x] Given 합계·capacity 표시, When 단위를 확인하면, Then 양쪽 모두 **스토리 포인트**다. 시간 단위 표기는 없다. — D8
- [ ] Given `capacity`가 설정되지 않은 스프린트, When 계획 화면을 보면, Then 합계만 표시되고 경고 판정은 수행되지 않는다.  
      **→ 이월: r07a(Wave 3) — 표시가 화면 작업. 판정값(committed·capacity·over·unestimated)은 API가 낸다**
- [x] Given `points`가 없는(무추정) 이슈가 담긴 스프린트, When 합계를 보면, Then 무추정 이슈는 합계에 0으로 더해지지 않고 **무추정 N건**이 합계 옆에 별도로 표시되어 합계가 스코프 전부를 대표하지 않음을 드러낸다. — §7 R20(무추정 제외 원칙과 일관)
- [ ] Given ACTIVE 스프린트에 이슈를 추가·제거, When 처리되면, Then 성공하고 그 변화는 번다운의 **스코프 증감 선**에 반영된다(집계 자체는 R20). — AC23  
      **→ 이월: r20(M4) — 번다운 집계 자체가 R20. 스코프 증감은 이벤트로 이미 남는다**
- [x] Given 스프린트 담기/빼기, When 처리되면, Then 이벤트가 변경 전후 `sprint` 값과 함께 기록된다. — N7
- [ ] Given 이슈 5,000건 데이터셋, When 백로그 계획 화면을 열고 필터를 적용하면, Then N1 기준(첫 콘텐츠 렌더 p95 ≤ 1s, 필터 API p95 ≤ 300ms)을 만족한다.  
      **→ 이월: r07a(Wave 3) — 렌더 예산은 화면이 생긴 뒤 잰다. 필터 API는 p95 5ms로 측정했다**

> ✅ 해소: **상태 제약을 두지 않는다.** R20이 "번다운 분모에서 CANCELLED·무추정 제외"라고
> 규정한 것 자체가 **그런 이슈가 스코프에 들어올 수 있음을 전제**한다. 끝난 일을 스프린트에서
> 빼면 그 스프린트가 무엇을 해냈는지가 사라진다.
> ✅ 해소(S2-D4): **독립이며 따라오지 않는다.** 스토리가 두 스프린트에 걸치고 서브태스크
> 하나만 다음 스프린트에 들어가는 것은 흔한 일이다. 연동하면 카드 하나를 끌었는데 파일이
> 여러 개 바뀌어, r03이 세운 "한 번의 이동은 파일 1개"가 깨지고 **가리키지도 않은 작업이
> 조용히 옮겨간다**.
> ✅ 해소: **초과 시점만**이다. PRD §7 R6과 AC5가 일관되게 "capacity **초과**는 경고"라고
> 적는다. 근접 경고를 넣는 것은 없는 요구사항을 만드는 일이고, 임계값을 하나 더 두면
> 그 값 자체가 또 다른 미정이 된다.

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
