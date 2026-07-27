---
title: "M1 공통 fixture와 fault injection 실행 방법"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_sprint: ../../4_plans/sprints/sprint-01-m1-reliable-core.md
---

# M1 공통 fixture와 fault injection 실행 방법

Sprint 01 착수 조건 — *"공통 테스트 fixture와 fault-injection 실행 방법을 정한다"* — 의 답이다.
M0에서 이미 쓰고 있는 방식(격리된 임시 저장소 + `node:test`)을 M1 규모로 확장한다.

## 1. 원칙

| | |
|---|---|
| **사용자 워크스페이스에서 실행하지 않는다** | 모든 테스트는 `mkdtemp`로 만든 임시 저장소에서 돈다. M0 통합 테스트가 이미 이 규약을 지킨다 |
| **fault injection 훅은 사후에 못 붙인다** | WriteTxn 각 stage 전이에 훅 자리를 **처음부터** 만든다(설계 §5 영향 표) |
| **의존성 없이** | `node:test` + `node:assert/strict`. 픽스처 생성도 표준 라이브러리만 사용 |
| **결정적** | 시각·ULID·난수는 전부 주입 가능해야 한다. 같은 시드로 같은 픽스처가 나와야 한다 |

## 2. Fixture 계층

크기가 다른 세 종류를 쓴다. 큰 것을 매 테스트에 쓰면 스위트가 느려지고, 작은 것만 쓰면
성능·조정 결함을 놓친다.

| 이름 | 규모 | 용도 | 생성 비용 |
|---|---|---|---|
| **tiny** | 이슈 3~10건 | 단위·계약 테스트 대부분 | 즉시 |
| **conflict** | 이슈 20건 + 고의로 깨진 것들 | 격리·재키잉·조정 (§3.6·§3.8) | 즉시 |
| **bulk** | 이슈 5,000 / 총 ≈16,600 파일 | AC2 동치, N1·N2 성능, 대량 조정 | 캐시 필요 |

### 2.1 결정적 생성기

```ts
makeBoard({ seed, issues, comments, sprints, runs }): BoardFixture
```

- `seed`로 ULID·본문·라벨을 재현 가능하게 생성한다. `createUlid(now)`가 이미 타임스탬프를
  주입받으므로, 테스트용 시퀀스 카운터를 붙이면 완전히 결정적이다.
- 생성 결과를 `test/.fixtures/bulk-<seed>-<hash>/`에 캐시하고, 이후 테스트는 **복사만** 한다.
  5,000건을 매번 만들면 스위트가 분 단위로 늘어난다.
- 캐시 키에 생성기 버전을 넣어, 생성 규칙이 바뀌면 자동으로 무효화한다.

### 2.2 conflict fixture가 담아야 할 것

§3.6의 격리 사유와 §3.8의 재키잉이 **실제로 발생하는** 상태를 미리 만들어 둔다.

| 케이스 | 만드는 법 |
|---|---|
| 파싱 실패 | frontmatter 없는 `.md`, 잘린 YAML |
| conflict marker | `<<<<<<< HEAD` 가 남은 이슈 파일 |
| 중복 표시 키 | 서로 다른 uid가 같은 `key: LJ-13` |
| 중복 uid | 서로 다른 경로에 같은 `uid` — 양쪽 격리되어야 한다 |
| dangling 참조 | 존재하지 않는 `parent`·`sprint` |
| 계층 순환 | A→B→A |
| ACTIVE 스프린트 2개 | 같은 프로젝트에 `status: ACTIVE` 두 개 |
| 중복 rank | 같은 `backlog_rank` 두 건 — 격리가 아니라 `(rank, uid)`로 정렬되어야 한다 |
| 미지 frontmatter 키 | 서버가 모르는 키 — 보존되고 ETag에 반영되어야 한다 |
| hard line break | 본문 줄 끝 공백 2칸 — 제거되면 안 된다 |

## 3. Fault injection

### 3.1 훅 지점

WriteTxn(§3.4)의 **stage 전이마다** 크래시 지점을 만든다. 설계가 5개 단계로 나뉘어 있으므로
훅도 그 경계에 정확히 대응한다.

```
PENDING 기록 후 ─┬─ ② 파일 rename 전
                 ├─ ② rename 후 / FILE_DONE 기록 전
                 ├─ FILE_DONE 후 / ③ 인덱스 upsert 전
                 ├─ INDEX_DONE 후 / ④ 이벤트 append 전
                 ├─ 이벤트 append 후 / EVENT_DONE 기록 전   ← 가장 까다로운 구간
                 └─ EVENT_DONE 후 / DONE 기록 전
```

