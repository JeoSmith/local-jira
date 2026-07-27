---
title: "저장 계층 상세 설계 (파일 SoT + SQLite 인덱스)"
status: draft   # draft | review | approved | deprecated
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
version: v2 (codex 교차검증 30건 반영)
related_requirements: ../../2_requirements/prd/backlog-sprint.md
related_stories: r08a, r08b, r08c, r09, r10, r11a, r11b, r21, r26
---

# 저장 계층 상세 설계 (파일 SoT + SQLite 인덱스)

## 1. 목적 (Purpose)

PRD §5(도메인·저장 구조)를 구현 가능한 수준으로 확정한다. 대상은 M1 저장 코어 9개 스토리
(R8·R9·R10·R11·R21·R26)이며, **"파일이 원본이고 SQLite는 언제든 버려도 되는 파생물"** 이라는
성질을 실제로 성립시키는 것이 목표다.

**범위 밖** — 도메인 규칙 자체(계층·전이표), 인증·권한, claim/lease 정책(런타임 상태라 §3.10에서 경계만).

> v2에서 v1의 설계 오류를 고쳤다. 가장 큰 것은 **ETag를 파일 바이트에 붙이려 한 것**이다.
> ETag는 HTTP 리소스 표현의 validator이므로 파일이 아니라 **API 표현(JSON)** 에 붙어야 한다(§3.2).
> 이 착오 때문에 "정규화했는데도 강한 validator"라는 모순이 생겼었다.

## 2. 요구사항 요약 (Requirements)

| 출처 | 핵심 제약 |
|---|---|
| PRD §5.4 | 도메인 쓰기는 **API 서버 단일 프로세스**만. temp→fsync→rename→부모 fsync. 강한 ETag `If-Match`. |
| PRD §5.5 | outbox → 파일 → 인덱스 → 이벤트, 기동 시 미완료 재생. 워처는 **힌트**, 조정이 정본. |
| PRD §5.6 | 파싱과 도메인 검증 분리, 위반 엔티티 **격리(INVALID)** 후 조회·집계 제외(삭제 금지). |
| PRD §13 D3 | 표시 키 충돌은 **결정적** 자동 재키잉 + `former_keys` alias. |
| PRD §13 D5 | `.local/`은 백업 대상이 아니다. **인덱스 유실·프로세스 크래시**가 보장 범위이고 디스크 장애는 아니다. |
| NFR N1·N2 | 5,000건 p95 검색 ≤300ms. 전체 재빌드 ≤10s, 증분 ≤100ms, 대량 조정 ≤15s. |
| AC2·AC3·AC8·AC10·AC11·AC15·AC25 | 인덱스 삭제 후 응답 동치, 외부 편집 3초 반영, 412 계약, 격리, 대량 조정 수렴, fault injection 복구, 재키잉. |

**고장 모델(fault model)** — 이 설계가 방어하는 것과 아닌 것을 먼저 못박는다.

| 방어함 | 방어 안 함 |
|---|---|
| 프로세스 강제 종료(SIGKILL), 임의 시점 크래시 | 디스크 하드웨어 장애·파일시스템 손상(D5) |
| 인덱스·outbox·runtime DB 전체 유실 | 전원 순단 시 파일시스템이 `fsync` 약속을 어기는 경우 |
| git checkout/pull/머지로 인한 대량 외부 변경 | 사람이 `.localjira`를 의도적으로 파괴하는 행위 |
| 에디터 직접 편집, 충돌 마커 잔존 | 네트워크 파일시스템(NFS/SMB) 위 배치 — **미지원** |

## 3. 설계 (Design)

### 3.1 계층 구조

