---
title: "스프린트 시작·종료와 미완료 이슈 이월"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R5
milestone: M2
priority: P0
---

# 스프린트 시작·종료와 미완료 이슈 이월

> **R5 분할 사유**: `r05a`가 스프린트 레코드의 저장 계약이라면, 본 스토리는 `PLANNED → ACTIVE → CLOSED` 전이와
> "프로젝트당 ACTIVE 1개"라는 불변조건, 종료 시 이월 처리를 다룬다. 검증이 상태 기계·동시성 쪽이라 분리한다.

## 사용자 스토리 (User Story)

> **As a** 오너/PO,
> **I want** 스프린트를 명시적으로 시작하고 종료하되 종료 시 남은 이슈를 어디로 보낼지 내가 고를 수 있기를,
> **so that** 보드가 항상 "지금 돌고 있는 스프린트 하나"를 가리키고, 못 끝낸 일이 조용히 사라지거나 종료된 스프린트에 묶인 채 남지 않는다.

## 인수 조건 (Acceptance Criteria)

### 시작 (PLANNED → ACTIVE)

- [ ] Given `PLANNED` 스프린트 `LJ-S3`와 프로젝트에 ACTIVE 스프린트가 없는 상태, When `POST /sprints/LJ-S3/start`를 호출하면, Then 200이고 `status: ACTIVE`로 파일이 갱신되며 보드(`/projects/LJ/board`)에 그 스프린트의 스코프가 표시된다. — AC5  
      **→ 이월: r07a(Wave 3) — 보드 화면이 거기서 생긴다. 시작 자체와 스코프 판정은 구현했다**
- [x] Given 이미 `LJ-S2`가 ACTIVE인 프로젝트, When `LJ-S3` 시작을 요청하면, Then **409**와 함께 현재 ACTIVE 스프린트 id가 사유로 반환되고 `LJ-S3`은 `PLANNED`로 남는다. **동시 ACTIVE는 프로젝트당 1개**다. — §5.2
- [x] Given 두 클라이언트가 서로 다른 PLANNED 스프린트를 **동시에** 시작 요청, When 서버가 처리하면, Then 하나만 200이고 나머지는 409다. ACTIVE가 2개가 되는 중간 상태가 관측되지 않는다.
- [x] Given 스코프 총 points 합계 30, capacity 24인 스프린트, When 시작을 요청하면, Then **200으로 시작되고** 응답·화면에 "capacity 24 대비 30 포인트(+6) 초과" 경고가 함께 표시된다. **초과는 경고일 뿐 시작을 차단하지 않는다.** — AC5, §7 R6
- [x] Given `CLOSED` 스프린트, When 시작을 요청하면, Then **409**다. 전이는 `PLANNED → ACTIVE → CLOSED` 단방향이며 되돌리는 전이가 없다. — §5.2
- [x] Given 시각이 `start_at` 이전이거나 `end_at` 이후인 상태, When 시작 명령을 보내면, Then 날짜와 무관하게 명령대로 처리된다. 반대로 명령을 보내지 않으면 `start_at`이 지나도 **자동으로 ACTIVE가 되지 않는다**. — §5.2

### 종료 (ACTIVE → CLOSED)와 이월

