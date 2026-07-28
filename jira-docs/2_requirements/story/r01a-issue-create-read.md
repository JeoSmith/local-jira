---
title: "이슈 생성·조회 (파일 SoT)"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R1
milestone: M1
priority: P0
---

# 이슈 생성·조회 (파일 SoT)

> R1을 둘로 쪼갠 앞쪽. 생성·조회는 "파일 1개 = 이슈 1건" 저장 계약과 키 발급을 세우는 일이고,
> 수정·삭제(r01b)는 그 위에 상태 전이표와 불변 필드 규칙을 얹는 일이라 검증 대상이 다르다.

## 사용자 스토리 (User Story)

> **As a** 오너/PO,
> **I want** REST API와 백로그 화면에서 이슈를 만들고 그 내용을 다시 읽을 수 있기를,
> **so that** 티켓 1건이 git으로 diff·리뷰되는 마크다운 파일 1개로 남고, AI 에이전트가 같은 내용을 파일로도 API로도 읽을 수 있다.

## 인수 조건 (Acceptance Criteria)

- [x] Given 프로젝트 `LJ`가 초기화된 상태, When `POST /issues`에 `type=story, title="백로그 리스트 가상 스크롤"`을 보내면, Then 201과 함께 `uid`(ULID)·서버 발급 표시 키 `LJ-<n>`이 반환되고 `.localjira/issues/LJ/LJ-<n>.md` 파일 1개가 생성된다.
- [x] Given 위 생성 직후, When `git -C .localjira status`를 확인하면, Then 신규 파일은 그 이슈 파일 **1개만** 잡힌다(인덱스·outbox·runtime은 `.local/`이라 추적 대상이 아니다). — AC1
- [x] Given 생성 요청, When 파일이 기록되면, Then frontmatter에 `uid`, `key`, `former_keys: []`, `type`, `title`, `status`, `created_at`, `updated_at`, `created_by_kind`, `schema_version: 1`이 포함되고 모든 시각은 프로젝트 timezone offset이 붙은 RFC 3339 문자열이다.
- [x] Given `type`이 `epic|story|task|bug|spike|subtask` 중 하나가 아닌 요청, When `POST /issues`를 호출하면, Then 400과 함께 허용 타입 목록이 반환되고 파일은 생성되지 않는다.
- [x] Given `assignee`(human 또는 agent User), `labels`, `points`, `acceptance`를 포함한 생성 요청, When 저장되면, Then `acceptance`는 frontmatter에 `{id, text, done}` 객체 배열로 기록되고 본문 heading으로는 기록되지 않는다.
- [x] Given 설명(description)을 포함한 생성 요청, When 저장되면, Then 설명은 frontmatter 아래 본문에 원문 그대로 들어가고, 서버는 본문의 heading을 도메인 구분자로 해석하지 않는다.
- [x] Given 저장된 이슈, When `GET /issues/{key}` 또는 `GET /issues/{uid}`를 호출하면, Then 200과 함께 동일한 도메인 데이터가 반환되고 응답 헤더에 정규화 내용 기준 강한 `ETag`가 실린다(동시성 동작 자체는 R10).
- [x] Given 사람이 에디터로 frontmatter에 서버가 모르는 키를 추가한 파일, When 조회·재저장하면, Then 그 키와 본문이 원문 그대로 보존되고 API가 임의로 재작성하지 않는다.
- [x] Given `status`를 지정하지 않은 생성 요청, When 저장되면, Then `status=BACKLOG`로 기록된다(§6.1 — 에이전트는 사람이 `TODO`로 올린 것만 집는다는 전제).
- [x] Given 존재하지 않는 키 `LJ-9999`, When 조회하면, Then 404를 반환한다.

> ⚠ 미정: 생성 시 클라이언트가 `status`를 `BACKLOG` 외 값으로 직접 지정할 수 있는지, 그리고 `points`의 허용값 집합(양의 정수만/피보나치/0 허용)을 PRD가 정하지 않았다.

## 범위 밖 (Out of Scope)

- 수정·삭제·상태 전이 — `r01b-issue-update-delete.md`
- `parent` 지정과 계층 규칙 검증 — `r02a-issue-hierarchy.md`
- `links[]` 등록 — `r02b-issue-links.md`
- `backlog_rank`/`board_rank` 값 산출 — `r03-backlog-rank-lexorank.md`
- `Idempotency-Key` 처리(R15), ETag 충돌 412 처리(R10), 인덱스 upsert·outbox(R8·R9), 이벤트 기록(R14)은 각 요구사항 스토리에서 다룬다. 여기서는 계약상 존재만 전제한다.
- 표시 키 충돌 시 자동 재키잉(R26).

## 선행 의존 (Depends on)

- 없음 (M1 최초 스토리. 단, 통합 검증 시 R8 인덱스·R12 admin 부트스트랩이 함께 필요하다)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1, §5.3, §7 R1, §8
- 검증: PRD AC1