```
                    ┌──────────── HTTP API (단일 writer 프로세스) ────────────┐
   요청 ──────────▶ │  Reader          Writer                Maintenance      │
                    │  └ IndexQuery    └ WriteTxn(§3.4)      └ Rebuild/Verify │
                    └───────┬───────────────┬────────────────────┬────────────┘
                    ┌───────▼───────┐  ┌────▼─────────────┐  ┌──▼──────────┐
                    │ index.sqlite  │  │  .localjira/*.md │  │ outbox.     │
                    │ (파생·폐기가능)│◀─┤   파일 = SoT     │  │ sqlite      │
                    └───────▲───────┘  └────┬─────────────┘  └─────────────┘
                            │               │ 외부 변경(에디터·git)
                    ┌───────┴───────────────▼─────────┐
                    │ Reconciler (워처=힌트, 스캔=정본) │
                    └─────────────────────────────────┘
```

- **Reader는 인덱스만** 본다. 파일을 직접 읽지 않는다.
- **Writer만 파일을 쓴다.** 단일 writer는 OS 파일 잠금으로 강제한다(§3.10).
- **Reconciler는 파일→인덱스 단방향**이다. 파일을 고치는 유일한 예외가 재키잉이며, 그것도 일반 WriteTxn을 거친다(§3.8).

### 3.2 두 개의 해시 — `file_hash`와 `etag`

v1의 오류는 하나의 해시로 두 가지 일을 시키려 한 것이다. **목적이 다르므로 분리한다.**

| | `file_hash` | `etag` |
|---|---|---|
| 대상 | 파일 **원본 바이트** | **API 리소스 표현**(JSON) |
| 계산 | `SHA-256(bytes)`, 소문자 hex **64자** | `SHA-256(JCS(resource_json))`, 소문자 hex **64자** |
| 용도 | 워처·조정의 변경 감지, outbox CAS | `If-Match` 낙관적 동시성 |
| 성질 | 바이트가 다르면 반드시 다르다 | **도메인 상태**가 같으면 같다 |

**ETag가 API 표현에 붙는 이유** — `GET /issues/LJ-12`가 돌려주는 것은 파일이 아니라 JSON이다.
서버는 리소스 응답 본문을 **JCS 바이트 그대로** 전송하고(압축은 전송 코딩으로만 적용), 그 바이트의
SHA-256을 따옴표로 감싼 `"hex64"`를 강한 ETag로 사용한다. 따라서 표현 바이트와 ETag가 어긋나지 않는다.
서식만 다르고 내용이 같은 두 원본 파일이 같은 API 표현과 ETag를 갖는 것은 정확한 동작이다.
`core.autocrlf`로 개행이 바뀌거나 에디터가 YAML 키 순서를 바꿔도 412가 나지 않으며, 파일 바이트
수준의 변화는 `file_hash`가 잡는다. content negotiation으로 다른 표현을 추가할 때는 표현별 ETag와
`Vary`를 별도로 정의해야 하며, v1 API는 `application/json` 한 종류만 지원한다.

**리소스 JSON 정규화** — [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785)를 그대로 쓴다.
직접 규칙을 만들지 않는다(키 정렬·수 표기·이스케이프가 이미 표준으로 정의되어 있다).

**파일 → 리소스 JSON 파싱 규칙** (구현체가 달라도 같은 JSON이 나오도록)

| 항목 | 규칙 |
|---|---|
| YAML subset | **YAML 1.2 core schema의 부분집합**만 허용 — 매핑·시퀀스·문자열·정수·불리언·null. **앵커/별칭·머지 키(`<<`)·명시 태그(`!!`)·중복 키는 파싱 오류**(Stage A 격리) |
| 미지 키 | 리소스 JSON에 **그대로 포함**한다. 내용이므로 빠지면 ETag가 변화를 놓친다 |
| `null` vs 키 부재 | **구분한다.** `null`은 JSON `null`로, 부재는 키 자체를 넣지 않는다 |
| 날짜·수 | 문자열 그대로 보존(RFC 3339 검증만 하고 재포맷하지 않음). 정수는 JCS 규칙 |
| 본문 | JSON 문자열 필드 `body`. **바이트 그대로 보존하되 CRLF·CR → LF만 정규화** |

