---
title: "admin 부트스트랩과 로컬 계정 로그인"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R12
milestone: M1
priority: P0
---

# admin 부트스트랩과 로컬 계정 로그인

> R12를 두 스토리로 분할한다. 본 스토리는 **자격증명의 생성·저장·검증 경로**(부트스트랩·로그인·N6 저장 위치 제약)를 다루고,
> `r12b-role-authorization.md`가 **인가 판정**(역할별 허용/거부, AC7)을 다룬다. 검증 수단과 실패 코드(401 vs 403)가 서로 다르기 때문이다.

## 사용자 스토리 (User Story)

> **As a** 로컬 이슈 트래커를 처음 띄우는 사용자,
> **I want** 외부 SSO 없이 첫 admin 계정을 만들고 아이디·비밀번호로 로그인하며 자격증명이 git에 절대 올라가지 않기를,
> **so that** 네트워크 없이 단독 기동하면서도(N4) 팀 저장소에 비밀번호가 커밋되는 사고를 구조적으로 막을 수 있다.

## 인수 조건 (Acceptance Criteria)

- [x] Given `.localjira/users.yaml`에 계정이 0건인 최초 설치 상태, When 서버를 기동하면, Then 부트스트랩 모드로 진입해 admin 계정 1건(식별자·표시명·비밀번호) 생성을 요구하고, 완료 전까지 도메인 API(`GET /issues`, `POST /issues` 등)는 전부 **401**을 반환한다.
- [x] Given 부트스트랩 완료, When `.localjira/users.yaml`을 열면, Then 해당 계정의 `id`·`display_name`·`role: admin`만 존재하고 비밀번호 해시·salt·토큰 등 자격증명 필드는 **한 개도 존재하지 않는다**(N6, §5.3).
- [x] Given 부트스트랩 완료, When `git -C .localjira status`를 확인하면, Then 변경 파일로 `users.yaml`만 잡히고 `.local/credentials.sqlite`는 `.gitignore`에 의해 추적되지 않는다.
- [x] Given 비밀번호가 저장된 상태, When `.local/credentials.sqlite`의 레코드를 확인하면, Then 값이 **argon2id 해시**이며 평문 비밀번호는 파일·로그·API 응답 어디에도 남지 않는다(N6).
- [x] Given 유효한 계정, When 올바른 식별자·비밀번호로 로그인 API를 호출하면, Then **200**과 함께 세션이 발급되고 후속 도메인 API 요청이 인증된 `actor_id`로 처리된다.
- [x] Given 유효한 계정, When 틀린 비밀번호로 로그인하면, Then **401**이며 세션이 발급되지 않고, 이후 도메인 API 호출도 401이다.
- [x] Given 로그인하지 않은 클라이언트, When `POST /issues`를 호출하면, Then **401**이다. (권한 부족을 뜻하는 403과 응답 코드가 구분된다 — `r12b` 참조.)
- [x] Given admin이 로그인한 상태, When 계정 1건을 추가로 생성하면, Then `users.yaml`에 식별자·표시명·역할이 추가되고 비밀번호 해시는 `.local/credentials.sqlite`에만 기록되며, 계정 생성 사실이 **이벤트로 남는다**(N7 "권한/토큰 변경", R14).
- [x] Given 기존 보드를 `git clone`으로 받은 새 기기, When 서버를 기동하면, Then `users.yaml`의 계정 목록은 보이지만 해당 기기에 자격증명이 없으므로 로그인할 수 없고, 비밀번호 재설정이 **정상 경로**로 안내된다(D5 — `.local/`은 백업 대상이 아니다).
- [x] Given 로그인 시도, When 성공·실패가 발생하면, Then 응답 지연·에러 메시지가 저장된 해시를 역추론할 수 있는 정보를 노출하지 않는다.

> ⚠ 미정: 세션 전달 방식(HTTP-only 쿠키 vs 세션 토큰 헤더)과 세션 만료 시간 — PRD는 PAT의 `expires_at`만 규정하고 사람 세션 수명은 언급하지 않는다.
> ⚠ 미정: `.local/credentials.sqlite`가 없는 기기에서 비밀번호를 다시 세우는 구체적 절차(admin이 원격에서 재설정할 수 없으므로 로컬 CLI 재설정 명령이 필요한지) — D5는 "기기별 재발급이 정상 경로"라고만 말한다.

## 범위 밖 (Out of Scope)

- 외부 SSO/OIDC 연동 (§3 비목표).
- 비밀번호 복잡도 정책·만료 강제·다중 인증(MFA) — PRD 미규정.
- PAT 발급·검증 — `r13a-pat-lifecycle.md`.
- 역할별 인가 판정과 403 처리 — `r12b-role-authorization.md`.
- `.local/credentials.sqlite`의 백업·기기 간 이전 (D5에 의해 명시적 비대상).

## 선행 의존 (Depends on)

- 없음 (M1 최초 스토리 중 하나)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.3(파일 레이아웃 · `users.yaml` / `.local/credentials.sqlite`), §6.4(역할), §7 R12, §9 N6, §12 M1, §13 D5
- 검증: PRD AC7(선행 인증 조건)
