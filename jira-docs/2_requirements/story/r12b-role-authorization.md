---
title: "역할(admin/member/agent) 기반 인가"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R12
milestone: M1
priority: P0
---

# 역할(admin/member/agent) 기반 인가

> R12 분할 두 번째 스토리. 자격증명 경로(`r12a`)와 달리 여기서는 **인증된 주체가 무엇을 할 수 있는가**를 판정하며, 검증 지표가 AC7(403)이다.

## 사용자 스토리 (User Story)

> **As a** 팀 보드를 운영하는 admin,
> **I want** 계정마다 `admin` / `member` / `agent` 역할이 부여되고 역할 밖의 쓰기가 거부되기를,
> **so that** 사람은 보드를 함께 쓰되 계정·역할 같은 운영 권한은 admin에 남고, 에이전트는 토큰 scope 밖으로 나가지 못한다.

## 인수 조건 (Acceptance Criteria)

- [x] Given `users.yaml`의 계정, When `role` 값을 확인하면, Then `admin` / `member` / `agent` 셋 중 하나이며 그 외 값은 로드 시 거부된다(§6.4).
- [x] Given `member` 세션, When 이슈 생성·필드 수정·상태 전이·코멘트 작성·`backlog_rank` 변경을 수행하면, Then 모두 성공한다(`member` = 쓰기).
- [x] Given `member` 세션, When 계정 생성·타 계정의 역할 변경·타인 PAT 폐기를 시도하면, Then **403**이며 해당 시도가 이벤트로 남는다(N7 "권한/토큰 변경").
- [x] Given `admin` 세션, When 위와 같은 계정·역할·토큰 운영 작업을 수행하면, Then 성공한다(`admin` = 전체).
- [x] Given `CANCELLED` 상태의 이슈, When `member`가 `BACKLOG`로 되돌리면 **403**이고, `admin`이 같은 전이를 수행하면 **200**이다(§5.2 전이표 — `CANCELLED → BACKLOG`는 admin 전용).
- [ ] Given `agent` 역할 계정, When 세션 없이 PAT로 API를 호출하면, Then 허용 범위는 역할이 아니라 **토큰 scope**로 판정된다(§6.4 — `agent`는 토큰 scope에 종속). scope 강제의 상세는 `r13b`.  
      **→ 이월: r13b-pat-scope(M4)**
- [x] Given 인증되지 않은 요청과 인증됐지만 권한이 없는 요청, When 각각 쓰기 API를 호출하면, Then 전자는 **401**, 후자는 **403**으로 구분되어 응답한다(AC7).
- [ ] Given 다른 사용자의 유효한 claim이 걸린 이슈, When `member` 이상이 claim 강제 해제를 요청하면, Then 허용된다(D7 — 강제 해제는 `member` 이상). 강제 해제 절차 자체는 R16 범위다.  
      **→ 이월: r16-claim-lease(M4) — claim 엔티티가 M4에서 생긴다**
- [x] Given admin이 어떤 계정의 역할을 `member` → `admin`으로 변경, When 해당 계정이 다음 요청을 보내면, Then **재로그인 없이 즉시** 새 역할로 판정되고, 역할 변경 이벤트에 변경 전/후 역할과 수행자가 남는다.
- [x] Given 시스템에 admin이 1명뿐인 상태, When 그 계정의 역할을 강등하거나 삭제하려 하면, Then 거부되어 보드가 admin 없는 상태로 빠지지 않는다.

> ⚠ 미정: `member`가 타인이 만든 이슈를 **삭제**할 수 있는지 — PRD는 `member`를 "쓰기"로만 규정하고, `issue:delete`는 PAT scope 축(사람 전용, D9)에서만 다룬다. 역할 축에서 삭제 권한의 경계가 명시되지 않았다.
> ⚠ 미정: 사용자가 **자기 자신의** 비밀번호·표시명을 변경할 수 있는지(자기 계정 한정 예외) — PRD 미규정.

## 범위 밖 (Out of Scope)

- PAT scope 목록 정의와 scope 단위 강제 — `r13b-pat-scope-enforcement.md`.
- 이슈별·프로젝트별 세분 ACL, 커스텀 역할 정의 (PRD는 고정 3역할만 규정).
- 로그인·세션 발급 자체 — `r12a-admin-bootstrap-login.md`.
- claim 강제 해제의 동작(회수·run 취소·409 처리) — R16.

## 선행 의존 (Depends on)

- `r12a-admin-bootstrap-login.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.2(상태 전이표 — `CANCELLED → BACKLOG`는 admin), §6.4(권한 scope · 역할), §7 R12, §9 N7, §12 M1, §13 D7
- 검증: PRD AC7