> 본문에서 **후행 공백을 제거하지 않는다.** Markdown에서 줄 끝 공백 2개는 hard line break라
> 의미가 있다. v1은 이것을 지웠는데 오류였다.
> 유니코드 정규화(NFC/NFD)도 **하지 않는다.** 코드 조각·식별자에서 의미가 바뀔 수 있다.
> macOS(NFD)와 Linux(NFC)가 같은 제목에 다른 ETag를 낼 수 있다는 위험은 남으며, OQ5로 남긴다.

**서버가 파일을 쓸 때**는 정규화된 형식(키 정렬·LF·2-space indent)으로 쓴다. API로 한 번 저장한
뒤에는 `file_hash`도 안정적이다.

### 3.3 파일 종류와 추적

모든 SoT 파일은 **종류에 관계없이 `file_state`에 등록**된다(AC2의 동치 재빌드는 이슈뿐 아니라
코멘트 op·run·이벤트까지 포함하기 때문이다).

| 종류 | 경로 | 파싱 산출 |
|---|---|---|
| 이슈 | `issues/{P}/{KEY}.md` | issues + labels + links + acceptance + FTS |
| 코멘트 원문 | `comments/{KEY}/{ULID}.md` | comments(초기값) |
| 코멘트 op | `comments/{KEY}/{ULID}.ops.jsonl` | comments에 재생 적용(`ops_applied` 워터마크) |
| 스프린트 | `sprints/{P}/{ID}.yaml` | sprints + burndown_snapshots |
| 실행 로그 | `runs/{P}/{YYYY-MM}/{ULID}.json` | runs + run_commits |
| 제안 | `proposals/{P}/{ULID}.yaml` | proposals |
| 이벤트 | `events/{date}/{node}.jsonl` | events(추가분만, 오프셋 워터마크) |

- JSONL 계열은 **바이트 오프셋 워터마크**를 `file_state`에 두어 append분만 증분 처리한다. 파일이 줄어들었거나 앞부분 해시가 달라지면 전체 재파싱한다.
- 코멘트 현재 상태는 **원문 + op 재생 결과**다. 재생 순서는 `.ops.jsonl`의 **줄 순서**이며, 머지로 순서가 섞일 수 있으므로 각 op에 `op_id`(ULID)를 넣고 **`op_id` 정렬로 재생**한다(결정적).

### 3.4 쓰기 트랜잭션 (WriteTxn)

파일·인덱스·이벤트는 서로 다른 저장소라 하나의 원자적 커밋이 불가능하다. **outbox로 롤포워드**하되,
**CAS(compare-and-swap)로 남의 변경을 절대 덮지 않는다.**

```
① BEGIN outbox (synchronous=FULL)
     INSERT outbox(op_id, seq, kind, target_path,
                   before_hash,      -- 쓰기 직전 파일의 file_hash (신규면 NULL)
                   result_hash,      -- 쓴 뒤에 나와야 할 file_hash (삭제면 NULL)
                   payload,          -- 롤포워드용 최종 바이트 (삭제면 NULL)
                   event_payload, stage='PENDING')
   COMMIT
② 파일 교체: 같은 디렉터리 temp → write → fsync(file) → rename → fsync(dir)
   → outbox.stage='FILE_DONE'  (durable)
③ index upsert (멱등)          → stage='INDEX_DONE'
④ event_id로 대상 JSONL 확인 → 없을 때만 append + fsync
   → stage='EVENT_DONE'
⑤ stage='DONE'
```

**재생(replay) 규칙** — 기동 시 `stage != 'DONE'`을 `seq` 오름차순으로 처리한다.

```
cur = file_hash(현재 디스크 파일)     // 없으면 NULL

cur == before_hash  → 아직 안 쓰였다.  ②부터 수행
cur == result_hash  → 이미 쓰였다.    stage 이후 단계만 수행
그 외               → 제3자가 바꿨다.  ★덮어쓰지 않는다★
                       outbox를 ABORTED로 표시하고 §3.6 격리에 conflict로 등록,
                       파일 현재 내용으로 인덱스만 갱신
```

