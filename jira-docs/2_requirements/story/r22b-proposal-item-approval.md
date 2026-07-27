---
title: "Proposal 항목 단위 승인·기각과 백로그 편입"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R22
milestone: M5
priority: P2
---

# Proposal 항목 단위 승인·기각과 백로그 편입

## 사용자 스토리 (User Story)

> **As a** 오너/PO,
> **I want** AI가 제안한 스토리 후보를 **한 건씩** 편집·승인·기각하고, 중간에 하나가 실패해도 이미 승인한 것이 날아가거나 두 번 생기지 않기를,
> **so that** 쓸 만한 제안만 백로그에 들이면서, 파일 SoT가 보장하지 못하는 전량 원자성을 기다리느라 작업이 막히지 않는다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 후보 3건을 가진 `DRAFT` Proposal, When 1건만 [승인]하면, Then 이슈 1건이 생성되어 백로그 조회에 나타나고, 그 후보 항목에 **`created_issue_uid`** 가 기록되며, 나머지 2건은 미처리로 남고 Proposal은 **`DRAFT` 유지**다. *(R22, AC9)*
- [ ] Given 후보 3건 전부를 승인 또는 기각으로 처리, When 마지막 항목이 처리되면, Then Proposal `state`가 **`APPROVED`** 로 전환된다. *(R22)*
- [ ] Given 후보 3건 승인 요청 중 **2번째 생성이 실패**, When 결과를 확인하면, Then 1번째 이슈는 생성된 채 남고 그 항목에 `created_issue_uid`가 기록되며, Proposal은 **`DRAFT`로 남는다** — 이미 생성된 이슈를 되돌리는 전량 롤백은 하지 않는다. *(R22, AC9)*
- [ ] Given 위 부분 실패 상태, When 같은 Proposal의 승인을 **재시도**하면, Then `created_issue_uid`가 이미 있는 항목은 건너뛰고 미처리 항목만 생성된다 — **중복 이슈가 생기지 않는다**. *(AC9)*
- [ ] Given 승인 요청이 타임아웃되어 클라이언트가 같은 요청을 재전송, When 처리하면, Then `created_issue_uid` 기록을 근거로 중복 생성이 차단된다. *(AC9, 보조 R15)*
- [ ] Given 후보 1건을 [기각], When 처리하면, Then **이슈가 생성되지 않고** 해당 항목이 기각으로 표시되며 `created_issue_uid`는 비어 있다.
- [ ] Given 승인 전 후보를 [편집], When 제목·설명·인수조건·타입·포인트를 고쳐 승인하면, Then **편집된 내용으로** 이슈가 생성된다.
- [ ] Given 승인으로 생성된 이슈, When 백로그에서 조회하면, Then 이제 결과에 나타난다. 상태는 `BACKLOG`이며, 정제되지 않은 항목을 에이전트가 임의로 착수하지 못하도록 사람이 `TODO`로 올리기 전까지 claim 대상이 아니다. *(§4 S1, §6.1)*
- [ ] Given 승인으로 생성된 이슈, When 백로그 카드와 이슈 상세를 보면, Then **AI 제안에서 온 항목임이 배지로 시각 구분**되고 출처 Proposal로 이동할 수 있다 — 사람이 직접 만든 이슈와 같은 모양으로 보이지 않는다. *(§8 주체 표기 규칙)*
- [ ] Given 승인 실행, When 활동 타임라인을 보면, Then 이슈 생성 이벤트가 N7 감사 범위대로 기록되고 actor는 **승인 버튼을 누른 사람**으로 남는다. *(§9 N7, R14)*
- [ ] Given Proposal이 `APPROVED`(또는 `REJECTED`)로 전환된 상태, When 같은 Proposal에 다시 승인·기각을 시도하면, Then 종료 상태이므로 거부된다.
- [ ] Given 승인 도중 프로세스가 죽음, When 재기동해 Proposal을 다시 열면, Then 이미 생성된 항목의 `created_issue_uid`가 파일에 남아 있어 재시도가 중복을 만들지 않고, Proposal은 `DRAFT`로 이어서 처리할 수 있다. *(AC9, §5.5 outbox 재생)*
- [ ] Given 승인·기각으로 파일이 바뀜, When `git -C .localjira status`를 보면, Then 생성된 이슈 파일과 Proposal 파일이 미커밋으로 잡히고 미커밋 배지 건수가 증가한다 — **서비스는 커밋·푸시하지 않는다**. *(D4, R25)*
- [ ] Given Proposal 파일 갱신(항목별 `created_issue_uid` 기록), When 저장하면, Then 원자적 교체 규칙을 따라 부분 YAML 상태가 남지 않는다. *(§5.4, N5)*

> ⚠ 미정: 후보 **전량을 기각**했을 때 Proposal state — PRD는 "전 항목 처리 시 `APPROVED`"만 규정하고 `REJECTED` 전환 조건을 정하지 않는다.
> ⚠ 미정: 승인 전 편집 시 **AI 원안을 보존**할지(Proposal 파일에 원문 + 편집본 병기) 덮어쓸지.
> ⚠ 미정: 생성된 이슈의 **`created_by_kind` 값** — 내용은 AI가 만들고 승인은 사람이 눌렀다. §5.1은 이 값이 불변이라고만 하고 이 경로의 값을 정하지 않는다. 값이 `human`이면 §8의 "에이전트 변경이 사람 변경처럼 보여서는 안 된다"와 충돌하므로 배지 근거를 별도 필드(출처 `proposal_id`)로 둘지 함께 결정해야 한다.
> ⚠ 미정: 생성 이벤트에 **출처 `proposal_id`** 를 기록할지 — PRD 미규정.
> ⚠ 미정: 승인·기각에 필요한 **역할·scope** — §6.4의 scope 목록에 이슈 "생성" scope가 없다(`issue:edit`이 가장 근접).
> ⚠ 미정: 이슈 파일 생성 직후 **`created_issue_uid` 기록 전** 크래시 창의 중복 방지 수단 — outbox 재생과 `Idempotency-Key` 중 무엇으로 메울지 PRD 미규정.
> ⚠ 미정: 승인된 이슈의 `backlog_rank` 초기값(최하단 배치 vs 지정) — PRD 미규정.
> ⚠ 미정: 한 번에 여러 항목을 승인하는 일괄 승인 UI 제공 여부(제공 시에도 처리는 항목 단위여야 한다).

## 범위 밖 (Out of Scope)

- 정제 실행·LLM 호출·Proposal 생성 → `r22a-ai-refine-proposal.md`
- **전량 원자적 승인** — 파일 SoT에서는 보장할 수 없으므로 요구하지 않는다(§14 2차 검증에서 철회된 요구사항)
- 이슈 CRUD·계층·링크 규칙 자체 → R1·R2
- 백로그 순서(LexoRank) 재배치 → R3
- 승인된 이슈를 스프린트에 담는 계획 작업 → R6

## 선행 의존 (Depends on)

- `r22a-ai-refine-proposal.md`
- `r01a-issue-create-read.md`
- `r15-idempotency-key.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §4 S1 · §5.1(Proposal `state`) · §5.4(원자적 저장) · §5.5(outbox 재생) · §6.1(BACKLOG 항목의 claim 제약) · §7 R22 · §8(정제 화면·주체 표기) · §12 M5 · §13 D4
- 검증: PRD AC9
