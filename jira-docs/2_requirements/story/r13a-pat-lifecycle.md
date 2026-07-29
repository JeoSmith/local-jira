---
title: "PAT 발급·폐기·만료 수명 주기"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-29
related_prd: ../prd/backlog-sprint.md
requirement: R13
milestone: M3
priority: P0
---

# PAT 발급·폐기·만료 수명 주기

> R13을 두 스토리로 분할한다. 본 스토리는 **토큰의 생애**(발급·평문 1회 노출·해시 저장·폐기·만료·`last_used_at`)를 다루고,
> `r13b-pat-scope-enforcement.md`가 **토큰이 무엇을 할 수 있는가**(프로젝트 범위 + scope 강제, AC16의 403 절반)를 다룬다. 전자는 401, 후자는 403으로 검증 축이 갈린다.

## 사용자 스토리 (User Story)

> **As a** 에이전트를 돌리는 개발자,
> **I want** 머신 계정용 PAT를 발급하고 만료·최근 사용 시각을 보며 언제든 폐기할 수 있기를,
> **so that** 오작동하거나 유출된 에이전트 토큰을 즉시 끊고, 쓰이지 않는 토큰을 알아볼 수 있다.

## 인수 조건 (Acceptance Criteria)

- [x] Given 로그인한 사용자, When PAT를 발급하면, Then 응답에 **평문 토큰이 1회만** 포함되고 `token_id`·`user`·`scopes[]`·`project_scope`·`expires_at`이 함께 반환된다(N6, §5.1 Token).
- [x] Given 발급 완료, When 같은 PAT를 목록·상세로 다시 조회하면, Then 평문 토큰은 **어떤 응답에도 다시 나타나지 않으며** 재확인 수단이 없다.
- [x] Given 발급 완료, When 저장소를 확인하면, Then 토큰은 **해시로 `.local/credentials.sqlite`에만** 저장되고 `.localjira/` 아래 git 추적 경로(`users.yaml` 포함)에는 토큰 값·해시가 존재하지 않는다(N6).
- [x] Given `/settings` 화면, When PAT 목록을 열면, Then 각 토큰의 scope·`project_scope`·`expires_at`·`last_used_at`(최근 사용)이 표시된다(§8 설정 화면).
- [x] Given 유효한 PAT, When 해당 토큰으로 API를 호출하면, Then `last_used_at`이 갱신된다. 단 조회·검색 호출은 **감사 이벤트를 만들지 않는다**(N7 — 조회·검색 제외). `last_used_at` 갱신은 이벤트가 아니다.
- [x] Given 유효한 PAT, When 그 토큰을 폐기하고 **즉시** 같은 토큰으로 API를 호출하면, Then **401**이다(AC16). 캐시·프로세스 재기동 대기 없이 다음 요청부터 적용된다.
- [x] Given `expires_at`이 지난 PAT, When API를 호출하면, Then **401**이며, 만료 여부 판정에 서버 재기동이 필요하지 않다.
- [x] Given 존재하지 않거나 변조된 토큰 문자열, When API를 호출하면, Then **401**이다.
- [x] Given PAT 발급·폐기 요청, When 처리가 완료되면, Then 각각 이벤트로 남고(N7 "권한/토큰 변경") **이벤트 본문에 평문 토큰·토큰 해시는 포함되지 않으며** `token_id`로만 식별된다.
- [x] Given `.local/`을 삭제했거나 새 기기에서 클론한 상태, When 서버를 기동하면, Then 기존 PAT는 더 이상 유효하지 않고 **재발급이 정상 경로**로 안내된다. `.local/`은 백업 대상이 아니다(D5).

> 결정됨(S3-D7): 기본 90일. 상한 없음이며 무기한(`expires_at: null`) 토큰을 허용한다. 만료가
> 아무것도 걸러주지 않으므로 `last_used_at`이 "쓰이지 않는 토큰"을 알아보는 유일한 수단이며,
> 설정 목록에서 선택이 아닌 필수 열이다. 무기한은 "만료 무기한"으로 구분 표시한다.
> 결정됨(S3-D8): `member`는 자기 계정의 토큰을 발급·폐기한다. 타인 계정의 토큰은 `admin`만
> 발급한다 — 전자는 admin 계정 공유를, 후자는 남의 이름으로 남는 감사 기록을 막는다.

## 범위 밖 (Out of Scope)

- scope·프로젝트 범위의 강제 판정과 403 — `r13b-pat-scope-enforcement.md`.
- 토큰 자동 회전(rotation), 사용량 상한(rate limit), 만료 임박 알림 — PRD 미규정이며 1차 알림은 In-App 활동 피드까지(§3).
- 사람 세션 로그인 — `r12a-admin-bootstrap-login.md`.
- 토큰의 백업·기기 간 이전 (D5에 의해 명시적 비대상).

## 선행 의존 (Depends on)

- `r12b-role-authorization.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(Token 엔티티), §5.3(`.local/credentials.sqlite`), §6.4(PAT·`expires_at`·`last_used_at`), §7 R13, §8(설정 화면), §9 N6·N7, §12 M3, §13 D5
- 검증: PRD AC16
