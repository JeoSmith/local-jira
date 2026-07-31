---
title: "CLI 토큰 인증 — 에이전트가 CLI를 써도 주체가 agent로 남는다"
status: draft
owner: 이성훈
created: 2026-07-31
updated: 2026-07-31
related_prd: ../prd/backlog-sprint.md
requirement: R13
milestone: M5
priority: P1
---

# CLI 토큰 인증 — 에이전트가 CLI를 써도 주체가 agent로 남는다

> **D16의 전제 조건이다.** 정제를 철회하고 에이전트가 백로그를 직접 적재하기로 했는데, 그
> 결정이 안전한 근거 중 하나가 **`created_by_kind=agent` 배지**였다. AI 산출물이 사람 것처럼
> 보이지 않아야 한다는 §8이 그 배지로 지켜진다.
>
> 그런데 지금 `localjira issue create`는 세션이 없어 actor를 **`{id:"local", kind:"human"}`으로
> 고정**한다. 코드에 근거 주석까지 붙어 있다 — *"r12a가 붙기 전까지는 세션이 없으니 파일이
> 에이전트가 썼다고 주장하지 않도록 로컬 사람으로 기록한다."* 당시엔 옳았다. **r12a·r13a가
> 붙은 지금은 그 주석이 낡았고, 판단은 정반대 방향으로 틀린다.**
>
> 에이전트는 CLI를 먼저 집는다. 짧고, 토큰을 헤더에 실을 필요가 없고, 예제가 그렇게 생겼다.
> 그러면 **AI가 만든 이슈 전부가 사람이 만든 것으로 기록된다.** 배지는 조용히 거짓이 되고,
> D16이 "관문이 이미 있다"고 말한 근거 셋 중 하나가 무너진다.
>
> 검증이 거짓말할 수 있는 자리이므로 P1이다.

## 사용자 스토리 (User Story)

> **As a** 백로그를 적재하라고 지시받은 에이전트, 그리고 그 결과를 검토할 사람,
> **I want** CLI로 만든 이슈에도 **실제 주체가 그대로 기록되기**를,
> **so that** 화면의 `agent` 배지가 "AI가 만들었다"는 사실과 어긋나지 않고, 어느 경로로
> 만들었는지에 따라 기록이 달라지지 않는다.

## 인수 조건 (Acceptance Criteria)

### 인증

- [ ] Given `LOCALJIRA_TOKEN` 환경변수에 유효한 PAT, When `localjira issue create`를 실행하면, Then 그 토큰의 주체로 이슈가 만들어지고 파일에 **`created_by_kind: agent`** 가 기록된다.
- [ ] Given `--token <PAT>` 인자, When 실행하면, Then 같은 결과가 되며 **환경변수보다 인자가 우선**한다.
- [ ] Given 토큰이 전혀 없음, When 쓰기 명령을 실행하면, Then **거부한다.** 익명 쓰기를 조용히 `human`으로 기록하던 현재 동작을 없앤다 — 주체를 모르는 쓰기는 주체를 지어내는 것보다 실패하는 편이 낫다.
- [ ] Given 토큰이 없음, When **읽기** 명령(`issue list`·`issue show`·`index status`·`doctor`)을 실행하면, Then 그대로 동작한다. 로컬 파일을 읽는 데 인증을 요구하면 `doctor`가 자기 진단을 못 한다.
- [ ] Given 만료·폐기된 토큰, When 실행하면, Then 그 사유를 구분해 표시하고 종료 코드가 0이 아니다. *(r13a 수명 주기)*
- [ ] Given `issue:edit` scope가 없는 토큰, When `issue create`를 실행하면, Then **403 사유가 그대로 표시**되고 파일이 만들어지지 않는다. *(r13b, §6.4)*

### 기록의 일관성

- [ ] Given 같은 토큰, When **CLI로 만든 이슈와 HTTP API로 만든 이슈**를 비교하면, Then `created_by_kind`·`last_actor_kind`·`actor_id`가 **동일**하다. 경로가 기록을 바꾸지 않는다.
- [ ] Given CLI로 만든 이슈, When 활동 타임라인을 보면, Then `initiated_by`를 포함해 HTTP 경로와 같은 이벤트가 남는다. *(§9 N7, R14)*
- [ ] Given 토큰 사용, When 설정 화면의 PAT 목록을 보면, Then `last_used_at`이 갱신된다 — CLI 사용도 토큰 사용이다. *(r13a)*

### 토큰이 새지 않는다

- [ ] Given `--token`으로 실행, When `ps`·셸 히스토리에 노출되는 문제를 확인하면, Then **`LOCALJIRA_TOKEN` 환경변수 사용을 권장 경로로 안내**하고, `--help`가 그렇게 적는다.
- [ ] Given 어떤 실행이든, When 표준출력·표준오류·이벤트 파일·이슈 파일을 확인하면, Then **토큰 원문이 어디에도 남지 않는다.** 오류 메시지도 `ljp_…` 접두만 보인다. *(N6)*
- [ ] Given `--json` 출력, When 내용을 확인하면, Then 토큰 필드가 포함되지 않는다.

## 범위 밖 (Out of Scope)

- PAT 발급·폐기·만료 — `r13a`가 만들었다. 이 스토리는 CLI가 그것을 **쓰는** 쪽이다
- scope 판정 규칙 자체 — `r13b`
- 비밀번호 로그인 CLI — 에이전트의 경로는 PAT다. 사람이 CLI를 쓸 때는 여전히 로컬 실행이 곧 권한이라는 전제를 유지할지 설계에서 정한다
- CLI에서의 claim·전이·코멘트 — 지금 CLI에 없는 명령이고, 붙일지는 별 스토리다

> ⚠ 미정: 사람이 CLI를 쓸 때. 토큰 없는 쓰기를 전부 막으면 `admin create` 직후의 첫 이슈
> 생성도 막힌다 — 부트스트랩 경로에 예외를 둘지, admin이 자기 토큰을 먼저 만들게 할지.
> ⚠ 미정: 토큰을 파일(`~/.localjira/token`)에 두는 경로를 지원할지. 지원하면 편하지만
> 평문 보관을 권하는 셈이 되고, N6가 키를 git 밖에 두라고만 하지 평문 여부는 말하지 않는다.

## 선행 의존 (Depends on)

- `r13a-pat-lifecycle.md` (PAT 발급·검증·`last_used_at`)
- `r13b-pat-scope-enforcement.md` (scope 판정과 403)
- `r14a-event-recording.md` (actor 기록)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(`created_by_kind` 불변) · §6.4(scope) · §8(주체 표기 규칙) · §9 N6·N7 · §13 **D16**
- 검증: PRD AC6 · AC7
- 드러난 경로: D16 검토 중 `src/cli.ts`의 actor 고정(`{id:"local", kind:"human"}`)과 낡은 근거 주석 발견
