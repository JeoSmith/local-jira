---
title: "스프린트 CRUD (파일 SoT)"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R5
milestone: M2
priority: P0
---

# 스프린트 CRUD (파일 SoT)

> **R5 분할 사유**: 스프린트 레코드의 저장 계약(필드·RFC 3339 시각·capacity 단위)과 생명주기 전이(시작·종료·이월)는
> 검증 대상이 다르다. 앞쪽(r05a)은 파일 1건이 정확히 쓰이는지, 뒤쪽(`r05b`)은 상태 불변조건이 지켜지는지를 본다.

## 사용자 스토리 (User Story)

> **As a** 오너/PO,
> **I want** 스프린트를 이름·목표·기간·capacity와 함께 만들고 고치고 목록으로 볼 수 있기를,
> **so that** 스프린트 계획의 근거가 git으로 diff되는 파일 1개로 남고, 시작 전에 기간과 용량을 자유롭게 조정할 수 있다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 프로젝트 `LJ`가 초기화된 상태, When `POST /projects/LJ/sprints`에 `name="S3", goal="보드 MVP", start_at, end_at, capacity=24`를 보내면, Then 201과 함께 `id=LJ-S<n>`이 반환되고 `.localjira/sprints/LJ/LJ-S<n>.yaml` 파일 **1개**가 생성되며 `status: PLANNED`로 기록된다.
- [ ] Given 생성 요청, When 파일이 기록되면, Then frontmatter/YAML에 `id`, `name`, `goal`, `start_at`, `end_at`, `status`, `capacity`, `schema_version`이 포함된다. — §5.1
- [ ] Given `start_at="2026-08-03T09:00:00+09:00"`처럼 프로젝트 timezone offset이 붙은 값, When 저장되면, Then 파일에 **RFC 3339 문자열 그대로** 기록되고 사람이 읽는 형식(예: `8/3 오전 9시`)은 렌더링 시점에만 만들어진다. — §5.2
- [ ] Given `start_at="2026-08-03"`처럼 offset 없는 값 또는 RFC 3339가 아닌 문자열, When `POST`/`PATCH`를 호출하면, Then **400**과 함께 기대 형식이 반환되고 파일은 변경되지 않는다.
- [ ] Given `capacity`, When 값을 해석하면, Then 단위는 **스토리 포인트**다. 프로젝트의 `estimation_unit`은 스토리 포인트로 고정이며 시간 단위 capacity는 입력할 수 없다. — D8, §5.1
- [ ] Given 스프린트 3건(PLANNED 2 · CLOSED 1), When `GET /projects/LJ/sprints`를 호출하면, Then 200과 함께 3건이 반환되고 `status` 필터(`?status=PLANNED`)로 좁힐 수 있다.
- [ ] Given ETag `E1`으로 읽은 스프린트, When `If-Match: E1`로 `name`·`goal`·`start_at`·`end_at`·`capacity`를 수정하면, Then 200과 새 ETag가 반환된다. 다른 클라이언트가 먼저 바꿔 ETag가 달라진 상태면 **412**다(R10 규격).
- [ ] Given ACTIVE 상태의 스프린트, When `PATCH`로 `status: CLOSED`를 직접 보내면, Then **400**이다. 상태 전이는 명시적 시작/종료 명령(`r05b`)으로만 발생한다. — §5.2
- [ ] Given `end_at`이 이미 지난 PLANNED 스프린트와 `end_at`이 지난 ACTIVE 스프린트, When 서버를 재기동하고 목록을 조회하면, Then 두 스프린트의 `status`는 **그대로**다. 날짜 경과로 자동 전이하지 않는다. — §5.2
- [ ] Given 스프린트 생성·필드 변경, When 완료되면, Then 이벤트가 `actor_id`·`actor_kind`와 함께 기록된다(R14 규격). — N7
- [ ] Given 존재하지 않는 `LJ-S99`, When 조회·수정하면, Then 404다.
- [ ] Given `.localjira/sprints/LJ/` 아래에 YAML 파싱이 깨진 스프린트 파일, When 목록을 조회하면, Then 해당 항목은 `INVALID`로 격리되어 목록·집계에서 빠지고 나머지 스프린트는 정상 조회된다(R11 규격). — §5.6

> ⚠ 미정: 스프린트 **삭제**의 허용 여부와 정책(이슈가 담긴 스프린트 삭제 시 409인지, 담긴 이슈를 백로그로 되돌리는지, ACTIVE·CLOSED 삭제 가능 여부)을 PRD가 정하지 않았다. §5.1의 부모 삭제 `strategy` 규칙은 이슈 계층에만 적용된다.
> ⚠ 미정: `end_at ≤ start_at` 입력의 거부 여부와, 서로 다른 스프린트의 기간 겹침 허용 여부가 PRD에 없다.
> ⚠ 미정: 스프린트 생성·수정에 필요한 역할·scope가 §6.4 목록(`issue:*`, `run:write`)에 없다. `member` 이상의 일반 쓰기 권한으로 볼지, 별도 `sprint:*` scope를 둘지 미확정이다.

## 범위 밖 (Out of Scope)

- 시작·종료 명령, ACTIVE 유일성, 미완료 이슈 이월 → `r05b-sprint-start-close-carryover.md`
- 백로그↔스프린트 이슈 이동과 포인트 합계·capacity 경고 → `r06-sprint-planning-capacity.md`
- 칸반 보드 렌더 → `r07a-board-columns-cards.md`
- 번다운·완료율 → `r20-sprint-burndown.md`
- ETag 412 응답 본문 규격(R10), 이벤트 저장 형식(R14), 원자적 저장·outbox(R9), 격리 판정 엔진(R11) — 각 요구사항 스토리에서 다룬다. 여기서는 계약상 존재만 전제한다.

## 선행 의존 (Depends on)

- `r01a-issue-create-read.md`
- `r10-etag-optimistic-concurrency.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(Sprint 엔티티) · §5.2(스프린트 상태·RFC 3339) · §5.3(파일 레이아웃) · §5.6(격리) · §7 R5 · §8(스프린트 화면) · §13 D8
- 검증: PRD AC5