- 세 번째 갈래가 핵심이다. v1은 payload를 무조건 롤포워드해서, **크래시 후 사람이 그 파일을 고쳐 놓았으면 그 수정을 지워버렸다.**
- 이벤트 append와 SQLite stage 갱신은 원자적으로 묶을 수 없다. append+fsync 직후
  `EVENT_DONE` 기록 전에 죽을 수 있으므로, 재생할 때는 `event_payload.event_id`를 알고 있는
  **대상 일자·node JSONL 한 파일**에서 먼저 찾는다. 있으면 append를 건너뛰고 stage만 전진하고,
  없으면 append+fsync한다. 정상 경로는 outbox stage로 빠르게 건너뛰고, 이 스캔은 모호한 재생
  때만 수행한다. 따라서 멱등성의 근거는 **stage + event_id 존재 확인**이며 JSONL 자체가 아니다.
- 재생 완료 전에는 도메인 쓰기 API를 **503 + `Retry-After`** 로 거절한다(순서가 뒤섞이면 CAS가 무의미해진다).

**내구성 설정**

| DB | `journal_mode` | `synchronous` | 근거 |
|---|---|---|---|
| `outbox.sqlite` | WAL | **FULL** | 여기가 끊기면 복구 근거가 사라진다 |
| `index.sqlite` | WAL | OFF | 재빌드 가능한 파생물 |
| `runtime.sqlite` | WAL | OFF | 재기동 시 어차피 만료분 전량 회수 |

> `synchronous=FULL`은 **SQLite가 fsync를 요청했고 파일시스템이 약속을 지켰을 때**의 보장이다.
> §2 고장 모델대로 하드웨어·FS 배신은 범위 밖이다.

### 3.5 워처와 조정(reconciliation)

**워처 이벤트는 힌트일 뿐이고, 스캔 결과가 정본이다.**

```
fs 이벤트 ──▶ 300ms debounce ──▶ [승격 판정] ──▶ 대상 경로만 재스캔
                                       └─ 조건 충족 ──▶ 전체 조정
```

| 승격 조건 | 값 | 근거 |
|---|---|---|
| **워처 overflow·오류 신호** | 건수 무관 **즉시** | `ENOSPC`·`EMFILE`·`IN_Q_OVERFLOW`가 뜬 순간부터 이벤트를 신뢰할 수 없다. 건수 임계치를 기다릴 이유가 없다 |
| 창당 이벤트 수 | debounce 창 내 **200건 초과** | 전체의 4%. 손편집으로는 도달 불가, git 조작이면 즉시 초과 |
| 디렉터리 단위 이벤트 | 1건이라도 즉시 | 디렉터리 rename/삭제는 하위 전체가 바뀐 것 |
| git 조작 감지 | `HEAD`·`index`·`MERGE_HEAD` 변경 | checkout·pull·머지의 가장 이른 신호 |
| 주기 안전망 | 10분 | 아래 주석 참조 |

> **git 경로 해석 주의** — `.localjira/`는 linked worktree이므로 그 안의 `.git`은 **디렉터리가 아니라
> gitdir을 가리키는 파일**이다. `.localjira/.git/HEAD`를 직접 감시하면 동작하지 않는다.
> 반드시 `git -C .localjira rev-parse --git-path HEAD|index|MERGE_HEAD`로 실경로를 얻어 감시한다.

> **10분 안전망과 AC3의 관계** — AC3의 "3초 이내 반영"은 **워처가 이벤트를 준 변경**에 대한 보장이다.
> 이벤트가 유실된 변경은 3초를 보장할 수 없고, 10분 주기 조정이 **유실의 상한**을 정할 뿐이다.
> 이 둘은 다른 보장이며, 문서·테스트에서 섞지 않는다.

**전체 조정 알고리즘**

```
1. 스캔       : .localjira/** 파일 목록 + (mtime, size)
2. 해시       : ★전체 조정은 모든 파일의 file_hash를 재계산한다★
3. 3-way diff : 인덱스 ⨝ 스캔
   - 인덱스에만 → 삭제 후보(tombstone 유예 진입)
   - 스캔에만   → 신규 파싱
   - 양쪽       → file_hash 비교, 다르면 재파싱
4. rename 판정: 신규 파일의 uid == 삭제 후보의 uid → 경로만 갱신
5. Stage B 전역 검증(§3.6)
6. 변경분 SSE 브로드캐스트
```

