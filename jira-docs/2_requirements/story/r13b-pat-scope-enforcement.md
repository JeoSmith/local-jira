---
title: "PAT 프로젝트 범위·scope 강제"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-29
related_prd: ../prd/backlog-sprint.md
requirement: R13
milestone: M3
priority: P0
---

# PAT 프로젝트 범위·scope 강제

> R13 분할 두 번째 스토리. 토큰이 살아 있다는 전제(`r13a`) 위에서 **그 토큰이 허용받은 행위의 경계**를 판정한다. 오작동한 에이전트의 폭발 반경 제한(D9)이 목적이다.

## 사용자 스토리 (User Story)

> **As a** 여러 에이전트를 동시에 돌리는 개발자,
> **I want** 각 PAT가 지정된 프로젝트와 scope 안에서만 동작하고 그 밖의 요청은 거부되기를,
> **so that** 잘못 동작하는 에이전트가 우선순위를 뒤집거나 이슈를 지우는 사고를 구조적으로 막을 수 있다.

## 인수 조건 (Acceptance Criteria)

- [x] Given PAT 발급 화면, When scope를 선택하면, Then 선택지는 정확히 `issue:read`, `issue:comment`, `issue:transition`, `issue:edit`, `issue:rank`, `run:write`, `issue:delete` 7종이며 그 외 값은 거부된다(§6.4).
- [x] Given 에이전트용 PAT를 기본값으로 발급, When 부여된 scope를 확인하면, Then `issue:read`·`issue:comment`·`issue:transition`·`run:write` 4종이며 **`issue:rank`와 `issue:delete`는 포함되지 않는다**(D9). 두 scope는 토큰별로 **명시 부여할 때만** 들어간다.
- [x] Given `issue:comment`만 가진 PAT, When 코멘트를 작성하면 성공하고, When 상태 전이·이슈 삭제·`backlog_rank`/`board_rank` 변경을 시도하면, Then 각각 **403**이다(AC16).
- [x] Given 위 요청들, When 성공·거부가 모두 발생한 뒤 감사 기록을 확인하면, Then 성공과 거부 **양쪽 모두** `token_id`와 함께 이벤트로 남는다(AC16, N7).
- [x] Given `project_scope`가 `LJ`인 PAT, When 다른 프로젝트의 이슈를 조회하거나 변경하면, Then **403**이며 해당 프로젝트 데이터가 응답 본문에 노출되지 않는다.
- [x] Given `issue:read`가 없는 PAT, When `GET /issues`를 호출하면, Then **403**이다.
- [x] Given `issue:transition` scope를 가졌지만 해당 이슈에 **본인 claim이 없는** 에이전트, When `IN_PROGRESS`·`IN_REVIEW`·`DONE`으로 전이를 시도하면, Then **403**이다(§6.1 claim↔전이 강제 결합, AC19). scope 보유는 전이 허용의 충분조건이 아니다.
- [ ] Given 본인 claim을 보유한 에이전트, When 같은 전이를 수행하면, Then 성공하고 타임라인에 `agent` 배지·`run_id`·`initiated_by`가 남는다(AC6).
- [x] Given `admin`·`member` 역할의 **사람 세션**, When 쓰기 API를 호출하면, Then 허용 여부는 scope가 아니라 역할로 판정된다. 사람은 claim 없이도 전이할 수 있으나, 타인의 유효 claim이 있으면 경고와 강제 여부 확인을 거친다(§6.1).
- [x] Given scope 검사에서 거부된 요청, When 파일 상태를 확인하면, Then `.localjira/` 아래 어떤 도메인 파일도 변경되지 않는다(거부는 부분 쓰기를 남기지 않는다).

> 이미 결정돼 있던 것: claim은 `IN_PROGRESS`·`IN_REVIEW`·`DONE` **셋에만** 강제된다(ADR-004 §2).
> 에이전트의 `TODO`·`BLOCKED`·`CANCELLED` 전이는 scope만으로 가능하다.
> 이미 결정돼 있던 것: `project_scope`는 **단수** 필드다(PRD §5.1 Token 엔티티).
>
> 결정됨(S3-D9): 특정 리소스가 범위 밖 프로젝트면 **403**, 목록 조회는 거부하지 않고 토큰의
> 프로젝트로 **좁힌다**. 컬렉션은 프로젝트를 지목하지 않으며, "무슨 일이 있나"를 묻는
> 에이전트에게는 오류가 아니라 자기 프로젝트를 답하는 것이 맞다.
> 결정됨(S3-D10): 토큰 요청에서는 **scope가 역할 검사를 대신한다.** `agent` 역할이 읽기만
> 갖도록 정해 둔 이유가 바로 scope에 판정을 넘기기 위해서였는데(D9), 둘 다 검사하면 역할이
> 자기가 양보한 scope를 도로 이기게 된다. 7종 중 `member`를 넘는 것이 없어 계정이 넓어지지도
> 않는다. scope가 `null`인 라우트(인덱스·스프린트·계정)에는 **어떤 토큰도 닿지 못한다.**
>
> ⚠ **AC8은 Wave 3(r16a)에서 닫힌다.** "본인 claim을 보유한 에이전트가 전이에 성공한다"는
> claim이 존재해야 검증할 수 있다. 그 반대편(claim 없는 전이는 403)은 지금 닫혔다 —
> claim이 없으므로 아무도 보유하지 않는다는 것이 참이기 때문이다.

## 범위 밖 (Out of Scope)

- 토큰 발급·폐기·만료 처리 — `r13a-pat-lifecycle.md`.
- claim 취득·lease·heartbeat·강제 해제의 동작 — R16.
- 이슈 단위·라벨 단위의 세분 권한, scope 커스텀 정의 (PRD는 고정 7종만 규정).
- 사람 역할 기반 인가 판정 — `r12b-role-authorization.md`.

## 선행 의존 (Depends on)

- `r13a-pat-lifecycle.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §6.1(claim↔전이 강제 결합), §6.4(scope 7종·기본 조합), §7 R13, §9 N7, §12 M3, §13 D9
- 검증: PRD AC16, AC6·AC19(claim 결합 부분)
