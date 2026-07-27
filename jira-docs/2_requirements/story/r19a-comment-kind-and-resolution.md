---
title: "코멘트 종류·해결 상태와 불변 원문 + op 재생"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R19
milestone: M4
priority: P1
---

# 코멘트 종류·해결 상태와 불변 원문 + op 재생

> R19 분할 첫 번째 스토리. 본 스토리는 **코멘트의 데이터 모델**(종류·`resolved`·불변 원문 + `.ops.jsonl` 재생)을 다루고, `r19b`가 그 모델을 근거로 **작업 흐름을 막는 게이팅**을 다룬다. 저장 모델은 인덱스 재빌드로, 게이팅은 API 거부로 검증된다.

## 사용자 스토리 (User Story)

> **As a** 에이전트와 같은 이슈에서 대화하는 개발자,
> **I want** 코멘트가 종류와 해결 상태를 갖고 그 변경이 원문을 덮어쓰지 않고 후속 op로 쌓이기를,
> **so that** 질문인지 결정인지 리뷰 요청인지가 구분되고, 두 클론이 같은 코멘트를 고쳐도 머지 충돌 없이 현재 상태를 계산할 수 있다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 코멘트 작성 요청, When `kind`를 지정하면, Then 허용 값은 정확히 `general` · `question` · `decision` · `review_request` 4종이며 그 외 값은 **400**이다(§6.3).
- [ ] Given 작성된 코멘트, When 조회하면, Then `comment_id`(ULID) · `author_id` · `author_display_name` · `actor_kind` · `kind` · `body` · `created_at`(RFC 3339)과 현재 `resolved` 상태가 반환된다(§5.1 Comment).
- [ ] Given 코멘트 작성, When 파일을 확인하면, Then `.localjira/comments/<이슈키>/<ULID>.md`에 **1건 = 1파일**로 저장되고 `git status`에 그 파일 1개만 잡힌다(§5.3, AC1 준용).
- [ ] Given 이미 작성된 코멘트, When `resolve` 처리하면, Then 원문 `.md` 파일은 **바이트 단위로 변경되지 않고** 같은 `comment_id`의 `<ULID>.ops.jsonl`에 op가 append된다(§5.3, §6.3).
- [ ] Given op 종류, When 확인하면, Then `resolve` · `unresolve` · `edit` · `delete` 4종이며 각 op에 `actor` · `at` · `payload`가 기록된다(§5.1 CommentOp).
- [ ] Given `resolve` 후 `unresolve`가 순서대로 append된 코멘트, When 현재 상태를 조회하면, Then **op 재생 결과**로 `resolved=false`다(§6.3 — 현재 상태는 재생으로 계산).
- [ ] Given `edit` op가 append된 코멘트, When 조회하면, Then 표시 본문은 최신 edit 결과이되 원문 파일은 그대로 남아 있다(§5.3 불변 원문).
- [ ] Given `delete` op가 append된 코멘트, When 이슈 코멘트 목록을 조회하면, Then 목록에 노출되지 않으나 원문 파일과 op 로그는 삭제되지 않는다(§5.3).
- [ ] Given 코멘트와 resolve op가 포함된 5,000건 규모 fixture, When `.local/index.sqlite`를 삭제하고 재기동하면, Then 삭제 전후 코멘트·해결 상태 응답이 정규화 비교로 동일하다(**AC2** — resolve op 포함 명시).
- [ ] Given 두 클론이 서로 다른 코멘트를 같은 이슈에 남긴 뒤 `git pull`, When 조정이 끝나면, Then 파일이 서로 달라 **머지 충돌 없이** 양쪽 코멘트가 모두 보인다(§5.3 분할 근거, AC11).
- [ ] Given `issue:comment` scope만 가진 PAT, When 코멘트를 작성하면 성공하고, When 상태 전이·삭제를 시도하면, Then **403**이다(AC16).
- [ ] Given `issue:comment` scope가 없는 PAT, When 코멘트를 작성하면, Then **403**이다.
- [ ] Given 코멘트 작성·op append, When 이벤트를 확인하면, Then 각각 이벤트로 남고 `actor_kind`(human/agent)가 구분 표기된다(N7, AC17).
- [ ] Given 같은 `Idempotency-Key`로 코멘트 작성을 재전송, When 처리하면, Then 최초 결과가 반환되고 코멘트 파일이 1개만 존재한다(AC18).
- [ ] Given 손상된 `.ops.jsonl` 한 줄(파싱 실패), When 조정이 끝나면, Then 해당 코멘트가 격리 표시되고 나머지 코멘트는 정상 동작한다(§5.6, AC10).

> ⚠ 미정: `kind`를 생략했을 때의 **기본값**과, 작성 후 `kind` 변경 가능 여부(op 종류에 `change_kind`가 없다) — PRD 미규정.
> ⚠ 미정: `resolve`/`edit`/`delete` op를 수행할 수 있는 **주체 제한** — 작성자 본인만인지, 사람만인지, 에이전트도 가능한지 PRD가 규정하지 않는다.
> ⚠ 미정: op 재생 순서의 기준 — 파일 append 순서인지 op의 `at` 값인지(두 클론의 op가 머지되면 두 순서가 갈릴 수 있다).

## 범위 밖 (Out of Scope)

- 미해결 `question`·`review_request`로 인한 claim·`DONE` 차단 — `r19b-unresolved-comment-gating.md`.
- 이슈 상세의 코멘트 UI 렌더링·활동 타임라인 통합 — `r14b-issue-activity-timeline.md`, §8.
- 코멘트 알림 발송 — 1차는 In-App 활동 피드까지(§3 비목표).
- 코멘트 전문 검색 — R4.
- 코멘트를 LLM에 전송하는 정책 — Q10(기본 가정상 코멘트는 미전송).
- 이벤트 append 경로 구현 — `r14a-event-recording.md`.

## 선행 의존 (Depends on)

- `r14a-event-recording.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(Comment·CommentOp), §5.3(코멘트 파일 분할·ops.jsonl), §5.6(격리), §6.3, §6.4, §7 R19, §9 N7, §12 M4
- 검증: PRD AC22(전제 모델), 보조 AC2·AC10·AC11·AC16·AC17·AC18
