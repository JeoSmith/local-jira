---
title: "이슈 수정·상태 전이·삭제"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R1
milestone: M1
priority: P0
---

# 이슈 수정·상태 전이·삭제

> R1을 둘로 쪼갠 뒤쪽. 필드 수정에는 불변 필드·상태 전이표(§5.2)라는 별도 규칙 집합이 붙어서 생성 스토리와 검증 항목이 겹치지 않는다.

## 사용자 스토리 (User Story)

> **As a** 개발자,
> **I want** 이슈의 필드와 상태를 API·UI에서 고치고 필요 없어진 이슈를 지울 수 있기를,
> **so that** 보드 상태가 실제 작업과 어긋나지 않고, 잘못 만든 티켓이 백로그에 남지 않는다.

## 인수 조건 (Acceptance Criteria)

- [x] Given ETag `E1`으로 읽은 이슈, When `If-Match: E1`과 함께 `title`·`assignee`·`labels`·`points`·`acceptance`를 수정하면, Then 200과 새 ETag가 반환되고 `updated_at`이 갱신되며 변경 파일은 그 이슈 파일 **1개**다.
- [x] Given 같은 수정 요청, When 저장되면, Then 요청에 없던 frontmatter 키와 본문은 그대로 보존된다.
- [x] Given 수정 요청 본문에 `uid`, `key`, `created_by_kind`, `created_at`이 포함된 경우, When 호출하면, Then 400을 반환한다 — `created_by_kind`는 불변이고 `key`는 서버 발급 값이다.
- [x] Given `status=BACKLOG`인 이슈, When `IN_PROGRESS`로 전이를 요청하면, Then §5.2 표에 없는 전이이므로 400과 함께 허용 전이 목록이 반환되고 파일은 변경되지 않는다.
- [x] Given `status=BACKLOG`인 이슈, When `TODO`로 전이하면 200이고, `TODO → IN_PROGRESS → IN_REVIEW → DONE`도 각각 200이며, `DONE → IN_PROGRESS`는 200이지만 `DONE → TODO`는 400이다.
- [x] Given `status=IN_PROGRESS`인 이슈, When `BLOCKED`로 전이하면, Then 진입 직전 상태가 `blocked_from`으로 보존되고, `BLOCKED`에서의 복귀는 `blocked_from` 값으로만 허용되며 다른 상태로의 복귀는 400이다(`CANCELLED` 전이는 허용).
- [x] Given `status=CANCELLED`인 이슈와 `member` 역할 계정, When `BACKLOG`로 되돌리면, Then 403이고 `admin` 계정으로는 200이다.
- [x] Given 하위 이슈가 없는 이슈, When `DELETE /issues/{key}`를 호출하면, Then 204와 함께 `.localjira/issues/LJ/LJ-<n>.md`가 삭제되고 인덱스에 tombstone으로 반영되어 목록·검색에서 사라진다.
- [ ] Given `issue:delete` scope가 없는 에이전트 토큰, When 삭제를 요청하면, Then 403이다(D9 — 삭제는 사람 전용이 기본).  
      **→ 이월: r13b-pat-scope(M4) — PAT·scope가 아직 없어 역할로만 차단된다**
- [x] Given 하위 이슈가 있는 부모, When `strategy` 없이 삭제하면, Then 409다 — 상세 동작은 `r02a-issue-hierarchy.md`.

> ⚠ 미정: 상태 전이를 일반 필드 수정(`PUT /issues/{key}`)에 섞어 보낼 수 있는지, 아니면 전용 엔드포인트(예: `POST /issues/{key}/transition`)로만 받는지를 PRD가 명시하지 않았다.

## 범위 밖 (Out of Scope)

- ETag 불일치 412 응답 본문 규격(현재 문서 전문·거부된 값) — R10
- 에이전트의 전이에 유효 claim을 강제하는 규칙(claim 없으면 403) — R16
- 미해결 `question`/`review_request`로 인한 `DONE` 차단 — R19
- 보드 드래그로 발생하는 전이 UX와 카드 롤백 — R7 / AC14
- 부모 삭제 `promote`/`cascade_cancel` — R2
- 변경 이벤트 기록·타임라인 표시 — R14

## 선행 의존 (Depends on)

- `r01a-issue-create-read.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1, §5.2, §6.4, §7 R1, §13 D9
- 검증: PRD AC1, AC14(전이표 준수 규칙의 근거), AC16(scope 거부)
