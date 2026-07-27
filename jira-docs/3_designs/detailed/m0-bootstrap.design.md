---
title: "M0 부트스트랩 상세 설계"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
version: v1
related_requirements: ../../2_requirements/prd/backlog-sprint.md
related_decisions: ../../0_decisions/adr-006-shared-board-data-branch.md
milestone: M0
---

# M0 부트스트랩 상세 설계

## 1. 목적

코드 저장소에 공유 보드용 orphan 브랜치 `localjira/data`를 만들거나 기존 브랜치를 연결하고,
**primary worktree 루트의 `.localjira/`에 정확히 한 번** 배치한다. 첫 프로젝트와 최소 파일 구조를
만들어 M1 구현이 같은 입력에서 시작하도록 한다.

M0의 성공 조건은 다음 네 가지다.

1. 코드 브랜치와 독립된 `localjira/data` 브랜치가 존재한다.
2. primary worktree의 `.localjira/`가 그 브랜치의 worktree다.
3. 첫 프로젝트의 추적 파일과 기기별 `node_id`가 생성된다.
4. 같은 명령을 반복해도 commit·파일·ignore 항목이 중복되지 않는다.

M0는 보드 서버·이슈 CRUD를 구현하지 않는다. M1이 소비할 **안전한 저장 위치와 초기 계약**만 만든다.

## 2. 명령 인터페이스

### 2.1 초기화

```text
localjira init \
  --project-key LJ \
  --project-name "Local Jira" \
  --timezone Asia/Seoul \
  [--remote origin] \
  [--push]
```

| 인자 | 필수 | 규칙 |
|---|---:|---|
| `--project-key` | 예 | `^[A-Z][A-Z0-9]{1,9}$`; 파일명·표시 키 prefix로 사용 |
| `--project-name` | 예 | trim 후 1~100 Unicode scalar; 제어문자 금지 |
| `--timezone` | 예 | 런타임 IANA tzdb에 존재하는 timezone |
| `--remote` | 아니오 | 기본 `origin`; remote가 없으면 local-only로 진행 |
| `--push` | 아니오 | 새 로컬 데이터 브랜치를 명시적으로 remote에 push하고 upstream 설정 |

- 성공 또는 이미 같은 상태면 exit 0이다.
- 기본 동작은 network에 쓰지 않는다. `--push`를 준 경우만 push한다.
- `--push`를 줬지만 지정 remote가 없으면 로컬 변경 전에 `E_REMOTE_NOT_CONFIGURED`로 실패한다.
  `--push`가 없고 remote도 없으면 local-only 초기화를 정상 진행한다.
- remote가 존재하면 `refs/heads/localjira/data`만 fetch해 기존 공유 보드 유무를 확인한다.
- secret·비밀번호·PAT는 인자로 받지 않는다. admin 자격증명은 M1 R12a가 담당한다.
- 사람이 읽는 출력과 별도로 `--json`을 지원한다. JSON에는 `status`, `repo_root`, `board_path`,
  `branch`, `project_key`, `actions[]`, `warnings[]`를 담는다.

### 2.2 진단과 복구

```text
localjira doctor [--json]
localjira repair-worktree [--remote origin] [--json]
```

- `doctor`는 read-only다. 아래 상태 판정과 복구 명령만 출력한다.
- `repair-worktree`는 **기존 local/remote `localjira/data`가 있을 때만** 사라진 `.localjira/`
  worktree를 다시 붙인다. 새 브랜치·프로젝트를 만들지 않는다.
- 잘못된 디렉터리, dirty worktree, 다른 경로에 이미 checkout된 데이터 브랜치는 자동 삭제·이동하지
  않는다. 정확한 경로와 수동 조치를 출력하고 실패한다.

## 3. 저장소와 대상 루트 판정

### 3.1 사전 조건

다음을 순서대로 확인하며 하나라도 실패하면 파일을 바꾸지 않는다.

1. `git rev-parse --is-inside-work-tree`가 true
2. bare repository가 아님
3. `git worktree list --porcelain`의 첫 `worktree` 항목(primary worktree)을 해석 가능
4. 현재 `--show-toplevel`이 primary worktree와 동일
5. Git 2.39 이상
6. primary worktree의 코드 변경은 허용하되 `.gitignore` 외의 파일은 건드리지 않음

linked worktree에서 실행하면 `E_NOT_PRIMARY_WORKTREE`로 실패하고 primary 경로를 출력한다.
자동으로 다른 worktree를 수정하지 않는 이유는 사용자가 보고 있는 branch와 다른 branch의
`.gitignore`를 몰래 바꾸는 일을 막기 위해서다.