마지막에서 두 번째가 핵심이다. append는 끝났는데 stage가 안 올라간 상태라, 재생이
`event_id`로 중복을 확인하지 않으면 이벤트가 두 번 쌓인다(§3.4).

### 3.2 실행 방식

**in-process 훅이 아니라 실제 프로세스를 죽인다.** 함수를 던지게 만드는 것으로는 SQLite WAL과
파일시스템 상태가 진짜 크래시와 같아지지 않는다.

```
부모(테스트) ──spawn──▶ 자식(서버)
   │                        │ LOCALJIRA_CRASH_AT=<stage> 환경변수
   │                        │ 해당 지점 도달 → 부모에 신호 → process.abort()
   │◀───────────────────────┘
   └─ SIGKILL 확인 후 재기동 → 불변조건 검증
```

- 훅은 `LOCALJIRA_CRASH_AT` 환경변수가 있을 때만 활성화된다. 프로덕션 경로에 분기를 남기지 않기 위해 **테스트 빌드에서만** 컴파일되는 것이 이상적이나, 무의존 원칙상 환경변수 가드로 시작하고 릴리스 전에 제거 여부를 판단한다.
- M0의 lock 테스트가 이미 같은 패턴(자식 spawn → SIGKILL → 부모가 획득)을 쓰고 있어 재사용 가능하다.

### 3.3 매 지점에서 검증할 불변조건

크래시 지점과 무관하게 **항상** 성립해야 하는 것들이다.

1. 이슈 파일이 **부분 YAML이 아니다** — 이전 버전 또는 새 버전 중 하나의 완전한 상태
2. 재기동 후 미완료 outbox 재생이 끝나야 도메인 쓰기 API가 열린다(그 전에는 503)
3. 재생 후 **중복 이벤트 0건**(`event_id` 기준)
4. 재생 후 인덱스가 파일과 일치한다(전체 검증이 불일치 0을 보고)
5. **재생 중 재크래시** 후 다시 재생해도 결과가 1회 재생과 같다
6. 크래시 후 사람이 그 파일을 고쳐 놓았으면 **그 수정이 살아남는다**(CAS 3분기, §3.4)

6번은 v1에서 실제로 깨졌던 동작이라 반드시 테스트로 고정한다.

### 3.4 워처·조정 계열

프로세스 크래시와 별개로, 외부 변경 경로에도 고장을 주입한다.

| 주입 | 기대 |
|---|---|
| 워처 이벤트를 전부 버림 | 10분 주기 조정(또는 수동 트리거)에서 수렴 |
| overflow 신호 강제 발생 | 건수와 무관하게 즉시 전체 조정으로 승격 |
| 1,000파일 일괄 checkout | ≤15s 내 수렴, tombstone 오판 없음 |
| 같은 크기·같은 mtime으로 내용 변경 | **전체 조정이 잡아낸다**(메타데이터 fast-path 금지 검증) |
| 유예 60초 중 서버 재시작 | `delete_deadline_at`으로 확정/복원이 이어진다 |

## 4. 성능 측정

설계 §3.7의 예산은 **가정이지 측정이 아니다**(OQ2). 다음을 Sprint 01 완료 조건으로 기록한다.

```
bulk fixture, production build
  cold cache (파일 캐시 비운 직후) / warm cache 각각
  10회 반복 p95:
    - 전체 재빌드        목표 ≤10s
    - 전체 검증          목표 ≤10s
    - 증분 1파일         목표 ≤100ms
    - 대량 조정 1,000파일 목표 ≤15s
    - 검색·필터 API      목표 ≤300ms
```

측정 결과는 목표와 함께 기록한다. **목표를 못 맞추면 목표를 고치는 게 아니라 원인을 적는다** —
동시성 값(8~16), 워커 스레드 도입 여부, FTS 토크나이저 선택(OQ1)이 여기서 결정된다.

## 5. 참고

- [Sprint 01 계획](../../4_plans/sprints/sprint-01-m1-reliable-core.md) · [착수 결정 로그](../../4_plans/sprints/sprint-01-decisions.md)
- [저장 계층 설계](../../3_designs/detailed/storage-layer.design.md) §3.4~§3.8
- PRD AC2 · AC3 · AC10 · AC11 · AC15 · AC25, NFR N1 · N2 · N5
- 기존 사례: `test/bootstrap/lock.test.ts`(SIGKILL 후 잠금 해제), `test/bootstrap/init.integration.test.ts`(격리 저장소)