> **전체 조정에서 `(mtime,size)` fast-path를 쓰지 않는다.** 같은 길이로 고치고 mtime을 복원하면
> 영원히 발견되지 않는다(v1의 결함). 메타데이터 fast-path는 **증분 스캔에서만** 허용한다.
> 5,000 파일 전량 해시는 §3.7 예산 안에 든다.

- **identity는 frontmatter `uid`다.** `dev+inode`는 변경 힌트로만 쓴다 — git checkout은 파일을 새 inode로 교체하므로 inode를 identity로 삼으면 전부 "삭제 후 생성"이 된다.
- **tombstone 유예 60초**: 삭제 감지 시 `state='PENDING_DELETE'` + `delete_deadline_at`을 **DB에 영속화**한다. 서버가 유예 중에 재시작해도 기동 조정이 deadline을 보고 확정/복원을 이어간다.

### 3.6 무결성 검증과 격리

```
Stage A 구문 : UTF-8 → frontmatter 분리 → YAML subset 파싱 → 스키마
               사유: encoding | frontmatter_missing | yaml_error | yaml_unsupported
                   | schema_error | conflict_marker
Stage B 도메인: 참조 무결성 · 계층 규칙 · 순환 · 중복 uid · ACTIVE 스프린트 유일성 · 중복 표시 키
               사유: dangling_ref | hierarchy | cycle | duplicate_uid | sprint_conflict
```

| 항목 | 결정 |
|---|---|
| 저장 | `index_errors(path, uid, project, stage, reason, detail, last_good_hash, detected_at)` |
| **파싱 불가 신규 파일** | uid·project를 알 수 없다. **path를 키로 orphan 오류**를 등록하고 **전역 배너**로 표시한다. 경로 규약(`issues/{P}/…`)에서 project를 추측할 수 있으면 프로젝트 배너로 승격한다 |
| 기존 레코드 | 삭제하지 않고 `state='INVALID'`. `last_good_hash` 보존 |
| 조회 | 목록·검색·집계에서 제외. `?include_invalid=true`로만 노출 |
| 쓰기 차단 | 격리 엔티티 및 이를 직접 참조하는 관계의 변경은 **409** + `{"code":"entity_quarantined",…}` |
| 상태코드 근거 | **423 Locked를 쓰지 않는다.** 423은 "누가 잠갔고 풀면 된다"는 WebDAV 의미인데 격리는 소유자 없는 데이터 결함이다. 409가 정확하고 412(ETag)와도 구분된다 |
| 해제 | 재파싱·재검증 통과 시 **자동 해제** |
| 중복 uid | 원본 판별 불가 → 양쪽 격리 |
| 중복 표시 키 | 격리가 아니라 **재키잉**(§3.8) |

### 3.7 재인덱스·전체 검증

| | **전체 재빌드** | **전체 검증** |
|---|---|---|
| 하는 일 | 새 DB에 전량 재구축 후 교체 | 전 파일 해시 재계산·대조, 보고만 |
| 도메인 쓰기 | **큐잉**(최대 30초, 초과 시 503 + `Retry-After`) | 무중단 |
| 권한 | `admin` | `member` 이상 |
| 목표 | ≤10s | ≤10s |

**세대 교체(generation switch)** — v1의 "인덱스 파기 후 재구축"은 열린 커넥션과 새 커넥션이 서로
다른 DB를 보는 split-brain을 만든다. 대신:

```
1. index.new.sqlite 에 전량 빌드 (읽기는 기존 DB로 계속 서빙)
2. FTS 색인까지 ★완료★ 후 검증 (건수·체크섬)
3. 쓰기 큐 정지 → 커넥션 세대 전환 → rename(index.new → index) → 큐 재개
4. 이전 세대 커넥션은 드레인 후 종료
```

