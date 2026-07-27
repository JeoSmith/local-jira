---
title: "대량 변경 전체 조정과 삭제·rename tombstone"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R8
milestone: M1
priority: P0
---

# 대량 변경 전체 조정과 삭제·rename tombstone

> **R8 분할 사유**: 본 스토리는 R8(§5.5) 중 **git 동기화·대량 변경으로 인한 전체 조정과 삭제/이동 처리**만 다룬다. 팀 동기화(S6)의 성패가 여기에 달려 있어 단건 조정과 별도 검증이 필요하다.

## 사용자 스토리 (User Story)

> **As a** 팀원,
> **I want** `git -C .localjira pull` 후 서버를 재기동하지 않아도 보드가 최종 파일 상태와 정확히 일치하기를,
> **so that** 동기화가 git만으로 이뤄지는(D2) 환경에서 "내 화면이 지금 최신인가"를 의심하지 않아도 된다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given `git -C .localjira pull --rebase`가 fast-forward로 **1,000개 파일**을 바꿈, When `.git/HEAD` 또는 `index` 변화를 감지하면, Then 개별 워처 이벤트 처리 대신 **전체 조정**이 트리거되고 **≤ 15s**에 완료되며 결과가 최종 파일 상태와 일치한다. *(AC11, N2)*
- [ ] Given 워처 이벤트가 설정 임계치를 넘어 overflow, When 감지하면, Then 개별 이벤트 처리를 포기하고 전체 조정으로 승격하며, 조정 후 인덱스 상태가 파일 상태와 완전히 일치한다. *(AC11)*
- [ ] Given 팀원 A가 이슈 1건 생성 · 1건 수정 · 1건 삭제 후 push, When 팀원 B가 pull하면, Then **서버 재기동 없이** 세 변경이 모두 보드에 반영된다. *(AC11)*
- [ ] Given 이슈 파일이 삭제됨, When debounce 후 조정이 끝나면, Then 인덱스에 **tombstone**으로 반영되어 목록·집계·검색에서 사라지고, 삭제 이벤트가 `actor_kind=external`로 기록된다. 인덱스 레코드를 물리적으로 지워 이력이 사라지게 두지 않는다.
- [ ] Given 같은 `uid`를 가진 파일이 다른 경로로 rename됨, When 유예기간(**기본 60s**) 안에 새 경로에서 재등장하면, Then 삭제가 아니라 **이동**으로 인식해 동일 엔티티(uid·링크·이벤트 이력)로 복원하고 tombstone을 취소한다.
- [ ] Given 파일이 삭제된 뒤 유예기간 60s가 지나도 같은 uid가 재등장하지 않음, When 유예가 끝나면, Then 삭제로 확정하고 참조하던 링크는 R11의 참조 무결성 규칙으로 넘긴다.
- [ ] Given 전체 조정이 절반쯤 진행된 시점에 프로세스가 강제 종료됨, When 재기동해 조정을 처음부터 다시 수행하면, Then 최종 인덱스 상태가 중단 없이 완료한 경우와 동일하다(조정은 **멱등**).
- [ ] Given 전체 조정 중 API 쓰기 요청이 들어옴, When 처리하면, Then 그 쓰기 결과가 조정에 의해 되돌려지지 않는다(쓰기 → 파일 → 조정 순서가 역전되지 않는다).
- [ ] Given 전체 조정이 시작·완료됨, When 로그를 확인하면, Then 트리거 사유(`git_head_change` / `watcher_overflow` / `startup` / `manual`), 검사 파일 수, 변경 반영 건수, 소요 시간이 남는다.
- [ ] Given `git worktree`가 제거되어 `.localjira/`가 비어 있는 상태, When 서버가 기동하면, Then 전체 파일 삭제로 오인해 인덱스를 비우지 않고, **worktree 부재를 감지해 명확한 오류와 복구 명령을 출력**한 뒤 기동을 중단한다. *(ADR-006 Consequences)*
- [ ] Given 조정 결과로 tombstone 처리된 이슈, When 그 이슈를 조회하면, Then 404이며 응답에 마지막으로 알려진 파일 경로가 포함된다.

> ⚠ 미정: 워처 이벤트 overflow 승격의 임계치 기본값(건수/시간창)을 PRD가 수치로 정하지 않았다.

## 범위 밖 (Out of Scope)

- 인덱스 스키마·전체 재빌드 → `r08a-file-index-sync.md`
- 단건 외부 편집 반영·되울림 억제 → `r08b-external-change-reconcile.md`
- 머지로 깨진 도메인 불변조건의 격리 판정 → R11 (`r11a-integrity-validation-quarantine.md`)
- 중복 표시 키의 자동 재키잉 → R26 (`r26-auto-rekey-former-keys.md`)
- 서비스가 직접 `git pull`/`commit`/`push`를 수행하는 것 — D4에 따라 하지 않는다
- 머지 충돌 해소 UI

## 선행 의존 (Depends on)

- `r08a-file-index-sync.md`
- `r08b-external-change-reconcile.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.5(git checkout/pull·파일 삭제·rename) · §5.3(브랜치 배치) · §13 D1·D2 · §4 S6
- ADR `../../0_decisions/adr-006-shared-board-data-branch.md`
- 검증: PRD AC11, NFR N2
