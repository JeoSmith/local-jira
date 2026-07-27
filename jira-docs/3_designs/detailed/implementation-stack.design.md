---
title: "구현 스택과 프로젝트 구조"
status: accepted
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
version: v1
---

# 구현 스택과 프로젝트 구조

## 결정

M0와 서버 코어는 **Node.js 24 + TypeScript ESM**으로 구현한다.

- Node 24의 type stripping으로 `.ts`를 직접 실행한다.
- 초기 CLI는 외부 runtime dependency 없이 Node 표준 라이브러리만 사용한다.
- 테스트는 `node:test`, assertion은 `node:assert/strict`를 사용한다.
- Git은 shell 문자열이 아니라 `spawnSync`/향후 `spawn`의 argument 배열로 실행한다.
- 최소 지원 환경은 M0 설계와 같이 macOS/Linux, Git 2.39 이상이다.

현재 개발 환경에 Node 24와 Git 2.39가 설치되어 있고 Go/Rust toolchain은 없다. M0는 Git orchestration과
파일 검증이 중심이라 별도 compiler·package 설치 없이 실행되는 구성이 첫 구현과 배포 검증에 가장
작은 출발점이다.

## 프로젝트 구조

```text
package.json
src/
  cli.ts
  bootstrap/
    model.ts
    git.ts
    doctor.ts
test/
  bootstrap/
    doctor.test.ts
```

- `cli.ts`: 인자·출력·exit code만 담당
- `bootstrap/model.ts`: M0 상태와 오류 계약
- `bootstrap/git.ts`: Git subprocess와 worktree/ref 관찰
- `bootstrap/doctor.ts`: read-only 상태 분류
- mutation인 `init`·`repair-worktree`는 doctor와 같은 inspector 결과에서 `BootstrapPlan`을 만든 뒤 추가한다.

## 의존성 원칙

M0 `doctor`는 무의존으로 유지한다. 이후 필요한 기능은 사용 시점에 별도 검토한다.

- OS advisory lock: Node core에 직접 API가 없으므로 M0 mutation 착수 전에 native binding 또는
  작은 플랫폼 adapter를 검증한다. PID/stale-time 기반 lock package로 대체하지 않는다.
- SQLite: M1 착수 시 WAL·FTS5·backup/generation switch 지원 여부를 기준으로 driver를 선택한다.
- HTTP·validation·watcher: M1 API 상세 설계 후 선택한다.

편의를 위해 framework를 먼저 들이지 않는다. ADR의 durability·locking 계약을 만족하는지 확인한 뒤
의존성을 추가하고 lockfile로 고정한다.

## 검증 기준

```text
npm test
node src/cli.ts doctor
node src/cli.ts doctor --json
```

지원 Node 버전에서 별도 transpile 없이 세 명령이 동작해야 한다. 패키징 단계에서는 같은 entrypoint를
`localjira` bin으로 노출한다.

## 참고

- [M0 부트스트랩 상세 설계](m0-bootstrap.design.md)
- [ADR-002](../../0_decisions/adr-002-single-writer-daemon.md)
- [ADR-006](../../0_decisions/adr-006-shared-board-data-branch.md)