> **FTS를 지연 색인하지 않는다.** 지연하면 교체 직후 검색 결과가 비어 AC2 동치와 N1을 동시에 깬다.
> FTS가 예산을 넘기면 지연이 아니라 **교체를 늦춘다**(기존 세대가 계속 서빙하므로 사용자 영향 없음).

**성능 예산** — AC2 fixture는 이슈 5,000건만이 아니다. 총 파일 수로 잡는다.

| 종류 | 파일 수(가정) | 평균 크기 |
|---|---|---|
| 이슈 | 5,000 | 2 KB |
| 코멘트 원문 + op | 10,000 | 0.5 KB |
| 스프린트·run·제안 | 1,200 | 1 KB |
| 이벤트 JSONL | 400 | 200 KB (증분 오프셋 처리) |
| **합계** | **≈16,600 파일 / ≈100 MB** | |

| 단계 | 예산 | 수단 |
|---|---|---|
| 스캔 + stat | 1.0s | 재귀 readdir, stat 배치 |
| 읽기 + 해시 + 파싱 | 5.5s | 동시성 **8~16**(소파일에서 32는 오히려 경합. 실측으로 조정) |
| SQLite 적재 | 2.0s | 단일 트랜잭션 + prepared statement |
| FTS 색인 | 1.0s | 일괄 insert 후 `optimize` 1회 |
| Stage B 전역 검증 | 0.5s | 메모리 그래프 1회 순회 |

> 이 수치는 **가정이지 측정이 아니다.** M1 착수 시 cold/warm cache 양쪽으로 벤치마크해 확정한다(OQ2).
> 초과 시 1순위는 워커 스레드 분산, 2순위는 이벤트 JSONL의 오프셋 증분 강화다.

### 3.8 표시 키 자동 재키잉

D3의 "결정적"을 계산식으로 확정한다. **두 클론이 각자 조정해도 같은 답이 나와야 한다.**

```
1. 조정 Stage B에서 ★모든 충돌을 한 번에 수집★
     collisions = { key → [uid…] }  (그 프로젝트 전체)
2. 스냅샷 고정: N = 조정 시작 시점 스캔 결과의 그 프로젝트 최대 키 번호
3. 각 그룹 내 정렬: uid 문자열 사전순 → C[0]이 승자(키 유지), C[1..]이 패자
4. 전역 패자 목록을 (원래 키 번호, 패자 uid) 사전순으로 정렬
5. 그 순서대로 N+1, N+2, … 배정
```

> **v1의 결함**: 충돌 그룹을 발견 순서대로 처리하면 `LJ-13`과 `LJ-14`가 동시에 충돌했을 때
> 어느 그룹을 먼저 처리하느냐에 따라 배정 결과가 갈렸다. 4·5단계의 **전역 정렬 + 스냅샷 고정**이
> 이를 없앤다.

> **ULID 정렬의 정확한 의미**: 같은 밀리초에 만들어진 두 ULID는 뒤 80비트가 난수라
> **사전순이 생성 시각 순서와 일치하지 않을 수 있다.** 그래도 두 클론이 같은 문자열을 보므로
> **결정성은 유지**된다. D3의 "나중에 생성된 쪽"은 밀리초 해상도에서만 참이며, 동률일 때는
> "사전순 뒷쪽"이 정확한 규칙이다.

- 패자 파일의 `key`를 바꾸고 옛 키를 `former_keys[]`에 append한다. 일반 WriteTxn을 거쳐 `actor_kind=system` 이벤트를 남긴다.
- `parent`·`links`는 uid 참조라 영향이 없다. 키로 참조하는 것은 **사람의 기억과 외부 커밋 트레일러**뿐이고, 그것이 alias가 필요한 이유다.

**alias 조회 계약**

