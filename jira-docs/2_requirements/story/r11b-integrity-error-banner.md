---
title: "무결성 오류 배너와 격리 항목 화면"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R11
milestone: M1
priority: P0
---

# 무결성 오류 배너와 격리 항목 화면

> **R11 분할 사유**: 판정·격리 엔진(`r11a`)과 달리 본 스토리는 화면 노출·복구 안내를 다룬다. 검증 방법(E2E·시각 확인)과 완료 시점이 달라 분리한다.

## 사용자 스토리 (User Story)

> **As a** 팀원,
> **I want** 격리된 항목이 생긴 즉시 어느 화면에서든 배너로 알고 어떤 파일을 어떻게 고치면 되는지 바로 보기를,
> **so that** "왜 이슈가 안 보이지"를 뒤지지 않고 문제 파일을 직접 고쳐 스스로 복구할 수 있다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 격리 항목이 1건 이상인 프로젝트, When 백로그·보드·이슈 상세·스프린트 중 **어느 화면이든** 열면, Then 상단에 오류 배너가 표시되고 격리 건수와 유형 요약이 보인다. *(AC10)*
- [ ] Given 같은 상태, When `/settings`를 열면, Then 동일한 배너가 표시되고 격리 항목 목록으로 바로 진입할 수 있다. *(§5.6, §8)*
- [ ] Given 배너를 클릭, When 격리 항목 목록이 열리면, Then 각 항목에 **파일 경로**, 격리 유형, 오류 메시지, 발견 시각, **복구 방법 안내**가 표시된다(예: conflict marker 제거 후 저장 / 중복 `uid`는 한쪽 파일의 `uid` 재발급 / 없는 `parent` 참조 제거).
- [ ] Given 격리 항목이 0건, When 화면을 열면, Then 배너가 **표시되지 않는다**.
- [ ] Given 사람이 파일을 고쳐 격리가 해제됨, When 조정이 끝나면, Then 배너가 **새로고침 없이** 사라지거나 남은 건수로 갱신된다. *(r08b의 반영 경로 재사용)*
- [ ] Given 프로젝트가 "스프린트 충돌" 상태, When 배너를 보면, Then 그 사실과 **차단 중인 명령(스프린트 시작·종료)** 이 명시되고, 충돌한 두 스프린트 파일 경로가 표시된다.
- [ ] Given 격리된 이슈를 참조하는 변경을 시도해 409를 받음, When 화면을 보면, Then 실패 사유가 격리 때문임과 해당 파일 경로가 토스트/인라인 오류로 표시되어 배너와 같은 곳을 가리킨다.
- [ ] Given 격리 항목이 20건 이상, When 목록을 보면, Then 유형별로 묶여 표시되고 전체 건수가 배너에 정확히 반영된다.
- [ ] Given 라이트/다크 테마, When 배너·목록을 보면, Then 양쪽에서 대비가 유지되며 shadcn/ui + lucide 규약을 따른다. *(§8)*

## 범위 밖 (Out of Scope)

- 격리 판정·차단 로직과 `GET /integrity/issues` API → `r11a-integrity-validation-quarantine.md`
- UI에서의 자동 복구 버튼 — 복구는 사람이 파일을 고치는 것으로 한다
- 인덱스 상태 표시와 [전체 재인덱스]·[전체 검증] 버튼 → R21 (`r21-manual-reindex-full-verify.md`)
- 재키잉 이력 화면 → R26
- git 미커밋 배지 → R25

## 선행 의존 (Depends on)

- `r11a-integrity-validation-quarantine.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.6(오류 배너 노출 범위) · §8(화면 IA — 설정 화면의 격리 항목 목록)
- 검증: PRD AC10