경로 비교는 symlink를 해소한 absolute path로 한다. `.localjira`가 저장소 루트 밖을 가리키는
symlink면 `E_UNSAFE_BOARD_PATH`로 거부한다.

### 3.2 동시 실행 방지

git common dir 아래 `localjira-bootstrap.lock`을 열고 프로세스 수명 동안 OS advisory lock을 잡는다.
획득 실패 시 `E_BOOTSTRAP_BUSY`로 끝낸다. PID 파일 존재 여부나 stale 파일 삭제로 판정하지 않는다
(ADR-002와 같은 원칙).

## 4. 상태 모델

초기화는 현재 상태를 관찰한 뒤 아래 표에서 정확히 한 경로만 선택한다.

| ID | local branch | remote branch | `.localjira` | 판정·동작 |
|---|---|---|---|---|
| S0 | 없음 | 없음/remote 없음 | 없음 | 새 orphan branch와 첫 프로젝트 생성 |
| S1 | 없음 | 있음 | 없음 | exact fetch → local tracking branch → worktree 연결; 입력 프로젝트와 기존 프로젝트 일치 확인 |
| S2 | 있음 | 무관 | 없음 | local branch를 worktree로 연결; 누락된 local-only 파일 생성 |
| S3 | 있음 | 무관 | 올바른 worktree | 검증 후 no-op; 안전한 누락 항목만 보충 |
| S4 | 있음 | 무관 | 다른 경로에 checkout | 실패. 기존 경로 출력; 자동 move/remove 금지 |
| S5 | 무관 | 무관 | 일반 파일·디렉터리·symlink | 실패. 내용 보존; 자동 rename/delete 금지 |
| S6 | 있음 | 무관 | worktree지만 다른 branch | 실패. 현재 branch와 dirty 상태 출력 |
| S7 | 없음 | 있음 | 있음 | S5와 동일; 먼저 경로 충돌을 사람이 해결 |
| S8 | local·remote 모두 있음 | 있음 | 없음/정상 | ancestry·tracking 확인; 자동 merge/rebase하지 않음 |

### 4.1 local/remote가 동시에 있을 때

fetch한 `refs/remotes/<remote>/localjira/data`와 local branch를 비교한다.

- 같은 commit: 계속
- local이 remote의 ancestor: `init`에서는 fast-forward 후 계속
- remote가 local의 ancestor: local 우선, `--push` 없이는 경고만
- diverged: `E_DATA_BRANCH_DIVERGED`; pull/rebase/merge를 자동 수행하지 않음

부트스트랩 단계에서 자동 rebase를 하지 않는 이유는 데이터 충돌을 아직 M1 reconciler가 검증할 수
없기 때문이다.

## 5. 변경 알고리즘

### 5.1 계획 후 실행

명령은 먼저 모든 검사를 끝내고 `BootstrapPlan`을 만든다.

```text
BootstrapPlan
  repo_root
  git_common_dir
  board_path
  branch_source = create | local | remote
  project_action = create | verify
  ignore_action = append | none
  push_action = push | none
```

plan 생성 전에는 fetch를 제외한 로컬 쓰기를 하지 않는다. 실행 중 실패하면 생성한 항목만 역순으로
정리하되, **사용자 데이터나 기존 ref는 절대 삭제하지 않는다**. rollback 대상인지 불명확하면
`E_PARTIAL_BOOTSTRAP`과 `doctor` 출력으로 멈춘다.

### 5.2 새 orphan 브랜치 생성

현재 code branch를 `switch`하지 않는다. 임시 worktree에서 다음을 수행한다.

1. repo root와 같은 filesystem의 전용 임시 경로를 생성한다.
2. temp worktree를 detached HEAD로 연결한다.
3. temp worktree 안에서 `git switch --orphan localjira/data`를 수행한다.
4. orphan index/worktree가 비었는지 확인한다. 예상 밖 파일이 있으면 중단한다.
5. §6의 추적 파일을 쓴다.
6. structural initial commit `chore(localjira): initialize board`를 1회 만든다.
7. `git worktree move <temp> <repo_root>/.localjira`로 publish한다.

이 방식은 사용자의 현재 code branch·index·working tree를 전혀 전환하지 않는다. 구현은 각 단계에서
Git의 실제 worktree 등록 상태를 다시 읽고, 예상 경로만 정리한다.

