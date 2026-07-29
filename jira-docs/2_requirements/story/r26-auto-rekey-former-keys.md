---
title: "표시 키 자동 재키잉과 former_keys alias 조회"
status: done
owner: 이성훈
created: 2026-07-27
updated: 2026-07-27
related_prd: ../prd/backlog-sprint.md
requirement: R26
milestone: M1
priority: P0
---

# 표시 키 자동 재키잉과 former_keys alias 조회

## 사용자 스토리 (User Story)

> **As a** 팀원,
> **I want** 두 사람이 오프라인에서 각각 만든 이슈가 같은 `LJ-13`이 되어 머지되더라도 시스템이 알아서 한쪽에 새 키를 주고 옛 키로도 계속 찾아지기를,
> **so that** 상시 공유 서버 없이 git으로만 동기화해도(D2) 키 충돌을 사람이 손으로 수습할 일이 없고, 이미 공유한 키가 죽지 않는다.

## 인수 조건 (Acceptance Criteria)

- [x] Given 두 클론이 오프라인에서 각각 `LJ-13`을 생성(uid_A가 먼저 생성, uid_B가 나중 생성)하고 머지, When 조정이 돌면, Then **uid 생성 시각이 나중인 uid_B**가 새 키(`LJ-14`)를 받고 uid_A는 `LJ-13`을 유지한다. *(AC25, D3)*
- [x] Given 위 재키잉, When 새 키 계산 근거를 확인하면, Then **머지된 전체 파일 집합**으로부터 결정적으로 계산된다 — 해당 프로젝트의 최대 키 번호 + 충돌 항목의 uid 정렬 순번. 무작위·시퀀스 카운터를 쓰지 않는다. *(ADR-006 D3)*
- [x] Given 동일한 머지 결과 파일 집합, When 서로 다른 두 인스턴스가 각자 조정을 수행하면, Then 재키잉 결과(어느 uid가 어떤 키를 갖는지)가 **완전히 동일**하다 — 중앙 조정자 없이 수렴한다.
- [x] Given 재키잉이 수행됨, When 파일을 보면, Then 대상 이슈 파일의 `key`가 새 키로 바뀌고 이전 키가 `former_keys[]`에 append되며, **변경된 파일은 재키잉 대상 1건뿐**이다.
- [x] Given 재키잉이 수행됨, When 대상 이슈의 `uid`를 확인하면, Then **바뀌지 않는다**. `parent`·`links[].to`·이벤트의 target 참조는 uid 기반이므로 어떤 파일도 함께 재작성되지 않는다.
- [x] Given 재키잉 후, When `GET /issues/LJ-13`을 호출하면, Then **원 소유자 uid_A**가 반환된다(alias보다 현재 키가 우선). `GET /issues/LJ-14`는 uid_B를 반환한다. *(AC25)*
- [x] Given 어떤 이슈도 `LJ-13`을 현재 키로 갖지 않고 uid_B의 `former_keys`에만 있는 경우, When `GET /issues/LJ-13`을 호출하면, Then **200**으로 uid_B가 반환되고 응답에 현재 키(`LJ-14`)와 매칭된 옛 키가 함께 표시된다.
- [ ] Given 재키잉 후, When 검색창에 `LJ-13`을 입력하면, Then uid_A(현재 키)와 uid_B(옛 키 보유) **양쪽이 구분되어** 결과에 나온다. *(AC25)*  
      **→ 이월: r04b(Wave 1 다음) — 전문 검색 자체가 아직 없다. alias 조회 계약은 구현했다**
- [ ] Given 본문·코멘트에 `LJ-13` 텍스트 참조가 있음, When 링크로 해석하면, Then 원 소유자 우선 규칙으로 uid_A를 가리키고, 링크 UI에 그 사실이 드러난다.  
      **→ 이월: r23(M5) — 본문 텍스트의 키 참조를 링크로 해석하는 기능이 R23. 설계 §3.8이 '다중 매치 시 연결하지 않고 후보만 기록'으로 이미 규정**
- [x] Given 재키잉이 수행됨, When 이벤트를 보면, Then `actor_kind=system`, verb=재키잉, before/after 키, 사유(`duplicate_key`), 대상 uid가 기록된다. *(AC25)*
- [x] Given 재키잉 이력이 있음, When `/settings`를 열면, Then 재키잉 목록(시각·대상 uid·이전 키·새 키·사유)을 볼 수 있다. *(§8)*
- [x] Given 같은 표시 키를 가진 이슈가 **3건 이상**, When 조정하면, Then uid 생성 시각이 가장 이른 1건이 키를 유지하고 나머지가 uid 정렬 순번대로 서로 다른 새 키를 받는다(같은 새 키가 두 번 발급되지 않는다).
- [ ] Given 재키잉으로 파일이 수정됨, When `git -C .localjira status`를 보면, Then 변경 파일이 잡히고 미커밋 배지(R25) 건수가 증가한다 — **서비스는 커밋·푸시하지 않는다**. *(D4)*  
      **→ 이월: r25(Wave 4) — 배지가 아직 없다. 파일이 수정되고 커밋·푸시하지 않는 것은 확인했다**
- [x] Given 서로 다른 두 파일이 같은 `uid`를 가짐, When 조정하면, Then 재키잉 대상이 아니라 **양쪽 격리**로 처리된다. *(R11, D3)*
- [x] Given 재키잉 도중 프로세스가 죽음, When 재기동해 조정을 다시 수행하면, Then 계산이 결정적이므로 동일한 결과에 도달하고 키가 두 번 밀리지 않는다(멱등).

> ✅ 이미 결정돼 있었다 — 설계 §3.8 「alias 조회 계약」 표: 현재 키 소유자가 있으면 **그 이슈만**
> 반환하고, 소유자 없이 alias가 1건이면 그 이슈와 `moved_to` 힌트를, **2건 이상이면 임의로
> 고르지 않고 후보 배열과 함께 409**로 답한다. 단일 리소스 조회의 의미를 흐리지 않기 위해서다.

## 범위 밖 (Out of Scope)

- 중복 `uid`의 해결 → R11 (자동 해결하지 않고 격리)
- 표시 키의 최초 발급 규칙 → R1/R8 서버 발급 경로
- 사람이 키를 수동으로 바꾸는 기능 — 재키잉은 자동·결정적이며 수동 경로를 두지 않는다(D3)
- 머지 충돌 자체의 해소 → git 도구의 몫(D2)
- 미커밋 변경 배지 → R25

## 선행 의존 (Depends on)

- `r08c-bulk-reconcile-tombstone.md`
- `r11a-integrity-validation-quarantine.md`

## 참고 (References)

- PRD `../prd/backlog-sprint.md` §5.4(식별자 발급) · §5.6(중복 표시 키) · §13 D3·D4 · §8(설정 화면 재키잉 이력)
- ADR `../../0_decisions/adr-006-shared-board-data-branch.md` §D3
- 검증: PRD AC25
