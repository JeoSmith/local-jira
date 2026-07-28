---
title: "외부 파일 변경 조정 — 워처는 힌트, 재스캔이 정본"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R8
milestone: M1
priority: P0
---

# 외부 파일 변경 조정 — 워처는 힌트, 재스캔이 정본

> **R8 분할 사유**: 본 스토리는 R8(§5.5) 중 **에디터 직접 편집 등 API 밖 단건 변경의 조정 경로**만 다룬다.

## 사용자 스토리 (User Story)

> **As a** 개발자,
> **I want** VS Code로 `LJ-12.md`를 직접 고쳐도 보드가 스스로 따라오고 그 변경이 "외부 변경"으로 구분 기록되기를,
> **so that** 파일이 원본이라는 약속을 믿고 에디터·스크립트로 편하게 손대면서도, 누가 바꿨는지 헷갈리지 않는다.

## 인수 조건 (Acceptance Criteria)

- [x] Given 이슈 상세 화면을 연 상태, When 에디터로 `.localjira/issues/LJ/LJ-12.md`의 `title`을 바꿔 저장하면, Then **새로고침 없이 3초 이내** 화면에 새 title이 반영된다. *(AC3)*
- [x] Given 위 외부 변경, When 활동 타임라인을 보면, Then 이벤트가 `actor_kind=external`, `actor_id=unknown`으로 기록된다. git commit author를 찾을 수 있어도 `source_commit` **참고 정보로만** 남고 인증된 actor로 승격되지 않는다. *(§5.7)*
- [x] Given 워처가 같은 파일에 대해 100ms 간격으로 20건의 이벤트를 뿜는 저장 패턴(에디터 임시파일 포함), When debounce(**≥300ms**) 창이 닫히면, Then 영향 디렉터리 재스캔이 **1회만** 수행되고 도메인 이벤트도 최종 상태 기준 **1건**만 남는다.
- [x] Given 워처를 비활성화하거나 이벤트가 유실된 환경, When 조정을 트리거하면(기동·주기·수동), Then 파일 재스캔 결과가 그대로 반영된다 — **워처 이벤트가 하나도 오지 않아도 최종 상태는 동일**하다. 워처는 힌트일 뿐 정본이 아니다.
- [x] Given API 쓰기로 서버가 방금 남긴 파일, When 워처가 그 변경을 되울림으로 관측하면, Then 서버가 남긴 `write_op_id` + 최종 content hash가 일치하므로 **재파싱은 하되 추가 도메인 변경과 이벤트를 0건** 만든다.
- [x] Given API 쓰기 직후 사람이 그 파일을 즉시 다시 외부 편집, When 조정하면, Then content hash가 서버가 기록한 값과 달라 되울림이 아닌 **external 변경으로 판정**되어 이벤트가 1건 남는다.
- [x] Given 외부 변경으로 content hash가 바뀐 이슈, When 조정이 끝나면, Then 해당 리소스의 강한 ETag가 새 hash로 갱신되고, 변경 전 ETag를 `If-Match`로 보낸 요청은 **412**다. *(R10 연계)*
- [ ] Given 외부에서 frontmatter를 파싱 불가능한 YAML로 저장, When 조정하면, Then 화면·API가 죽지 않고 해당 엔티티만 격리 경로로 넘어간다. *(판정 규칙은 R11)*  
      **→ 이월: r11a-integrity-quarantine(Wave 4) — 죽지 않는 것까지만 충족, 격리 판정은 R11**
- [x] Given 외부 편집으로 알 수 없는 frontmatter 키가 추가됨, When 조정하면, Then 그 키는 인덱싱되지 않되 파일에서 제거되지도 않는다.
- [ ] Given 조정 대상이 코멘트 `.ops.jsonl`에 외부에서 append된 op 1건, When 조정하면, Then 코멘트 현재 상태가 op 재생으로 갱신되고 원문 파일은 손대지 않는다.  
      **→ 이월: r15-idempotency-key(M3) — 코멘트 `.ops.jsonl`이 M3 산출물**

> ⚠ 미정: "새로고침 없이 3초 이내 반영"의 전송 방식(SSE / WebSocket / 폴링)을 PRD가 지정하지 않았다.

## 범위 밖 (Out of Scope)

- 인덱스 스키마·전체 재빌드 → `r08a-file-index-sync.md`
- `git checkout`/`pull` 등 대량 변경, 워처 overflow 승격, tombstone → `r08c-bulk-reconcile-tombstone.md`
- 격리(INVALID) 판정 규칙과 오류 배너 → R11
- 외부 변경 주체의 신뢰 가능한 식별 — §5.7에서 명시적으로 포기한 범위다
- 실시간 다중 편집(CRDT) — §3 비목표

## 선행 의존 (Depends on)

- `r08a-file-index-sync.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.5(자기 쓰기 되울림·외부 파일 변경) · §5.7(주체 식별의 한계) · §1(핵심 성질 2)
- 검증: PRD AC3
