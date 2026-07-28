---
title: "도메인 변경 이벤트 기록 (actor_kind 구분)"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R14
milestone: M1
priority: P0
---

# 도메인 변경 이벤트 기록 (actor_kind 구분)

> R14를 두 스토리로 분할한다. 본 스토리는 **무엇을 어떤 주체로 파일에 남기는가**(N7 감사 범위·`actor_kind` 판정·append 경로)를 다루고,
> `r14b-issue-activity-timeline.md`가 그 이벤트를 **사람이 읽는 화면**으로 보여준다. 백엔드 기록 규칙과 화면 표기 규칙은 검증 방법이 다르다.

## 사용자 스토리 (User Story)

> **As a** 사람과 에이전트가 같은 보드를 함께 쓰는 팀,
> **I want** 모든 도메인 변경이 주체 종류와 함께 append-only 이벤트로 파일에 남기를,
> **so that** "이 이슈를 누가 언제 어떻게 바꿨나"를 인덱스를 지우고 재빌드해도 잃지 않고, 에이전트 변경과 사람 변경을 섞어 보지 않는다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given N7 감사 범위의 각 행위(이슈 생성, **모든 필드 변경**, 상태 전이, 코멘트, claim, run, 삭제, 권한/토큰 변경), When 각각을 1회 수행하면, Then 행위당 이벤트가 1건씩 남는다(AC17).  
      **→ 이월: 부분 충족 — 이슈·권한 행위는 1건씩 기록된다. 코멘트(M3)·claim/run(M4)은 엔티티가 없다**
- [x] Given `GET /issues`·검색·필터 호출, When 여러 번 반복하면, Then 이벤트가 **한 건도 생성되지 않는다**(N7 — 조회·검색 제외).
- [x] Given 임의의 이벤트 1건, When 레코드를 확인하면, Then `event_id`, `at`(RFC 3339, §5.2), `actor_id`, `actor_kind`, `run_id`, `target`, `verb`, `before`/`after`가 포함된다(§5.1 Event).
- [x] Given `actor_kind`, When 값을 확인하면, Then `human` / `agent` / `external` / `system` 넷 중 하나다.
- [x] Given 이벤트 append, When 저장 경로를 확인하면, Then `.localjira/events/<YYYY-MM-DD>/<node_id>.jsonl`에 append되며 클론(설치)별로 파일이 갈려 **두 클론이 같은 파일의 같은 위치를 고치는 머지 충돌이 생기지 않는다**(§5.3).
- [x] Given API를 통한 쓰기, When 처리 순서를 관찰하면, Then ① outbox 기록 → ② 파일 원자적 교체 → ③ 인덱스 upsert → ④ 이벤트 append → ⑤ outbox 완료 표시 순이며, ③~④는 멱등이라 기동 시 미완료 outbox를 재생해도 **이벤트가 중복되지 않는다**(§5.5, AC15).
- [x] Given API 밖에서 에디터로 이슈 파일을 직접 수정, When 조정(reconcile)이 끝나면, Then 이벤트가 `actor_kind=external`·`actor_id=unknown`으로 기록된다(AC3).
- [ ] Given 외부 변경이 git commit으로 들어왔고 commit author를 알 수 있는 경우, When 이벤트를 확인하면, Then author는 `source_commit` **참고 정보로만** 남고 `actor_id`로 승격되지 않으며 `actor_kind`는 여전히 `external`이다(§5.7).  
      **→ 이월: r08c-bulk-reconcile(Wave 3) — `source_commit` 필드는 있으나 git 귀속이 아직 채워지지 않는다**
- [x] Given 서버 자신이 남긴 쓰기, When 워처가 그 파일 변경(`write_op_id` + 최종 content hash 일치)을 다시 관측하면, Then 재파싱은 하되 **추가 도메인 변경·추가 이벤트를 만들지 않는다**(§5.5 자기 쓰기 되울림).
- [ ] Given 서버 주도 변경(재기동 시 만료 claim 전량 회수 §5.4, 표시 키 자동 재키잉 D3), When 이벤트를 확인하면, Then `actor_kind=system`으로 기록되고 재키잉의 경우 이전 키·새 키가 남는다(AC25).  
      **→ 이월: r16-claim-lease(M4) / D3 재키잉**
- [ ] Given 에이전트 토큰으로 수행한 상태 변경, When 이벤트를 확인하면, Then `actor_kind=agent`와 함께 `run_id`, `initiated_by`(지시한 사람 계정)가 기록된다(AC6, §6.2 대리 실행).  
      **→ 이월: r13b-pat-scope(M4) — `run_id`·`initiated_by` 경로**
- [ ] Given 동일 `Idempotency-Key`로 생성 API를 재전송, When 이벤트를 확인하면, Then **중복 이벤트가 생기지 않는다**(AC18 — 상세는 `r15-idempotency-key.md`).  
      **→ 이월: r15-idempotency-key(M3)**
- [x] Given 5,000건 규모 fixture, When `.local/index.sqlite`를 삭제하고 재기동하면, Then 이벤트는 파일 SoT에 있으므로 삭제 전후 조회 결과가 정규화 비교로 동일하다(AC2).
- [x] Given 권한/토큰 변경 이벤트, When 본문을 확인하면, Then 비밀번호 해시·평문 토큰·토큰 해시가 `before`/`after`에 포함되지 않는다(N6).

> ⚠ 미정: 이벤트 파일의 보존 기간·회전(rotate)·아카이브 정책 — 날짜 디렉터리 분할만 규정되어 있고 장기 누적 시 처리 방침은 없다.

## 범위 밖 (Out of Scope)

- **변조 방지(tamper-evident) 감사** — hash chain·서명은 §3 비목표다. 파일 SoT 구조에서는 누구나 이벤트 파일을 편집·삭제할 수 있으며, 1차 이벤트 로그는 **협업 이력**이지 보안 감사 증적이 아니다(§5.7).
- 이슈 상세의 활동 타임라인 UI·배지 표기 — `r14b-issue-activity-timeline.md`.
- 조회·검색 접근 로그(N7 명시 제외).
- 이벤트 기반 알림 발송 (1차는 In-App 활동 피드까지, §3).
- outbox 재생·원자적 저장 구현 자체 — R9.

## 선행 의존 (Depends on)

- `r12a-admin-bootstrap-login.md` (이벤트에 기록할 인증된 `actor_id`가 선행되어야 한다)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(Event 엔티티), §5.3(events 디렉터리 분할), §5.4(런타임 상태·재키잉), §5.5(쓰기 순서·되울림·외부 변경), §5.7(감사 로그의 한계·external 주체), §6.2, §7 R14, §9 N7, §12 M1
- 검증: PRD AC6·AC17, 보조 AC2·AC3·AC15·AC18·AC25
