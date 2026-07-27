# 스토리 인덱스

`../prd/backlog-sprint.md`의 요구사항 R1~R26을 42개 스토리로 분해한 결과다.
각 파일은 `../../8_templates/story.md`(HPMS) 형식을 따르며, 인수 조건은 PRD §10의 AC를 구현 단위로 잘게 푼 것이다.

## 마일스톤별

### M0 — 부트스트랩
`localjira/data` orphan 브랜치 + worktree 초기화. 스토리 없음 — [ADR-006](../../0_decisions/adr-006-shared-board-data-branch.md)의 셋업 절차를 명령으로 감싸는 작업이다.

### M1 — 신뢰 가능한 코어 (20건)

첫 실행 계획: [Sprint 01 — M1 신뢰 가능한 코어](../../4_plans/sprints/sprint-01-m1-reliable-core.md)

| 스토리 | R | 내용 |
|---|---|---|
| [r08a](r08a-file-index-sync.md) | R8 | 파일 SoT ↔ SQLite 인덱스, 전체 재빌드 동치성 |
| [r08b](r08b-external-change-reconcile.md) | R8 | 외부 편집 조정, 자기 쓰기 되울림 억제 |
| [r08c](r08c-bulk-reconcile-tombstone.md) | R8 | 대량 조정(git pull/checkout), 삭제·rename tombstone |
| [r09](r09-atomic-write-outbox-recovery.md) | R9 | 원자적 저장(fsync), outbox 크래시 복구, 단일 writer lock |
| [r10](r10-etag-optimistic-concurrency.md) | R10 | 강한 ETag + If-Match, 412 |
| [r11a](r11a-integrity-validation-quarantine.md) | R11 | 파싱·도메인 검증 분리, 격리(INVALID) |
| [r11b](r11b-integrity-error-banner.md) | R11 | 오류 배너·복구 안내 |
| [r21](r21-manual-reindex-full-verify.md) | R21 | 수동 전체 재인덱스·전체 검증 |
| [r26](r26-auto-rekey-former-keys.md) | R26 | 결정적 자동 재키잉, `former_keys` alias |
| [r01a](r01a-issue-create-read.md) | R1 | 이슈 생성·조회, uid/키 발급 |
| [r01b](r01b-issue-update-delete.md) | R1 | 수정·전이표 강제·삭제 |
| [r02a](r02a-issue-hierarchy.md) | R2 | 계층 규칙, 부모 삭제 `strategy` |
| [r02b](r02b-issue-links.md) | R2 | 관계 링크, `claimable` 파생 |
| [r03](r03-backlog-rank-lexorank.md) | R3 | LexoRank 정렬·재균형 |
| [r04a](r04a-issue-filter.md) | R4 | 구조화 필터 |
| [r04b](r04b-fulltext-search.md) | R4 | FTS5 전문 검색, 옛 키 조회 |
| [r12a](r12a-admin-bootstrap-login.md) | R12 | admin 부트스트랩·로그인 |
| [r12b](r12b-role-authorization.md) | R12 | 역할 인가 401/403 |
| [r14a](r14a-event-recording.md) | R14 | 이벤트 기록, actor_kind 4종 |
| [r14b](r14b-issue-activity-timeline.md) | R14 | 활동 타임라인·카드 배지 |

### M2 — 스프린트 (6건)

| 스토리 | R | 내용 |
|---|---|---|
| [r05a](r05a-sprint-crud.md) | R5 | 스프린트 CRUD |
| [r05b](r05b-sprint-start-close-carryover.md) | R5 | 시작·종료·이월, ACTIVE 유일성 |
| [r06](r06-sprint-planning-capacity.md) | R6 | 계획 화면, capacity 경고 |
| [r07a](r07a-board-columns-cards.md) | R7 | 보드 렌더·카드 배지 |
| [r07b](r07b-board-drag-transition-rank.md) | R7 | 드래그 전이·`board_rank` |
| [r25](r25-git-status-badge.md) | R25 | git 상태 배지(읽기 전용) |

### M3 — 에이전트 운영 (7건)

| 스토리 | R | 내용 |
|---|---|---|
| [r13a](r13a-pat-lifecycle.md) | R13 | PAT 발급·폐기·만료 |
| [r13b](r13b-pat-scope-enforcement.md) | R13 | scope 강제, claim 결합 403 |
| [r15](r15-idempotency-key.md) | R15 | `Idempotency-Key` |
| [r16a](r16a-issue-claim.md) | R16 | 원자적 claim 취득 |
| [r16b](r16b-lease-heartbeat-forced-release.md) | R16 | lease·heartbeat·강제 해제 |
| [r17a](r17a-agent-run-lifecycle.md) | R17 | AgentRun 생명주기 |
| [r17b](r17b-agent-run-structured-result.md) | R17 | 구조화 결과 제출 |

### M4 — 협업 품질 (4건)

| 스토리 | R | 내용 |
|---|---|---|
| [r18](r18-agent-task-context-api.md) | R18 | 구조화 작업 컨텍스트 API |
| [r19a](r19a-comment-kind-and-resolution.md) | R19 | 코멘트 종류·해결 상태 |
| [r19b](r19b-unresolved-comment-gating.md) | R19 | 미해결 게이팅 |
| [r20](r20-sprint-burndown.md) | R20 | 번다운·완료율 |

### M5 — 부가 (5건)

| 스토리 | R | 내용 |
|---|---|---|
| [r22a](r22a-ai-refine-proposal.md) | R22 | AI 정제 → Proposal 생성 |
| [r22b](r22b-proposal-item-approval.md) | R22 | 항목 단위 승인 |
| [r23](r23-git-commit-trailer-link.md) | R23 | 커밋 트레일러 스캔 |
| [r24a](r24a-keyboard-shortcuts-command-palette.md) | R24 | 단축키·커맨드 팔레트 |
| [r24b](r24b-export-csv-json.md) | R24 | CSV/JSON 내보내기 |

## 읽는 순서 (M1 착수 시)

저장 코어가 다른 모든 것의 토대다. `r09`(원자적 저장·복구) → `r08a`(인덱스 동치성) → `r10`(ETag) →
`r11a`(격리) 순으로 읽으면 저장 계약이 잡히고, 그 위에서 `r01a`~`r04b`(백로그)가 자연스럽게 얹힌다.
`r12a`·`r14a`는 병렬 진행 가능하되 **`r01a` 착수 전에 actor 모델이 정해져 있어야** 이벤트에 주체가 빈 채로 쌓이지 않는다.

## 미정 항목

각 스토리 안에 `> ⚠ 미정:` 으로 **113건**이 남아 있다(M1 23 · M2 20 · M3 15 · M4 14 · M5 41).
API 세부 스키마·UI 문구·임계치 기본값 등 설계 단계(`../../3_designs/`)에서 정할 것들이며 M1 착수를 막지 않는다.

- 계약·저장 구조에 직접 영향을 준 항목은 PRD §13의 **D10~D14**와 ADR-001~006으로 확정하고,
  관련 스토리에서 `결정됨`으로 전환했다.
- M5에 41건이 몰린 것은 **Q10(LLM 전송 정책)이 미결**이라 R22~R24가 전제를 못 세운 탓이다. Q10을 닫으면 대부분 해소된다.

```bash
# 미정 항목 전체 훑기
grep -rn "⚠ 미정" docs/2_requirements/story/
```