초기 commit은 D4의 유일한 예외다. M0가 orphan branch를 성립시키기 위한 **구조 commit 1개**만 만들며,
서버는 이후 도메인 파일을 자동 commit하지 않는다.

### 5.3 기존 브랜치 연결

remote branch만 있으면 exact refspec으로 가져온다.

```text
+refs/heads/localjira/data:refs/remotes/<remote>/localjira/data
```

그 후 local tracking branch를 만들고 `.localjira`에 worktree로 연결한다. 전체 remote branch를
무차별 fetch하거나 default branch를 바꾸지 않는다.

worktree 연결 뒤 `config.yaml`과 요청한 `projects/<KEY>.yaml`을 검증한다.

- 프로젝트가 있으면 key/name/timezone이 입력과 모두 같아야 no-op
- key는 같지만 name/timezone이 다르면 `E_PROJECT_MISMATCH`; init이 기존 설정을 변경하지 않음
- 프로젝트가 없으면 `E_PROJECT_NOT_FOUND`; 기존 공유 보드에 프로젝트를 추가하는 기능은 M1 API로 넘김

### 5.4 ignore 갱신

두 위치를 갱신한다.

1. code branch의 repo-root `.gitignore`에 root-anchored `/.localjira/`
2. 데이터 branch의 `.gitignore`에 `/.local/`

각 파일은 기존 개행 형식을 유지하고, 의미상 동일한 root rule이 있으면 추가하지 않는다. code
`.gitignore` 변경은 자동 commit하지 않고 최종 출력에 **“code branch에서 commit 필요”**로 표시한다.
데이터 branch의 `/.local/`은 initial structural commit에 포함되며, 기존 branch에서는 누락 시 파일을
수정하되 commit하지 않는다.

`.git/info/exclude`에 의존하지 않는다. clone 간 전달되지 않고, 잘못된 code branch에서
`.localjira/` 보호가 사라지는 사실을 숨기기 때문이다.

### 5.5 push

`--push`가 있을 때만 다음 refspec을 사용한다.

```text
refs/heads/localjira/data:refs/heads/localjira/data
```

- remote branch 없음: push 후 upstream 설정
- 같은 commit/fast-forward: push
- non-fast-forward: 실패하고 `--force`를 제공하지 않음
- 인증·네트워크 실패: 로컬 초기화는 유지하고 exit non-zero + `E_PUSH_FAILED`

push 실패를 rollback하지 않는다. 로컬의 유효한 보드를 지우는 것보다 사용자가 나중에 push하도록
안내하는 것이 안전하다.

## 6. 초기 산출물

### 6.1 git 추적 파일

```text
.localjira/
  .gitattributes
  .gitignore
  config.yaml
  users.yaml
  projects/
    LJ.yaml
```

빈 `issues/`, `comments/`, `sprints/`, `runs/`, `proposals/`, `events/` 디렉터리를 git에 유지하기 위한
`.gitkeep`은 만들지 않는다. 서버가 필요할 때 디렉터리를 만들며, 빈 디렉터리는 도메인 상태가 아니다.

`config.yaml`:

```yaml
schema_version: 1
board_id: 01K...
created_at: 2026-07-27T00:00:00Z
default_project: LJ
```

`projects/LJ.yaml`:

```yaml
schema_version: 1
key: LJ
name: Local Jira
timezone: Asia/Seoul
estimation_unit: story_points
created_at: 2026-07-27T00:00:00Z
```

`users.yaml`:

```yaml
schema_version: 1
users: []
```

`.gitattributes`:

```gitattributes
* text=auto
*.md text eol=lf
*.yaml text eol=lf
*.yml text eol=lf
*.json text eol=lf
*.jsonl text eol=lf
```

`.gitignore`:

```gitignore
/.local/
```

- `board_id`는 ULID이며 보드 생성 이후 불변이다.
- 시각은 UTC RFC 3339로 생성한다. 프로젝트 timezone은 표시·일자 경계 계산에 사용한다.
- YAML은 UTF-8, LF, 2-space indent와 마지막 newline으로 쓴다.
- 기존 추적 파일은 byte-for-byte 보존한다. init 재실행은 포맷을 정리한다는 이유로 재작성하지 않는다.

### 6.2 기기별 비추적 파일

worktree publish/연결 후 `.localjira/.local/node.yaml`을 원자적으로 생성한다.

```yaml
schema_version: 1
node_id: 01K...
created_at: 2026-07-27T00:00:00Z
```

