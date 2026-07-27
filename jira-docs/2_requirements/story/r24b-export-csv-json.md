---
title: "CSV/JSON 내보내기"
status: draft
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R24
milestone: M5
priority: P2
---

# CSV/JSON 내보내기

## 사용자 스토리 (User Story)

> **As a** 오너/PO,
> **I want** 지금 보고 있는 백로그를 CSV나 JSON으로 내려받기를,
> **so that** 스프레드시트로 보고 자료를 만들거나 외부 도구에 넘길 때 파일을 하나씩 열어 옮겨 적지 않는다.

## 인수 조건 (Acceptance Criteria)

- [ ] Given 백로그 화면에서 필터·검색이 적용된 상태, When [내보내기] → CSV 또는 JSON을 선택하면, Then **현재 결과 집합**이 해당 형식 파일로 내려받아진다. *(§8, R4)*
- [ ] Given 내보낸 JSON의 이슈 1건, When `.localjira/issues/LJ/LJ-12.md`의 frontmatter와 대조하면, Then `uid`·`key`·`former_keys`·`type`·`title`·`status`·`parent`·`sprint`·`assignee`·`points`·`labels`·`links`·`acceptance`·`created_at`·`updated_at`·`created_by_kind` 값이 **도메인 데이터와 일치**한다. *(§5.1, §5.3)*
- [ ] Given 내보낸 결과, When 내용을 확인하면, Then 인덱스에만 존재하는 파생 값(검색 score, 인덱싱 시각, tombstone 메타)은 **포함되지 않는다** — 내보내기 기준은 인덱스가 아니라 도메인 데이터다.
- [ ] Given `.local/index.sqlite`를 삭제하고 재기동해 인덱스를 재생성한 뒤, When 같은 조건으로 다시 내보내면, Then 결과가 정규화 비교로 **동일**하다. *(AC2 성질, G4)*
- [ ] Given `INVALID`로 격리된 이슈 1건이 있는 프로젝트, When 내보내면, Then 그 이슈는 **기본 결과에서 제외**되고, 결과 요약에 제외 건수와 해당 파일 경로가 표시된다. *(§5.6)*
- [ ] Given 위 상황에서 "격리 항목 포함" 옵션을 켬, When 내보내면, Then 격리 항목이 **격리 상태 표시와 함께**(예: `quarantined: true`) 포함되어 정상 항목과 섞이지 않는다. *(§5.6)*
- [ ] Given 내보낸 파일, When 시각 값을 보면, Then 모두 **RFC 3339** 문자열이다(저장 형식 그대로, 사람이 읽는 형식으로 재가공하지 않는다). *(§5.2)*
- [ ] Given 내보낸 파일, When `claim`·lease 정보를 찾으면, Then 포함되어 있지 않다 — claim/lease는 파일 SoT가 아닌 런타임 상태다. *(§5.4)*
- [ ] Given 내보낸 파일, When 민감 정보를 찾으면, Then 비밀번호 해시·PAT·LLM 키가 포함되지 않으며 `.local/credentials.sqlite`를 읽지 않는다. *(N6)*
- [ ] Given 내보내기 실행, When `.localjira/`와 `git -C .localjira status`를 확인하면, Then 도메인 파일이 하나도 변경되지 않고 미커밋 배지 건수도 그대로다 — 내보내기는 읽기 전용이며 서비스는 커밋하지 않는다. *(D4, AC24)*
- [ ] Given 네트워크가 없는 환경, When 내보내기를 실행하면, Then 정상 동작한다. *(N4)*
- [ ] Given 결과가 0건인 필터, When 내보내면, Then 헤더만 있는 빈 CSV / 빈 배열 JSON이 생성되고 오류가 아니다.

> ⚠ 미정: **내보내기 대상 엔티티 범위** — 이슈 외에 스프린트·코멘트·AgentRun·이벤트도 포함할지. §7 R24는 "CSV/JSON 내보내기"라고만 한다.
> ⚠ 미정: **CSV의 중첩 필드 직렬화** — `links[]`·`acceptance[]`·`labels[]`·`former_keys[]`를 어떻게 평면화할지(구분자 결합 vs JSON 문자열 vs 컬럼 분해)와 고정 컬럼 집합.
> ⚠ 미정: CSV **인코딩·구분자** — UTF-8 BOM 포함 여부, 쉼표 vs 탭(엑셀 호환 고려).
> ⚠ 미정: **대용량 성능 기준** — 5,000건 내보내기의 소요 시간 목표와 스트리밍 여부. §9 N1은 렌더·검색만 규정한다.
> ⚠ 미정: **결과 파일의 저장 경로** — 브라우저 다운로드인지 서버가 지정 경로에 쓰는지. 서버가 쓴다면 `.localjira/` 아래는 도메인 데이터를 오염시키므로 제외해야 한다.
> ⚠ 미정: 격리 항목의 **기본 정책** — §7 R24는 "제외하거나 표시"만 요구하고 어느 쪽이 기본인지 정하지 않는다(본 스토리는 "기본 제외 + 옵션 포함"으로 가정).
> ⚠ 미정: 내보내기에 필요한 **역할·scope**와 감사 기록 여부 — §9 N7이 조회를 감사 범위에서 제외하므로, 내보내기를 단순 조회로 볼지 별도 감사 대상 행위로 볼지 판단이 필요하다.
> ⚠ 미정: 내보내기 시작점 — 백로그 화면 툴바 전용인지 보드·스프린트·설정 화면에서도 가능한지.

## 범위 밖 (Out of Scope)

- **임포트(가져오기)** — Jira 임포트는 양방향·단방향 CSV 모두 비목표로 확정(D6). 단 "실제로 가져와야 할 티켓이 있으면 CSV 단방향 임포트를 M5 옵션으로 되살린다"는 단서가 D6에 있으므로, 필요해지면 별도 요구사항으로 추가한다.
- 키보드 단축키·커맨드 팔레트 → `r24a-keyboard-shortcuts-command-palette.md`
- 필터·검색 엔진 자체 → R4
- 번다운·완료율 등 집계 리포트 → R20
- 백업·복원 — D5에 따라 백업은 "커밋·푸시된 도메인 데이터"이고 내보내기는 백업 수단이 아니다
- 격리 판정 로직·오류 배너 → R11

## 선행 의존 (Depends on)

- `r04a-issue-filter.md`
- `r11a-integrity-validation-quarantine.md`
- `r01a-issue-create-read.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.1(엔티티 필드) · §5.2(RFC 3339) · §5.4(claim은 런타임 상태) · §5.6(격리·INVALID) · §7 R24 · §8(백로그 화면) · §12 M5 · §13 D4·D5·D6
- NFR: N4(오프라인), N6(자격증명 보호), N7(감사 범위)
- 검증: PRD §7 R24의 검증 열은 비어 있다(전용 AC 없음). 보조 근거 AC2(인덱스 재생성 후 동일성), AC10(격리 공존), AC24(서비스가 커밋하지 않음)