- [x] Given ACTIVE 스프린트에 `DONE` 3건 · `IN_PROGRESS` 2건 · `TODO` 1건, When `POST /sprints/LJ-S3/close`를 **옵션 없이** 호출하면, Then 미완료 3건의 목록과 이월 선택지가 반환되고, 선택 없이는 종료가 확정되지 않는다. — AC5
- [x] Given 위 상태, When 이월 대상 스프린트를 지정해 종료하면(`carry_over: {to: "LJ-S4"}`), Then 미완료 3건의 `sprint`가 `LJ-S4`로 바뀌고 `LJ-S3`은 `CLOSED`가 된다.
- [x] Given 위 상태, When 백로그 복귀를 선택해 종료하면(`carry_over: {to: null}`), Then 미완료 3건의 `sprint`가 비워지고 `LJ-S3`은 `CLOSED`가 된다.
- [x] Given 이월 대상으로 `CLOSED` 스프린트 또는 존재하지 않는 id를 지정, When 종료를 요청하면, Then **400**이고 원 스프린트는 `ACTIVE`로 남으며 어떤 이슈의 `sprint`도 바뀌지 않는다.
- [x] Given 이월된 이슈, When 이동 후 값을 확인하면, Then `backlog_rank`는 **보존**되고 `board_rank`는 새 정렬 영역 `(sprint_id, status)`에서 재산출된다. — §5.1
- [x] Given 종료 처리 도중 일부 이슈 쓰기가 실패, When 서버가 재기동되면, Then outbox 재생으로 이월과 스프린트 상태가 일관된 결과로 수렴하고 부분 YAML이 남지 않는다(R9 규격). — AC15
- [x] Given `PLANNED` 스프린트, When 종료를 요청하면, Then **409**다. `ACTIVE`가 아닌 스프린트는 종료할 수 없다.
- [x] Given `end_at`이 지난 ACTIVE 스프린트, When 아무 명령도 보내지 않으면, Then 상태는 `ACTIVE` 그대로이고 이월도 발생하지 않는다. — §5.2

### 불변조건 위반 시 차단

- [x] Given 머지 결과로 `ACTIVE` 스프린트가 2개가 된 프로젝트, When 시작·종료 명령을 보내면, Then 명령이 **차단**되고 프로젝트가 "스프린트 충돌" 상태로 표시되며 충돌한 두 파일 경로가 오류에 포함된다. — §5.6
- [x] Given 위 충돌 상태, When 사람이 한쪽 파일을 고쳐 ACTIVE를 1개로 만들면, Then 조정 후 시작·종료 명령이 다시 허용된다.
- [x] Given 시작·종료·이월, When 각 명령이 처리되면, Then 이벤트가 `actor_id`·`actor_kind`·대상·이월 건수와 함께 기록된다. — N7

> ✅ 해소: **`DONE`과 `CANCELLED`가 완료**, 나머지가 이월 대상이다. S1-D5가 취소된 차단자를
> 해제로 본 것과 같은 원칙이다 — 하지 않기로 한 일을 다음 스프린트 스코프로 밀어 넣으면
> "안 하기로 한 결정"이 계속 따라다닌다. 다만 S1-D5가 사유를 구분해 실었듯, 종료 응답은
> `cancelled`를 `unfinished`와 **따로** 실어 "끝냈다"와 "안 하기로 했다"가 같은 결과로
> 읽히지 않게 한다.
> ✅ 해소(S2-D5): **일괄 지정만** 한다. 종료는 파괴적인 명령이고, 거기에 N개의 판단을 얹으면
> 한 번의 요청이 여러 결정을 조용히 확정한다. 일부만 다른 곳으로 보내려면 **종료 전에**
> r06의 이동 API로 옮기면 된다 — 이미 있는 도구로 되는 일에 명령을 하나 더 만들지 않는다.
> ✅ 이미 결정돼 있었다 — **S2-D3의 `sprint:write`**(`member` 이상). 에이전트는 갖지 않는다.
> ⏭ 이월: claim 엔티티가 **M4(R16)** 에 생긴다. 지금은 해제할 대상이 없다.

## 범위 밖 (Out of Scope)

- 스프린트 생성·수정·목록·필드 검증 → `r05a-sprint-crud.md`
- 계획 단계의 이슈 담기/빼기와 포인트 합계 UI → `r06-sprint-planning-capacity.md`
- 종료 후 번다운·완료율 집계 → `r20-sprint-burndown.md`
- 보드 컬럼 렌더·드래그 전이 → `r07a`, `r07b`
- 격리 배너 화면 → `r11b-integrity-error-banner.md`
- claim 강제 해제·run 취소 → R16·R17

## 선행 의존 (Depends on)

- `r05a-sprint-crud.md`
- `r06-sprint-planning-capacity.md` (capacity 경고 산출식을 공유한다)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(정렬 필드 2종) · §5.2(스프린트 상태·ACTIVE 유일성·자동 전이 없음) · §5.6(ACTIVE 2개 이상 시 명령 차단) · §7 R5·R6 · §9 N7 · §13 D8
- 검증: PRD AC5 (보조: AC15)