- `node_id`는 설치별 ULID이며 이벤트 파일명과 SSE epoch의 seed로 사용한다.
- 파일이 이미 있으면 검증만 하고 절대 재발급하지 않는다.
- `.local/` 권한은 POSIX에서 `0700`, `node.yaml`은 `0600`을 요청한다.
- `.local/`은 git 추적·push·백업 대상이 아니다.

## 7. 검증과 오류 계약

### 7.1 성공 후 불변조건

`init`과 `doctor`는 다음을 모두 확인한다.

- `refs/heads/localjira/data`가 존재하고 root commit ancestry가 code branch와 분리됨
- `.localjira/.git`이 gitdir pointer이며 등록된 worktree path와 일치
- `.localjira`의 HEAD가 `refs/heads/localjira/data`
- code worktree 안에서 `.localjira/`가 `git check-ignore`로 무시됨
- 데이터 worktree 안에서 `.local/`이 무시됨
- 필수 추적 파일이 존재하고 schema/key/timezone이 유효
- 추적 파일 목록에 `.local/` 하위 파일이 0개
- `board_id`, `node_id`가 유효한 ULID
- remote tracking이 있으면 divergence 상태를 보고

orphan 판정은 “parent가 0개”만 보지 않는다. 이후 commit에는 parent가 생기므로,
`localjira/data`의 root commit이 code branch의 merge-base ancestry에 속하지 않는지를 확인한다.

### 7.2 오류 코드

| 코드 | 의미 | 변경 여부 |
|---|---|---|
| `E_NOT_GIT_REPOSITORY` | git worktree가 아님 | 없음 |
| `E_NOT_PRIMARY_WORKTREE` | linked worktree에서 init 실행 | 없음 |
| `E_BOOTSTRAP_BUSY` | 다른 init/repair가 실행 중 | 없음 |
| `E_UNSAFE_BOARD_PATH` | symlink·repo 밖 경로 | 없음 |
| `E_BOARD_PATH_OCCUPIED` | `.localjira`가 안전하게 쓸 수 없는 기존 경로 | 없음 |
| `E_BRANCH_CHECKED_OUT` | 데이터 branch가 다른 path에 checkout | 없음 |
| `E_WRONG_WORKTREE_BRANCH` | `.localjira`가 다른 branch를 가리킴 | 없음 |
| `E_DATA_BRANCH_DIVERGED` | local/remote 데이터 branch 분기 | fetch만 가능 |
| `E_REMOTE_NOT_CONFIGURED` | `--push`를 요청했지만 remote가 없음 | 없음 |
| `E_PROJECT_MISMATCH` | 기존 프로젝트와 입력이 다름 | 없음 |
| `E_PROJECT_NOT_FOUND` | 기존 보드에 요청 프로젝트 없음 | 없음 |
| `E_PARTIAL_BOOTSTRAP` | 중간 실패를 안전하게 완전 rollback할 수 없음 | 진단에 명시 |
| `E_PUSH_FAILED` | 명시적 push 실패 | 로컬 초기화 유지 |

오류 메시지는 “무엇을 관찰했는지”, “무엇을 변경했는지”, “다음 read-only 확인 명령”을 포함한다.
사용자에게 `rm -rf`, `git reset --hard`, 강제 push를 자동 복구 명령으로 제시하지 않는다.

## 8. 크래시·재실행 복구

별도 bootstrap journal을 정본으로 두지 않는다. git ref, worktree registry, 대상 경로와 필수 파일을
다시 관찰하면 단계가 드러나므로 상태 기반으로 재개한다.

| 중단 지점 | 재실행 동작 |
|---|---|
| temp worktree 생성 전 | S0에서 다시 시작 |
| orphan branch 생성 후 commit 전 | branch가 checkout된 temp path를 보고 실패; `doctor`가 path 출력 |
| initial commit 후 move 전 | 유효한 branch+temp worktree를 보고 자동 move하지 않음; `repair-worktree`도 기존 path 보존 |
| move 후 node 파일 전 | S3 검증 후 node 파일 생성 |
| code `.gitignore` 갱신 전 | S3 검증 후 rule append |
| push 중 실패 | local 성공 상태 유지; 같은 `--push` 재실행 가능 |

임시 경로는 이름만으로 삭제하지 않는다. 현재 실행이 만든 path이고, worktree registry·HEAD·dirty
상태가 모두 예상과 일치할 때만 정상 오류 처리 중 제거한다. 프로세스 크래시 뒤에는 `doctor`가
사람에게 경로를 보여주며 자동 삭제하지 않는다.

## 9. 테스트 전략

모든 테스트는 임시 git repository와 bare remote를 만들며 실제 사용자 저장소를 사용하지 않는다.