| 상황 | 응답 |
|---|---|
| 현재 키 소유자 있음 | 그 이슈를 반환하되, **같은 키를 `former_keys`로 가진 이슈가 있으면 `alias_candidates[]`에 함께 실어 보낸다** |
| 현재 키 소유자 없음 + alias 1건 | 그 이슈 반환 + `moved_to` 힌트 |
| 현재 키 소유자 없음 + alias 2건 이상 | **임의 선택 금지.** 후보 배열만 반환하고 UI·호출자가 고르게 한다 |
| FTS | 현재 키와 alias 모두 색인. alias 매치는 "옛 키" 배지 |

> v1은 "현재 키 우선"만 정하고 끝냈는데, 그러면 재키잉된 이슈는 옛 키로 **영원히 도달 불가**였다.
> `alias_candidates[]`가 그 구멍을 막는다. R23 커밋 연결은 **후보가 2건 이상이면 연결하지 않고**
> 후보만 기록한다 — 엉뚱한 이슈에 커밋이 붙는 것보다 낫다.

### 3.9 변경 전파 (SSE)

AC3의 "새로고침 없이 3초 이내"를 SSE로 구현한다. WebSocket은 양방향이 불필요하고, 폴링은 1~2초
간격이라 대부분 "변경 없음" 응답에 CPU를 태운다.

- 엔드포인트 `GET /stream`, 이벤트 `issue.changed` / `sprint.changed` / `index.state` / `integrity.changed`.
- 페이로드는 **uid와 새 etag만**. 전문을 밀면 대량 조정 시 폭주한다.
- **이벤트 ID = `{epoch}-{seq}`**. `epoch`는 서버가 `runtime.sqlite`를 새로 만들 때 발급하는 ULID다.
  - `Last-Event-ID`의 epoch가 현재와 다르면 → **무조건 `resync`**. (v1은 AUTOINCREMENT만 써서, runtime DB가 재생성되면 클라이언트의 큰 ID에 대해 "결과 0건"을 조용히 반환했다.)
  - epoch가 같아도 요청 ID가 **보관 범위(min_id) 미만**이면 `resync`.
- 버퍼는 최근 1,000건. **append와 prune을 한 트랜잭션**에서 하고 `min_id`/`max_id`를 함께 유지해, 경계에서 누락을 놓치지 않는다.

### 3.10 동시성 경계

| 수준 | 수단 |
|---|---|
| 프로세스 간 | `.local/server.lock`을 열어 **`flock`(LOCK_EX\|LOCK_NB)** 을 잡는다. 획득 실패 = 이미 실행 중 → 기동 거부(파일 안의 pid·시작시각 출력). **프로세스가 죽으면 OS가 잠금을 자동 해제**하므로 stale lock 판정·삭제·재생성이 필요 없다 |
| | *(v1의 pid 생존 검사 후 삭제 방식은 TOCTOU이고 pid 재사용에 오판한다 — 폐기)* |
| 파일 단위 | 경로별 async mutex(직렬 큐) |
| 논리 단위 | ETag `If-Match` 불일치 → **412** + 현재 문서 전문 + 최신 ETag + 거부된 요청 값 |
| 런타임 상태 | claim/lease는 `runtime.sqlite`. 재기동 시 만료분 전량 회수, AC2 동치 비교에서 제외 |

## 4. 대안 및 트레이드오프

- **A. 인덱스 없이 파일 직접 조회** — (−) 5,000건 필터·FTS에 매 요청 전체 스캔. N1 불가. → 기각.
- **B. SQLite를 SoT로** — (+) §3.4 전체가 불필요. (−) git diff·AI 직접 읽기라는 제품 정체성 상실. → 기각.
- **C. 파일 바이트 해시를 ETag로** — (+) 구현 단순. (−) `core.autocrlf`·에디터 정리만으로 전원 412. → 기각(§3.2 두 해시 분리).
- **D. 워처 이벤트만 신뢰** — (−) 유실·overflow에서 조용히 어긋나고, 어긋난 사실조차 모른다. → 기각.
- **E. 재빌드 중 쓰기 409 차단** — (−) 10초간 에이전트 run이 실패 종료. → 기각, 30초 상한 큐잉.
- **F. 중복 키를 격리 처리** — (−) 오프라인 작업마다 사람이 개입. → 기각, 결정적 재키잉(D3).
- **G. outbox 무조건 롤포워드** — (+) 단순. (−) 크래시 후 사람이 고친 파일을 지운다. → 기각, CAS 3분기(§3.4).

