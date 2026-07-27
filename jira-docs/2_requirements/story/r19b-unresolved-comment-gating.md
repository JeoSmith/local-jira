---
title: "미해결 코멘트 게이팅 — 자동 claim·DONE 전환 차단"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R19
milestone: M4
priority: P1
---

# 미해결 코멘트 게이팅 — 자동 claim·DONE 전환 차단

> R19 분할 두 번째 스토리. `r19a`의 코멘트 종류·`resolved` 모델을 전제로, 그 상태가 **작업 흐름을 실제로 막는** 지점만 다룬다.

## 사용자 스토리 (User Story)

> **As a** 에이전트에게 질문을 남긴 개발자,
> **I want** 내 질문이나 리뷰 요청이 미해결인 동안 그 이슈의 자동 선점과 완료 전환이 막히기를,
> **so that** 내 질문이 활동 피드에 묻힌 채 에이전트가 계속 진행해 이슈가 `DONE`으로 넘어가는 일이 없다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 미해결 `question` 코멘트가 있는 이슈, When 에이전트가 `POST /issues/{id}/claim`을 호출하면, Then 사유와 함께 **거부(409)** 되며 응답에 차단 원인 코멘트가 식별된다(§6.3, AC22).
- [ ] Given 미해결 `review_request` 코멘트가 있는 이슈, When 같은 요청을 하면, Then 동일하게 거부된다(§6.3 — 두 종류가 게이팅 대상이다).
- [ ] Given 미해결 `general` 또는 `decision` 코멘트만 있는 이슈, When claim을 호출하면, Then **200**으로 성공한다. 게이팅 대상은 `question`·`review_request` 둘뿐이다(§6.3).
- [ ] Given 미해결 `question`이 있는 이슈, When `IN_REVIEW` → `DONE` 전이를 시도하면, Then 차단되고 사유가 반환된다(AC22).
- [ ] Given 그 `question`을 `resolve` 처리한 뒤, When 같은 claim·`DONE` 전이를 다시 시도하면, Then **허용된다**(AC22 — "해결 처리 후 허용된다").
- [ ] Given `resolve` 후 `unresolve`가 append된 코멘트, When 게이팅을 판정하면, Then op 재생 결과인 `resolved=false`를 기준으로 다시 차단된다(§6.3, `r19a`).
- [ ] Given `delete` op로 삭제 표시된 미해결 `question`, When 게이팅을 판정하면, Then 그 코멘트는 차단 요인에서 제외된다.
- [ ] Given 미해결 `question`이 있는 이슈, When 사람이 게이팅을 해제하면, Then 차단이 풀린다(§6.3 — "사람이 해제 가능"). 에이전트 토큰의 해제 시도는 **403**이다.
- [ ] Given 게이팅 해제·재차단, When 이벤트를 확인하면, Then 수행자와 사유가 기록된다(N7).
- [ ] Given 미해결 `question`이 있는 이슈, When `GET /issues/{id}`를 조회하면, Then `claimable=false`와 그 사유가 미완료 `blocked_by` 사유와 **구분 가능한 형태로** 반환된다(§5.2, R18 컨텍스트 API와 일관).
- [ ] Given `GET /issues?claimable=true` 필터, When 결과를 확인하면, Then 미해결 `question`·`review_request`를 가진 이슈가 후보에서 제외된다(S3, AC13 필터 성능 기준 유지).
- [ ] Given 미해결 `question`이 있는 이슈, When **사람**이 상태를 전이하면, Then §6.3의 해제 권한이 사람에게 있으므로 사람의 진행이 영구 차단되지 않는다(경고·확인 절차는 §6.1 사람 우선권과 동일한 방식).
- [ ] Given 미해결 `question`이 있고 이미 유효 claim을 보유한 에이전트, When `IN_PROGRESS` → `IN_REVIEW`로 전이하면, Then 게이팅 대상이 아니므로 성공한다(§6.3은 claim과 `DONE`만 차단한다).
- [ ] Given 게이팅으로 거부된 요청, When 파일 상태를 확인하면, Then `.localjira/` 아래 도메인 파일이 변경되지 않는다(거부는 부분 쓰기를 남기지 않는다).

> ⚠ 미정: "**자동** claim"의 범위 — 에이전트의 모든 claim을 뜻하는지, 별도의 자동 배정 모드만 뜻하는지 §6.3이 확정하지 않는다(본 스토리는 에이전트 claim 전체로 해석한다).
> ⚠ 미정: 사람의 "해제" 수단 — 코멘트를 `resolve`하는 것 외에 **게이팅만 무시하는 override**가 따로 있는지, 있다면 필요한 역할 등급(`member` 이상 여부)이 PRD에 없다.
> ⚠ 미정: 게이팅 거부의 **상태코드** — PRD는 차단만 규정한다(본 스토리는 claim 충돌과 동일하게 409로 둔다).
> ⚠ 미정: 미해결 코멘트가 사람의 `DONE` 전이도 차단하는지 — §6.3은 주체를 구분하지 않고 "차단하되 사람이 해제 가능"이라고만 쓴다.

## 범위 밖 (Out of Scope)

- 코멘트 종류·`resolved` 저장 모델과 op 재생 구현 — `r19a-comment-kind-and-resolution.md`.
- 미완료 `blocked_by`로 인한 `claimable=false` 판정 — `r16a-issue-claim.md`, §5.2.
- claim 원자성·409 판정 자체 — `r16a-issue-claim.md`.
- `DONE` 이후의 후속 처리(스프린트 종료 이월·번다운 반영) — R5·R20.
- 미해결 코멘트 알림·리마인더 발송 — §3 비목표.

## 선행 의존 (Depends on)

- `r19a-comment-kind-and-resolution.md`
- `r16a-issue-claim.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §4 S3, §5.2(`claimable=false`·전이표), §6.1(사람 우선권), §6.3, §7 R19, §9 N7, §12 M4
- 검증: PRD AC22, 보조 AC13·AC19