### 9.1 정상·멱등

- 새 repo, remote 없음: S0 성공
- 새 repo + bare remote: `--push` 후 exact remote branch 생성
- 동일 인자로 init 2회·10회: 두 번째부터 commit·파일 diff 0
- code branch를 바꿔도 `.localjira` HEAD와 `board_id` 유지
- path에 공백·한글이 있는 repo

### 9.2 기존 보드 합류

- remote branch만 존재: S1로 attach하고 byte-for-byte 보존
- local branch만 존재: S2로 attach
- local behind remote: fast-forward
- local ahead remote: 경고, 자동 push 없음
- diverged: 실패하고 양쪽 ref 불변
- 프로젝트 name/timezone 불일치: 실패, 기존 파일 불변

### 9.3 안전성

- `.localjira`에 일반 파일, 빈 디렉터리, symlink, 다른 worktree가 각각 존재
- branch가 다른 path에서 checkout
- linked worktree에서 init 실행
- dirty code worktree와 기존 `.gitignore` 사용자 변경 보존
- `.gitignore`에 동일 rule의 표현 변형이 있을 때 중복 방지
- 두 init 동시 실행 시 하나만 변경
- remote non-fast-forward에서 force push가 발생하지 않음

### 9.4 fault injection

§5.2의 각 단계와 `.gitignore`, node 파일, push 전후에서 프로세스를 종료하고 재실행한다.

- 사용자 기존 ref·파일 삭제 0건
- code branch·index가 실행 전과 동일(`.gitignore` 의도 변경 제외)
- 성공 상태 또는 명시적 `E_PARTIAL_BOOTSTRAP` 중 하나
- 부분 생성된 temp worktree를 숨기지 않고 `doctor`가 발견
- initial structural commit은 최대 1개

### 9.5 인수 테스트

- AC24: clone 두 개가 같은 remote `localjira/data`에 각각 합류하고 pull/push 가능
- AC26 선행조건: 서로 다른 code worktree에서 primary `.localjira`의 동일 board path를 진단
- `git clean -xdff`로 worktree가 사라진 fixture에서 remote branch로 `repair-worktree` 성공
  - 이 테스트는 격리된 임시 repo에서만 수행하며 사용자 workspace에서는 실행하지 않는다.

## 10. 구현 순서

1. Git repository/worktree inspector와 `doctor`
2. 입력 검증·상태 분류기
3. bootstrap advisory lock과 `BootstrapPlan`
4. S1/S2 기존 branch attach
5. S0 temp worktree orphan 생성·structural commit·move
6. scaffold writer와 node identity
7. `.gitignore` 의미 중복 검사
8. explicit `--push`
9. fault-injection과 `repair-worktree`

`doctor`와 상태 분류기를 먼저 만드는 이유는 mutation 구현과 테스트가 같은 관찰 모델을 사용하게 하기
위해서다.

## 11. 범위 밖

- admin 계정·비밀번호 생성 — M1 R12a
- 이슈·스프린트·사용자 추가 API — M1/M2
- 자동 commit·주기적 push·pull UI — D4/R25
- remote 생성, git credential 설정, merge conflict 자동 해결
- 여러 프로젝트를 기존 보드에 추가하는 명령
- 데이터 branch schema migration
- 서버 기동과 index/outbox/runtime DB 생성

## 12. 지원 경계와 열린 질문

- 1차 지원은 macOS/Linux와 Git 2.39 이상이다. `switch --orphan`과 `worktree move` 조합은
  Apple Git 2.39.5의 격리 fixture에서 검증했다.
- code `.gitignore`의 `/.localjira/`는 M0가 직접 수정하되 commit하지 않는 것으로 확정한다.
- **OQ-M0-1** Windows 지원 시 worktree move, advisory lock, 파일 권한의 동등 계약. 지원 전에는
  명시적인 platform 오류로 중단하고 부분 동작하지 않는다.

## 13. 참고

- [PRD](../../2_requirements/prd/backlog-sprint.md) §5.3 · §12 M0 · §13 D1·D2·D4·D5
- [구현 스택과 프로젝트 구조](implementation-stack.design.md)
- [ADR-002](../../0_decisions/adr-002-single-writer-daemon.md) — 단일 writer와 OS lock
- [ADR-006](../../0_decisions/adr-006-shared-board-data-branch.md) — 데이터 branch·worktree 배치
- [Sprint 01](../../4_plans/sprints/sprint-01-m1-reliable-core.md) 착수 조건