**감수하는 것**

- 인덱스와 파일이 **순간적으로 어긋난다**(외부 편집 후 최대 300ms + 파싱). 강한 일관성이 아니라 **수렴**을 보장한다.
- 단계별 durable `stage` 갱신으로 쓰기당 **fsync가 3~4회** 발생한다. 정확성의 대가이며, 로컬 SSD 기준 수 ms다.
- 5,000건(총 16,600파일)은 설계 목표이고 그 이상은 검증되지 않았다.
- 유니코드 정규화를 하지 않으므로 macOS/Linux 혼용 팀에서 드물게 헛 412가 날 수 있다(OQ5).

## 5. 영향 (Impact)

| 대상 | 영향 |
|---|---|
| R10 | ETag는 **API 표현**의 validator다. 클라이언트는 불투명 문자열로 다뤄야 하며 파일 해시와 혼동하면 안 된다 |
| R15 | `outbox.sqlite`에 `idempotency` 테이블을 함께 둔다. 같은 키·다른 페이로드는 `request_hash` 비교로 판별(스토리 r15의 미정 항목) |
| R23 | §3.8 alias 다중 매치 시 **연결하지 않는다**. 후보만 기록 |
| R25 | 재키잉이 파일을 고치므로 미커밋 건수가 사람 조작 없이 증가한다. 배지 툴팁에 "system 변경 포함" 필요 |
| M2 보드 | SSE `issue.changed`를 그대로 구독. 별도 채널 불필요 |
| M3 claim | `runtime.sqlite`는 백업·재빌드 대상이 아니다. 경계를 침범하지 말 것 |
| 테스트 | fault injection 지점이 5개가 아니라 **stage 전이마다**(PENDING/FILE_DONE/INDEX_DONE/EVENT_DONE/DONE) 필요하다. 훅을 **처음부터** WriteTxn에 심는다 |

## 6. 열린 질문 (Open Questions)

- **OQ1** FTS5 토크나이저 — 한국어에 `unicode61`은 어절 단위라 부분 일치가 약하고 `trigram`은 색인이 3~5배 커진다. 실측 후 결정(r04b도 같은 질문).
- **OQ2** §3.7 성능 예산은 **가정**이다. cold/warm cache 벤치마크로 확정하고, 동시성 8~16의 최적값도 함께 정한다.
- **OQ3** `former_keys` 상한을 둘지. 무제한이면 인덱스가 늘고, 상한을 두면 오래된 커밋 트레일러가 끊긴다.
- **OQ4** 재키잉을 자동 적용 전에 사람에게 알릴지. 현재는 조용히 적용 후 이벤트만 남긴다.
- **OQ5** 유니코드 정규화 미적용의 실제 영향 — macOS/Linux 혼용 팀에서 한국어 제목의 헛 412 발생 빈도를 측정한 뒤, 필요하면 "비교 시에만 NFC" 예외를 도입할지 결정한다.
- **OQ6** 번다운 스냅샷(D12)의 파일 형식 계약 — append 형식, 같은 `day` 중복 시 처리, 프로젝트 timezone 변경 시 과거 스냅샷 해석. §3.3 표에 자리만 잡아두었다.

## 7. 참고

- PRD `../../2_requirements/prd/backlog-sprint.md` §5.3~§5.7 · §13 D1·D3·D5·D10~D14
- ADR `../../0_decisions/adr-006-shared-board-data-branch.md`
- 스키마 `../database/index-schema.md`
- 스토리 `../../2_requirements/story/` — r08a·r08b·r08c·r09·r10·r11a·r11b·r21·r26
- 검증 이력: v1에 대한 codex 교차검증 30건(High 20) 반영. 미채택은 OQ로 이관.
