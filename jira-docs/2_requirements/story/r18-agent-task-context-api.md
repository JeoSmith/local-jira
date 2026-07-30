---
title: "에이전트용 구조화 작업 컨텍스트 API"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-30
related_prd: ../prd/backlog-sprint.md
requirement: R18
milestone: M4
priority: P1
---

# 에이전트용 구조화 작업 컨텍스트 API

## 사용자 스토리 (User Story)

> **As a** 이슈를 집어 작업을 시작하는 에이전트,
> **I want** 목표·인수조건·의존성·최신 사람 지시·허용 범위와 현재 ETag를 구조화된 한 응답으로 받기를,
> **so that** 코멘트 전문을 읽고 무엇이 지시인지 스스로 추측하지 않아도 되고, 사람이 티켓 내용을 복사·붙여넣지 않아도 된다.

## 인수 조건 (Acceptance Criteria)

- [x] Given 이슈 하나, When 에이전트가 작업 컨텍스트 API를 호출하면, Then **현재 ETag · 목표 · 인수조건 · 의존성 · 최신 사람 지시 · 허용 작업 범위** 여섯 항목이 구조화되어 반환된다(§6.2, AC21).
- [x] Given 같은 응답, When 본문을 확인하면, Then **코멘트 전문 목록이 통째로 실려 있지 않다**(§6.2 — "코멘트 전문을 통째로 읽고 알아서 판단하게 두지 않는다").
- [x] Given 응답의 ETag, When 그 값을 `If-Match`로 실어 이슈를 수정하면, Then 성공한다. 즉 §5.4의 **강한 ETag(`"<content-hash>"`)와 동일한 값**이며 별도 토큰이 아니다(R10).
- [x] Given 컨텍스트 조회 후 다른 클라이언트가 같은 이슈를 먼저 수정한 상황, When 에이전트가 받은 ETag로 수정하면, Then **412**와 함께 현재 문서 전문·최신 ETag·거부된 요청 값이 반환된다(AC8).
- [x] Given 인수조건, When 응답을 확인하면, Then 이슈 frontmatter의 `acceptance[]`(`id`·`text`·`done`) 구조가 그대로 전달되며, **본문 heading 파싱 결과가 아니다**(§5.3).
- [x] Given 미완료 `blocked_by` 링크가 있는 이슈, When 컨텍스트를 조회하면, Then 의존성 항목에 선행 이슈와 그 상태가 담기고 `claimable=false` 및 **차단 사유**가 함께 반환된다(§5.2).
- [x] Given 계층 부모(`epic`)가 있는 이슈, When 컨텍스트를 조회하면, Then 의존성/맥락 항목에 부모 참조가 uid와 표시 키로 포함된다(§5.1).
- [x] Given 사람이 남긴 지시성 코멘트가 여러 건인 이슈, When 컨텍스트를 조회하면, Then **가장 최신 사람 지시**가 단일 항목으로 제공되어 활동 피드에 묻히지 않는다(§6.2, §6.3).
- [x] Given 호출한 PAT의 scope, When 허용 작업 범위 항목을 확인하면, Then 그 토큰으로 수행 가능한 작업이 명시되며 `issue:rank`·`issue:delete`는 기본 에이전트 토큰에서 제외되어 있다(§6.4, D9).
- [x] Given `issue:read` scope가 없는 PAT, When 컨텍스트 API를 호출하면, Then **403**이다(§6.4).
- [x] Given `project_scope` 밖의 이슈, When 컨텍스트를 조회하면, Then **403**이며 해당 이슈 내용이 응답에 노출되지 않는다(AC16).
- [x] Given 파싱 실패·conflict marker로 **격리(`INVALID`)** 된 이슈, When 컨텍스트를 조회하면, Then 정상 컨텍스트 대신 격리 상태와 파일 경로가 반환되고 그 이슈에 대한 변경은 차단된 상태다(§5.6, AC10).
- [x] Given `former_keys`에 있는 이전 키, When 그 키로 컨텍스트를 조회하면, Then alias로 해석되어 동일 이슈의 컨텍스트가 반환된다(D3, AC25).
- [x] Given 컨텍스트 조회, When 이벤트를 확인하면, Then **이벤트가 생성되지 않는다**(N7 — 조회·검색은 감사 범위 제외).
- [x] Given 5,000건 데이터셋, When 컨텍스트 API를 반복 호출하면, Then 응답 p95가 N1의 API 기준(≤ 300ms)을 만족한다.

> 결정됨: 경로는 `GET /issues/{key}/context`이며 응답은 `etag`·`goal`·`acceptance`·
> `dependencies`·`latest_instruction`·`allowed` 여섯 항목이다. 코멘트 목록은 싣지 않는다.
> 결정됨(S4-D5): "최신 사람 지시"는 `actor_kind=human`이면서 `kind`가 `question` 또는
> `decision`인 것 중 가장 최근 것이다. 사람 코멘트 전부로 잡으면 "고생하셨습니다"가 지시
> 자리에 올라온다. `review_request`는 사람들 사이의 요청이라 제외한다. 없으면 `null`이며
> 비어 있음이 정상이다.
> 결정됨(S4-D6): "허용 작업 범위"는 토큰 scope와 그로부터 이 이슈에 지금 가능한 전이다. 코드
> 경로·브랜치 경계는 이 도구가 모르는 정보이고, 모르는 것을 구조화해 돌려주면 에이전트가
> 그것을 사실로 믿는다.

## 범위 밖 (Out of Scope)

- 코멘트 종류·해결 상태 모델과 미해결 게이팅 — R19.
- claim 취득·전이 권한 판정 — R16.
- 이슈 CRUD·검색·필터 API — R1·R4.
- ETag 동시성 자체의 구현(412 응답 형식) — `r10-etag-optimistic-concurrency.md`.
- 컨텍스트를 LLM에 전송하는 정책 — Q10 미결이며 M5(R22) 범위다.
- 에이전트 프롬프트 템플릿·MCP 서버 제공.

## 선행 의존 (Depends on)

- `r16a-issue-claim.md`
- `r10-etag-optimistic-concurrency.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §2 P3, §5.1, §5.2(`claimable=false` 사유), §5.3(frontmatter·본문 미파싱), §5.4(강한 ETag), §5.6(격리), §6.2, §6.4, §7 R18, §9 N1·N7, §12 M4, §13 D3·D9
- 검증: PRD AC21, 보조 AC8·AC10·AC16·AC25
