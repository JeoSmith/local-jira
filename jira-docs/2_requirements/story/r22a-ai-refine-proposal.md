---
title: "AI 백로그 정제 — 요구사항 텍스트에서 Proposal 생성"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R22
milestone: M5
priority: P2
---

# AI 백로그 정제 — 요구사항 텍스트에서 Proposal 생성

## 사용자 스토리 (User Story)

> **As a** 오너/PO,
> **I want** 요구사항 문단을 붙여넣고 정제를 실행해 스토리 후보 N건을 **제안(Proposal)** 으로 받기를,
> **so that** 티켓을 한 건씩 손으로 옮겨 적지 않으면서도, 검토하지 않은 AI 산출물이 백로그에 그대로 섞여 들어가지는 않는다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given `/projects/:key/refine` 화면, When 요구사항 텍스트를 붙여넣고 [정제 실행]을 누르면, Then 스토리 후보 N건을 담은 Proposal 1건이 생성되고 `.localjira/proposals/LJ/<ULID>.yaml` 파일 **1개**만 만들어진다. *(§5.3, §8)*
- [ ] Given 방금 생성된 Proposal, When 파일을 열면, Then `proposal_id`, `source`(입력 원문 또는 출처 이슈 참조), `suggested[]`(후보별 제목·설명·인수조건 등), `state: DRAFT`가 기록되어 있다. *(§5.1)*
- [ ] Given Proposal이 `DRAFT`인 상태, When 백로그 조회·필터·전문 검색·보드를 확인하면, Then 제안 항목은 **어디에도 나타나지 않는다**. `.localjira/issues/` 아래에 이슈 파일도 생기지 않는다. *(AC9, R22)*
- [ ] Given 정제 실행, When LLM으로 나가는 페이로드를 확인하면, Then 사용자가 입력한 요구사항 텍스트와 (출처가 기존 이슈인 경우) 그 이슈의 **제목·설명·인수조건만** 포함되고, **코멘트와 계정 정보**(`users.yaml`의 표시명·`author_id`·토큰)는 포함되지 않는다. *(Q10 기본 가정)*
- [ ] Given LLM 응답 수신, When Proposal에 기록하면, Then **사용한 모델 식별자와 프롬프트 버전**이 함께 저장되어 나중에 어떤 모델이 만든 제안인지 되짚을 수 있다. *(Q10 기본 가정)*
- [ ] Given 네트워크가 끊긴 환경, When 정제 외의 기능(백로그·보드·스프린트·검색)을 쓰면, Then 전부 정상 동작하고 정제 실행만 오류로 실패한다. *(N4)*
- [ ] Given LLM API 키, When 저장 위치를 확인하면, Then `.env` 등 **git 추적 밖 경로**에 있고 `.localjira/` 아래 어떤 파일(Proposal 포함)에도 기록되지 않는다. *(N6)*
- [ ] Given LLM 응답이 기대 스키마와 다르거나 비어 있음, When 처리하면, Then Proposal이 생성되지 않고 오류가 표시되며, **부분 파싱된 불완전 YAML 파일이 남지 않는다**.
- [ ] Given Proposal 파일 저장 도중 프로세스가 죽음, When 재기동하면, Then 파일은 **이전 버전 또는 새 버전 중 하나의 완전한 상태**다(같은 디렉터리 temp → fsync → rename). *(§5.4, N5)*
- [ ] Given 정제를 여러 번 실행, When `/projects/:key/refine`를 열면, Then `DRAFT` Proposal 목록이 나열되고 각 후보 항목이 **AI 산출물임이 배지로 시각 구분**된다 — 사람이 쓴 이슈와 같은 모양으로 보이지 않는다. *(§8 주체 표기 규칙)*
- [ ] Given Proposal이 생성됨, When `git -C .localjira status`를 보면, Then `proposals/` 아래 파일 1건이 미커밋으로 잡히고 미커밋 배지 건수가 증가한다 — **서비스는 커밋·푸시하지 않는다**. *(D4, R25)*

> ⚠ 미정: **비용 상한** — 호출당 토큰 한도·일일/월간 예산과 초과 시 동작(차단 vs 경고).
> ⚠ 미정: **timeout·재시도** — LLM 호출 타임아웃 값, 재시도 횟수·백오프, 재시도 시 중복 Proposal 방지 수단.
> ⚠ 미정: **결과 provenance 범위** — 모델·프롬프트 버전 외에 요청 원문·응답 원문·토큰 사용량까지 남길지, 남긴다면 Proposal 파일 안인지 별도 경로인지.
> ⚠ 미정: **삭제·보존 정책** — 처리 완료(`APPROVED`/`REJECTED`)된 Proposal 파일을 영구 보존할지, 일정 기간 후 정리할지, 사람이 수동 삭제할 수 있는지.
> ⚠ 미정: 전송 전 **사용자 확인** — 무엇이 전송되는지 미리보기·동의를 요구할지 여부(Q10의 "사용자 확인" 항목).
> ⚠ 미정: LLM 공급자·모델 선택 UI와, 키가 설정되지 않았을 때 정제 메뉴를 숨길지 비활성화할지.
> ⚠ 미정: Proposal 생성이 N7 감사 범위에 포함되어 이벤트로 기록되는지 — §9 N7 목록에 Proposal 관련 행위가 없다.
> ⚠ 미정: 정제 실행에 `Idempotency-Key`가 적용되는지 — §5.4는 `POST /issues`·`/comments`·`/runs`만 열거한다.
> ⚠ 미정: 정제 실행을 AgentRun(R17)으로 기록할지 여부 — PRD가 정제와 AgentRun을 연결하지 않는다.

## 범위 밖 (Out of Scope)

- 후보의 승인·편집·기각과 이슈 생성 → `r22b-proposal-item-approval.md`
- 이슈 생성 API·파일 형식 자체 → R1
- 정제 외의 LLM 기능(이슈 요약, 코멘트 생성, 자동 추정) — 1차 범위에 없다
- 기존 Jira 티켓 임포트 — 비목표로 확정(D6)
- 에이전트의 claim/lease·AgentRun 운영 → R16·R17

## 선행 의존 (Depends on)

- `r01a-issue-create-read.md` (제안 후보의 필드 구조가 이슈 스키마를 따른다)
- `r08a-file-index-sync.md` (`.localjira/` 원자적 쓰기 경로)

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §4 S1(백로그 정제 시나리오) · §5.1(Proposal 엔티티) · §5.3(`proposals/LJ/<ULID>.yaml`) · §5.4(원자적 저장) · §7 R22 · §8(정제 화면·주체 표기) · §12 M5 · §13 D4·Q10
- NFR: N4(오프라인 예외), N5(데이터 안전), N6(LLM 키 git 추적 금지)
- 검증: PRD AC9(승인 전 백로그 미노출 부분)
