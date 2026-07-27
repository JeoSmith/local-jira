---
title: "git 상태 배지 — 미커밋 건수와 마지막 push 시각"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R25
milestone: M2
priority: P1
---

# git 상태 배지 — 미커밋 건수와 마지막 push 시각

## 사용자 스토리 (User Story)

> **As a** 팀원,
> **I want** 보드 데이터가 아직 커밋·푸시되지 않았다는 사실을 어느 화면에서든 상단 배지로 계속 보기를,
> **so that** 서비스가 대신 커밋해 주지 않는다는 전제 아래에서도 로컬 디스크에만 있는 이슈를 방치해 잃지 않는다.

## 인수 조건 (Acceptance Criteria)

### 조회 대상과 표시

- [ ] Given 서버가 리포 루트에서 기동된 상태, When 배지가 상태를 조회하면, Then 대상은 **`localjira/data` 브랜치가 체크아웃된 `.localjira/` worktree**다(코드 브랜치의 작업 트리가 아니다). — D1, ADR-006
- [ ] Given 어느 화면(백로그·보드·이슈 상세·스프린트·설정)이든, When 화면을 열면, Then 전역 헤더에 **미커밋 변경 건수**와 **마지막 push 시각**이 상시 표시된다. — §8
- [ ] Given 미커밋 변경이 0건이고 최근에 push된 상태, When 배지를 보면, Then "미커밋 0" 상태로 표시되고 경고 강조가 없다.
- [ ] Given 마지막 push 시각, When 표시하면, Then 프로젝트 timezone 기준의 사람이 읽는 형식으로 렌더링되고 원본 값은 RFC 3339로 다룬다. — §5.2

### 건수 산출 (AC24)

- [ ] Given 미커밋 변경이 0건인 상태, When 이슈 1건을 생성하면, Then 배지의 미커밋 건수가 **1 증가**한다(새 이슈 파일은 `.localjira/` worktree에서 untracked로 잡힌다). — AC24, AC1
- [ ] Given 위 상태, When 사용자가 터미널에서 `git -C .localjira add -A && git -C .localjira commit`을 수행하면, Then 배지가 **0으로 돌아간다**. — AC24
- [ ] Given 이슈 3건 생성 + 기존 이슈 2건 수정, When 배지를 보면, Then 미커밋 건수는 **5**다. 신규(untracked)·수정(modified)·삭제(deleted)를 모두 센다.
- [ ] Given 인덱스 재빌드·outbox 기록·claim 취득으로 `.local/` 파일이 대량 변경된 상태, When 배지를 보면, Then 미커밋 건수는 **증가하지 않는다**. `.local/`은 `.gitignore` 대상이다. — §5.3
- [ ] Given 코드 브랜치에서 소스 파일을 수정한 상태, When 배지를 보면, Then 미커밋 건수는 변하지 않는다. 배지는 코드 변경을 세지 않는다. — D1

### 변경 파일 목록

- [ ] Given 미커밋 변경이 5건, When 배지를 클릭하면, Then **변경 파일 목록**이 열리고 각 항목의 `.localjira/` 기준 상대 경로와 변경 종류(추가/수정/삭제)가 표시된다. — §7 R25
- [ ] Given 목록이 열린 상태, When 항목을 보면, Then 이슈 파일 경로에서 표시 키(`LJ-12`)를 알아볼 수 있다.

### 서비스는 커밋하지 않는다 (D4)

- [ ] Given 이슈 생성·수정·삭제·스프린트 전이 등 어떤 도메인 쓰기, When 서버가 처리하면, Then 서버는 **`git commit`·`git push`를 실행하지 않는다**. 파일만 쓴다. — AC24, D4
- [ ] Given 배지 UI, When 조작 가능한 요소를 확인하면, Then **커밋·푸시 버튼이 존재하지 않는다**. 배지는 상태를 읽어 보여주기만 하며 커밋·푸시는 사람이 터미널에서 한다. — D4
- [ ] Given 장시간 미커밋 상태(건수가 계속 증가), When 배지를 보면, Then 시각적으로 강조되어 "커밋 안 하고 방치"가 눈에 띈다. — D4, D5

### 실패·부재 처리

- [ ] Given `git clean -xdff` 등으로 `.localjira/` worktree가 사라진 상태, When 서버를 기동하면, Then 명확한 오류와 **복구 명령**(`git worktree add .localjira localjira/data`)이 출력되고, 화면에는 보드 데이터 부재가 안내된다. — ADR-006 Consequences
- [ ] Given `.localjira/`가 git worktree가 아니거나 git 실행에 실패한 상태, When 배지를 보면, Then 숫자 대신 "git 상태 확인 불가"와 사유가 표시되고, 이 실패가 도메인 API(이슈 CRUD·보드)를 막지 않는다.
- [ ] Given 원격(remote)이 설정되지 않은 저장소, When 배지를 보면, Then 마지막 push 시각 자리에 "원격 없음"이 표시되고 오류로 처리되지 않는다.
- [ ] Given 배지 상태 조회, When N4(오프라인)를 확인하면, Then 조회는 로컬 git 데이터만 읽으며 네트워크 접속을 시도하지 않는다(`git fetch`를 하지 않는다). — N4

> ⚠ 미정: **"마지막 push 시각"의 산출 방법**을 PRD가 정하지 않았다. `.git/logs/refs/remotes/<remote>/localjira/data` reflog 시각을 쓰는지, upstream ref 파일의 mtime을 쓰는지, 서버가 push를 관측할 방법이 없으므로 어느 쪽이든 근사값이다.
> ⚠ 미정: 배지 **갱신 주기**(폴링 간격 / 파일 워처 연동 / 사용자 조작 시점)가 PRD에 없다. §5.5의 워처는 `.localjira/` 도메인 파일용이고 `.git` 상태 변화 감지는 별도다.
> ⚠ 미정: "미커밋 건수"가 **파일 수**인지 hunk 수인지 PRD가 명시하지 않았다. 본 스토리는 AC1("`git status`에 이슈 파일 1개만 잡힌다")과의 정합을 위해 **파일 수**로 해석했다.
> ⚠ 미정: 로컬에 커밋했지만 아직 push하지 않은 커밋 수(ahead N)를 함께 표시할지가 PRD에 없다. D5는 "백업 = 커밋·**푸시**된 데이터"라고 하므로 커밋만으로는 백업이 아니다.

## 범위 밖 (Out of Scope)

- 서비스에 의한 자동 커밋·자동 푸시·충돌 해결 — D4에 의해 명시적 비목표
- `git pull --rebase` 실행 UI — 동기화는 사람이 터미널에서 수행한다(D2)
- pull 이후의 파일 변경 조정·격리 → R8·R11
- 커밋 트레일러(`Issue: LJ-12`) 스캔으로 커밋을 이슈에 연결 → R23 (M5)
- `localjira/data` 브랜치·worktree 최초 생성 명령 → M0 부트스트랩
- 무결성 격리 배너 → `r11b-integrity-error-banner.md`

## 선행 의존 (Depends on)

- `r01a-issue-create-read.md`
- M0 부트스트랩(`localjira/data` orphan 브랜치 + `.localjira` worktree)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.3(파일 레이아웃·브랜치 배치·`.local/` gitignore) · §7 R25 · §8(전역 헤더 배지) · §9 N4 · §13 D1·D2·D4·D5
- ADR `../../0_decisions/adr-006-shared-board-data-branch.md` (D1 — 데이터 worktree, Consequences — `git clean` 위험·복구 명령)
- 검증: PRD AC24
